import type { AppSettings, BackgroundPolicy, EnvironmentInfo, JsonObject, LocalCandidate, LogEntry, ProcessStatus, ServiceProfile, SetupDiskPreflight, SetupHandoff, StartupStatus, StreamEvent, SupervisorStatus, TaskStatus } from './types';
import { normalizeError, StrataError } from './errors';
import { decodeChatChunk, SSEParser, type ChatDelta, type StreamToolEvent } from './chat';
import type { OfficialSetupOptions, ModelInspectRequest } from './official-setup';
import type { ChatRuntimeEvidence } from './chat';
import { validateResourceAssessmentRequest, resourceRequestFromConfiguration, type ResourceAssessmentRequest, type SetupResourceAssessment } from './resource-assessment';
import type { ServiceSharingStatus, SetServiceAuthRequest, ServiceAuthResult } from './service-sharing';
import type { BenchmarkIdentity } from './benchmark-comparison';
import type { RuntimeReleaseAsset, RuntimeZipDownloadOptions, RuntimeZipDownloadCheckResult } from './runtime-types';
import type { SystemLanguage } from './languages';
import { arenaLaunchParams, assertArenaPayloadSafe, type ArenaPayload, type ArenaStatus } from './arena';

export interface LocalModel { name: string; configPath: string; modelPath: string; sizeBytes: number | null }

export type ServerBootstrap = {
  apiBase: string;
  version: string;
  features?: { pathPicker?: boolean; updater?: boolean; tray?: boolean; floatingMonitor?: boolean };
};

declare global {
  interface Window {
    __STRATA_MANAGER_SERVER__?: ServerBootstrap;
  }
}

const SERVER_TOKEN_KEY = 'strata-manager-server-token';

/** True inside the Tauri desktop shell (window chrome, tray, native dialogs). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** True when the page was served by strata-manager-server (injected bootstrap). */
export function isServerMode(): boolean {
  return typeof window !== 'undefined' && !!window.__STRATA_MANAGER_SERVER__;
}

/**
 * True when a native Manager backend is available (Tauri IPC or headless server RPC).
 * Historical name used across the UI for "full app" capabilities.
 */
export function isDesktop(): boolean {
  return isTauri() || isServerMode();
}

export function serverBootstrap(): ServerBootstrap | undefined {
  return typeof window !== 'undefined' ? window.__STRATA_MANAGER_SERVER__ : undefined;
}

export function getServerToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('token');
    if (fromQuery && fromQuery.length >= 16) {
      sessionStorage.setItem(SERVER_TOKEN_KEY, fromQuery);
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
      return fromQuery;
    }
    return sessionStorage.getItem(SERVER_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setServerToken(token: string): void {
  sessionStorage.setItem(SERVER_TOKEN_KEY, token.trim());
}

export function clearServerToken(): void {
  sessionStorage.removeItem(SERVER_TOKEN_KEY);
}

/** Read only: never starts a runtime or changes the system language. */
export async function getSystemLanguage(): Promise<SystemLanguage> {
  if (isDesktop()) return native<SystemLanguage>('get_system_language');
  return { locales: typeof navigator === 'undefined' ? [] : [...navigator.languages] };
}

async function serverRpc<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const boot = serverBootstrap();
  if (!boot) throw new StrataError('DESKTOP_REQUIRED', '此操作需要 Strata Manager 桌面应用或无头服务');
  const token = getServerToken();
  if (!token) throw new StrataError('AUTH_REQUIRED', '请先填写无头服务的访问令牌');
  let response: Response;
  try {
    response = await fetch(`${boot.apiBase}/rpc`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ method: command, params: args ?? {} }),
    });
  } catch (error) {
    throw normalizeError(error);
  }
  let payload: { ok?: boolean; result?: T; error?: { message?: string } };
  try {
    payload = await response.json();
  } catch {
    throw new StrataError('INVALID_RESPONSE', `HTTP ${response.status}`, response.status);
  }
  if (!response.ok || payload.ok === false) {
    throw normalizeError(payload.error?.message ?? `HTTP ${response.status}`, response.status);
  }
  return payload.result as T;
}

async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<T>(command, args);
    } catch (error) { throw normalizeError(error); }
  }
  if (isServerMode()) return serverRpc<T>(command, args);
  throw new StrataError('DESKTOP_REQUIRED', '此操作需要 Strata Manager 桌面应用');
}

let dbPromise: Promise<IDBDatabase> | undefined;
function appDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new StrataError('STORAGE_UNAVAILABLE', '当前浏览器不可使用 IndexedDB'));
  if (!dbPromise) dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('strata-manager', 1);
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains('app-state')) open.result.createObjectStore('app-state'); };
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => { db.close(); dbPromise = undefined; };
      resolve(db);
    };
    open.onerror = () => { dbPromise = undefined; reject(new StrataError('STORAGE_ERROR', open.error?.message ?? '无法打开应用存储')); };
    open.onblocked = () => { dbPromise = undefined; reject(new StrataError('STORAGE_BLOCKED', '应用存储升级被其它窗口阻止')); };
  });
  return dbPromise;
}

export async function loadStore<T>(key: string, fallback: T): Promise<T> {
  if (isDesktop()) { const value = await native<T | null>('store_get', { key }); return value ?? fallback; }
  const db = await appDB();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction('app-state', 'readonly');
    const read = tx.objectStore('app-state').get(key);
    tx.oncomplete = () => resolve(read.result === undefined ? fallback : read.result as T);
    tx.onerror = () => reject(new StrataError('STORAGE_ERROR', tx.error?.message ?? '无法读取应用存储'));
    tx.onabort = () => reject(new StrataError('STORAGE_ERROR', tx.error?.message ?? '应用存储读取中断'));
  });
}
export async function saveStore(key: string, value: unknown): Promise<void> {
  if (isDesktop()) return native<void>('store_set', { key, value });
  const db = await appDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('app-state', 'readwrite');
    tx.objectStore('app-state').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new StrataError('STORAGE_ERROR', tx.error?.message ?? '无法保存应用存储'));
    tx.onabort = () => reject(new StrataError('STORAGE_ERROR', tx.error?.message ?? '应用存储保存中断'));
  });
}

// Preview keys exist only in this JS session, never in IndexedDB/localStorage or URLs.
const sessionKeys = new Map<string, string>();
export async function setApiKey(profileId: string, apiKey: string): Promise<void> {
  if (isDesktop()) return native<void>('set_api_key', { profileId, apiKey });
  if (apiKey.trim()) sessionKeys.set(profileId, apiKey.trim()); else sessionKeys.delete(profileId);
}
export async function hasApiKey(profileId: string): Promise<boolean> {
  return isDesktop() ? native<boolean>('has_api_key', { profileId }) : sessionKeys.has(profileId);
}

function validatePath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('#') || path.includes('\\')) throw new StrataError('INVALID_API_PATH', '仅支持 Strata 相对 API 路径');
  let decoded: string;
  try { decoded = decodeURIComponent(path.split('?')[0] ?? ''); } catch { throw new StrataError('INVALID_API_PATH', 'API 路径编码无效'); }
  if (decoded.startsWith('//') || decoded.includes('\\') || decoded.split('/').some(x => x === '..' || x === '.')) throw new StrataError('INVALID_API_PATH', 'API 路径不可包含跳转');
}

/** Strata APIs are at the service root; tolerate copied OpenAI /v1 endpoints without duplicating it. */
export function normalizeBaseUrl(baseUrl: string): string {
  let base: URL;
  try { base = new URL(baseUrl.trim()); } catch { throw new StrataError('INVALID_BASE_URL', '服务地址无效'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new StrataError('INVALID_BASE_URL', '服务地址需为无内嵌凭据的 HTTP(S) URL');
  if (!['/', '/v1', '/v1/'].includes(base.pathname)) throw new StrataError('INVALID_BASE_URL', '服务地址需为根地址或 /v1 API 地址');
  const octets = base.hostname.split('.').map(Number);
  const localIPv4 = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (octets[0] === 127 || octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254));
  const localIPv6 = /^\[(?:f[cd][0-9a-f]{0,2}|fe[89ab][0-9a-f]):/i.test(base.hostname);
  // Native IO verifies that non-loopback literals belong to this computer.
  // The browser preview's proxy remains limited to loopback below.
  if (base.protocol !== 'http:' || !(localIPv4 || localIPv6 || ['localhost', '[::1]'].includes(base.hostname))) throw new StrataError('LOCAL_SERVICE_ONLY', 'Strata Manager 仅管理本机 Strata 服务');
  return base.origin;
}

function normalizedProfile(profile: ServiceProfile): ServiceProfile {
  return { ...profile, baseUrl: normalizeBaseUrl(profile.baseUrl) };
}

function proxyURL(profile: ServiceProfile, path: string): string {
  validatePath(path);
  const baseUrl = normalizeBaseUrl(profile.baseUrl);
  const host = new URL(baseUrl).hostname;
  if (!(host === 'localhost' || host === '[::1]' || host === '127.0.0.1')) throw new StrataError('LOCAL_SERVICE_ONLY', 'Strata Manager 仅管理本机 Strata 服务');
  return `/__strata_proxy?baseUrl=${encodeURIComponent(baseUrl)}&path=${encodeURIComponent(path)}`;
}

async function browserFetch(profile: ServiceProfile, path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Strata-Client': 'strata-manager.desktop' };
  const apiKey = sessionKeys.get(profile.id);
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(proxyURL(profile, path), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal });
  } catch (error) { throw normalizeError(error); }
}

async function responseJSON(response: Response): Promise<unknown> {
  const text = await response.text();
  let value: unknown;
  try { value = text ? JSON.parse(text) : null; } catch {
    if (!response.ok) throw normalizeError(text || `HTTP ${response.status}`, response.status);
    throw new StrataError('INVALID_RESPONSE', '服务返回了非 JSON 响应', response.status);
  }
  if (!response.ok) throw normalizeError(value ?? `HTTP ${response.status}`, response.status);
  return value;
}
export async function request<T = JsonObject>(profile: ServiceProfile, path: string, method = 'GET', body?: unknown): Promise<T> {
  validatePath(path);
  if (isDesktop()) return native<T>('strata_request', { profile: normalizedProfile(profile), path, method, ...(body !== undefined ? { body } : {}) });
  return await responseJSON(await browserFetch(profile, path, method, body)) as T;
}

export interface RequestCaptureStatus { state: 'disabled' | 'temporary' | 'external' | 'unavailable'; expiresAtMs: number | null; reason: string | null }
export const requestCaptureStatus = (profileId: string): Promise<RequestCaptureStatus> => native('request_capture_status', { profileId });
export const setRequestCapture = (profileId: string, minutes: 0 | 5 | 15 | 30): Promise<RequestCaptureStatus> => native('request_capture_set', { profileId, minutes });

export async function streamChat(profile: ServiceProfile, body: JsonObject, onDelta: (delta: ChatDelta) => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new StrataError('CANCELLED', '请求已取消');
  let completed = false, contentLength = 0;
  const tools = new Map<string, StreamToolEvent>();
  const parser = new SSEParser(data => {
    if (completed) return;
    for (const delta of decodeChatChunk(data)) {
      if (delta.tool?.id) {
        const previous = tools.get(delta.tool.id);
        // Result events omit name/round, so merge with the call without overwriting those fields.
        const tool = { ...previous, ...delta.tool, name: delta.tool.name === 'MCP' && previous ? previous.name : delta.tool.name, at: previous?.at ?? contentLength };
        tools.set(delta.tool.id, tool);
        delta.tool = tool;
      }
      contentLength += delta.content?.length ?? 0;
      if (delta.done) completed = true;
      onDelta(delta);
    }
  });
  if (isDesktop()) {
    const { Channel } = await import('@tauri-apps/api/core');
    const requestId = crypto.randomUUID();
    const channel = new Channel<StreamEvent>();
    let streamError: unknown;
    const cancel = () => { void native<void>('cancel_stream', { requestId }).catch(error => { streamError ??= error; }); };
    channel.onmessage = event => {
      if (streamError || signal?.aborted) return;
      try {
        if (event.kind === 'data') parser.push(event.data ?? '');
        else if (event.kind === 'error') { streamError = normalizeError(event.data ?? '服务流失败'); cancel(); }
        else if (event.kind === 'done') parser.finish();
      } catch (error) { streamError = error; cancel(); }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) throw new StrataError('CANCELLED', '请求已取消');
      await native<void>('strata_stream', { profile: normalizedProfile(profile), path: '/v1/chat/completions', body, requestId, onEvent: channel });
      if (signal?.aborted) throw new StrataError('CANCELLED', '请求已取消');
      if (streamError) throw streamError;
      parser.finish();
    } finally { signal?.removeEventListener('abort', cancel); }
  } else if (isServerMode()) {
    if (signal?.aborted) throw new StrataError('CANCELLED', '请求已取消');
    const completion = await native<JsonObject>('strata_request', {
      profile: normalizedProfile(profile),
      path: '/v1/chat/completions',
      method: 'POST',
      body: { ...body, stream: false },
    });
    const choice = Array.isArray((completion as { choices?: unknown }).choices)
      ? (completion as { choices: Array<{ message?: { content?: string; reasoning_content?: string } }> }).choices[0]
      : undefined;
    const content = choice?.message?.content ?? '';
    const reasoning = choice?.message?.reasoning_content ?? '';
    if (reasoning) onDelta({ reasoning });
    if (content) onDelta({ content });
    onDelta({ done: true });
    completed = true;
  } else {
    const response = await browserFetch(profile, '/v1/chat/completions', 'POST', body, signal);
    if (!response.ok) await responseJSON(response);
    if (!response.body) throw new StrataError('STREAM_UNAVAILABLE', '服务没有返回可读取的数据流');
    if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new StrataError('INVALID_RESPONSE', '服务未返回 SSE 数据流');
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        parser.push(next.value);
        if (completed) { await reader.cancel(); break; }
      }
      parser.finish();
    } catch (error) { await reader.cancel().catch(() => {}); throw normalizeError(error); }
    finally { reader.releaseLock(); }
  }
  if (signal?.aborted) throw new StrataError('CANCELLED', '请求已取消');
  if (!completed) throw new StrataError('STREAM_INCOMPLETE', '服务数据流中断，未收到完成标记');
}

export const startService = (profile: ServiceProfile): Promise<ProcessStatus> => native('start_service', { profile });
export const stopService = (profileId: string): Promise<ProcessStatus> => native('stop_service', { profileId });
export const serviceStatus = (profileId: string, profile?: ServiceProfile): Promise<ProcessStatus> => native('service_status', { profileId, ...(profile ? { profile } : {}) });
export const restartService = (profile: ServiceProfile): Promise<ProcessStatus> => native('restart_service', { profile });
export const takeOverService = (profile: ServiceProfile): Promise<ProcessStatus> => native('take_over_service', { profile });
export const readLogs = (profile: ServiceProfile, limit = 200): Promise<LogEntry[]> => native('read_logs', { profile, limit });
export const environmentInfo = (): Promise<EnvironmentInfo> => native('environment_info');
export const managedPythonStatus = (): Promise<import('./managed-python').ManagedPythonStatus> => native('managed_python_status');
/** `source` is an optional HTTPS proxy template with `{url}`; the archive digest is fixed in the backend. */
export const installManagedPython = (source?: string): Promise<TaskStatus> => native('install_managed_python', source ? { source } : {});
/** `localModel` (#75 「使用已有模型」): the chosen `--gguf-dir` and optional MTP folder, checked before the estimate. */
export const setupDiskPreflight = (profile: ServiceProfile, model: string, quant: string, images: boolean, localModel?: import('./local-model').LocalModelRequest): Promise<SetupDiskPreflight> => native('setup_disk_preflight', { profile, model, quant, images, ...(localModel ? { localModel } : {}) });
export const runSetup = (profile: ServiceProfile, model: string, quant: string, context: number, images: boolean, options?: OfficialSetupOptions, localModel?: import('./local-model').LocalModelRequest): Promise<TaskStatus> => native('run_setup', { profile, model, quant, context, images, ...(options ? { options } : {}), ...(localModel ? { localModel } : {}) });
/** 「使用已有模型」: read-only scan of a GGUF file or folder, grouped by model and quantization. */
export const scanLocalModels = (path: string): Promise<import('./local-model').LocalModelScan> => native('scan_local_models', { path });
/** 「使用已有模型」: read-only check of an existing MTP draft layer (`<x>`, `<x>/rt` or `<x>/mtp/rt`). */
export const checkMtpPath = (path: string): Promise<import('./local-model').MtpCheck> => native('check_mtp_path', { path });
/** ORCA.md's OrcaRouter IQ3_XXS import: read-only plan, then one tracked setup task that registers its config. */
export const orcaImportPlan = (profile: ServiceProfile, request: import('./orca-import').OrcaImportRequest): Promise<import('./orca-import').OrcaImportPlan> => native('orca_import_plan', { profile, request });
export const runOrcaImport = (profile: ServiceProfile, request: import('./orca-import').OrcaImportRequest, options?: OfficialSetupOptions): Promise<TaskStatus> => native('run_orca_import', { profile, request, ...(options ? { options } : {}) });
export const inspectModel = (request: ModelInspectRequest): Promise<TaskStatus> => native('inspect_gguf', { request });
export const getChatRuntimeEvidence = (profileId: string): Promise<ChatRuntimeEvidence> => native('chat_runtime_evidence', { profileId });
export const installRuntime = (directory: string): Promise<TaskStatus> => native('install_runtime', { directory });
/** Prepare the application-owned official source and private Python environment, without models. */
/** Without archives everything is downloaded; chosen local archives replace only their download. */
export const prepareLocalRuntime = (localArchives?: import('./installation-types').LocalRuntimeArchives): Promise<TaskStatus> => native('prepare_local_runtime', localArchives && (localArchives.strataArchivePath || localArchives.engineArchivePath) ? { localArchives } : {});
/** `probePath`: also report free space where a folder being chosen would go (nothing is created). */
export const storageLocations = (installDir?: string, probePath?: string): Promise<import('./storage-location').StorageLocations> => native('storage_locations', { ...(installDir ? { installDir } : {}), ...(probePath ? { probePath } : {}) });
/** `null` returns new engine installs to the app data folder. */
export const setEngineInstallRoot = (directory: string | null): Promise<import('./storage-location').StorageLocation> => native('set_engine_install_root', { directory });
/** `moveFiles`: copy, verify, repoint run configurations and remove the old copies (a background task). */
export const setModelDataDirectory = (directory: string, moveFiles: boolean, installDir?: string): Promise<import('./storage-location').ModelDirectoryChange> => native('set_model_data_directory', { directory, moveFiles, ...(installDir ? { installDir } : {}) });
export const localRuntimeInstallation = (): Promise<import('./installation-types').RuntimeInstallationStatus> => native('local_runtime_installation');
/** Task logs use the existing read-only log source contract; no engine configuration is read. */
export const readTaskLogs = (taskId: string, limit = 200): Promise<LogEntry[]> => readLogs({ id: taskId, name: '', baseUrl: 'http://127.0.0.1:8000', installDir: '', pythonPath: '', configPath: '', managed: false }, limit);
export const updateRuntime = (profile: ServiceProfile): Promise<TaskStatus> => native('update_runtime', { profile });
export interface EngineHelp { flags: string[]; source: string }
export const engineHelpFlags = (profile: ServiceProfile): Promise<EngineHelp> => native('engine_help_flags', { profile });
export const runtimeUpdateInfo = (force = false): Promise<import('./runtime-types').RuntimeUpdateInfo> => native('runtime_update_info', { force });
/** Install the official matching Release ZIP and tag source, preserving models and configuration. */
/** Service interruption is authorized only by the explicit update confirmation dialog. */
export const updateRuntimeZip = (installDir: string, assetName?: string, stopCurrentService = false, download: RuntimeZipDownloadOptions = {}): Promise<TaskStatus> => native('update_runtime_zip', {
  installDir, ...(assetName ? { assetName } : {}), stopCurrentService,
  ...(download.localArchivePath?.trim() ? { localArchivePath: download.localArchivePath.trim() } : {}),
  ...(download.downloadUrl?.trim() ? { downloadUrl: download.downloadUrl.trim() } : {}),
  ...(download.targetVersion?.trim() ? { targetVersion: download.targetVersion.trim() } : {}),
});
/** Every published Strata release (cached for 6 h by the background service). */
export const runtimeReleaseVersions = (force = false): Promise<import('./runtime-versions').RuntimeReleaseVersions> => native('runtime_release_versions', { force });
/** One chosen release, verified like the latest one; read-only. */
export const runtimeReleaseInfo = (version: string): Promise<import('./runtime-types').RuntimeUpdateInfo> => native('runtime_release_info', { version });
/** Read-only ZIP integrity or bounded network/Range check; never creates an update task. */
export const testRuntimeZipDownload = (assetName: string, download: RuntimeZipDownloadOptions = {}): Promise<RuntimeZipDownloadCheckResult> => native('test_runtime_zip_download', {
  assetName,
  ...(download.localArchivePath?.trim() ? { localArchivePath: download.localArchivePath.trim() } : {}),
  ...(download.downloadUrl?.trim() ? { downloadUrl: download.downloadUrl.trim() } : {}),
});
/** Read-only package selection using the installed engine's CUDA/HIP metadata. */
export const resolveRuntimeZipAsset = (installDir: string, assetName?: string, targetVersion?: string): Promise<RuntimeReleaseAsset> => native('resolve_runtime_zip_asset', {
  installDir, ...(assetName ? { assetName } : {}), ...(targetVersion ? { targetVersion } : {}),
});
export const listTasks = (): Promise<TaskStatus[]> => native('list_tasks');
export const listSetupHandoffs = (): Promise<SetupHandoff[]> => native('list_setup_handoffs');
export const resolveSetupHandoff = (taskId: string, configPath?: string): Promise<SetupHandoff> => native('resolve_setup_handoff', { taskId, ...(configPath ? { configPath } : {}) });
export const cancelTask = (taskId: string): Promise<void> => native('cancel_task', { taskId });
export const readConfig = (profile: ServiceProfile): Promise<JsonObject> => native('read_config', { profile });
export interface ConfigSnapshot { config: JsonObject; revision: string }
export const readConfigSnapshot = (profile: ServiceProfile): Promise<ConfigSnapshot> => native('read_config_snapshot', { profile });
/** Read-only validation of required vision files using the service working directory. */
export const validateVisionFiles = (profile: ServiceProfile, config: JsonObject): Promise<void> => native('validate_vision_files', { profile, config });
export const writeConfig = (profile: ServiceProfile, config: JsonObject, expectedRevision: string): Promise<{ revision: string }> => native('write_config', { profile, config, expectedRevision });
/** Save the full editor draft as a new file; discovery and activation remain explicit. */
export const copyConfiguration = (profile: ServiceProfile, filename: string, config: JsonObject): Promise<ServiceProfile> => native('copy_configuration', { profile, filename, config });
/** Archive the actual configuration JSON after confirming all matching services are stopped. */
export const deleteConfiguration = (profile: ServiceProfile): Promise<{ archivedPath: string }> => native('delete_configuration', { profile });
export interface ConfigCleanupItem { profile: ServiceProfile; configPath: string; installDir: string; runtimeVersion?: string; modelName?: string; identical: boolean; identicalTo?: string }
export interface ConfigCleanupPlan { currentInstallDir: string; currentVersion?: string; items: ConfigCleanupItem[] }
/** Read-only: older-version run configurations that could be archived. Deletion stays per file via deleteConfiguration. */
export const planConfigCleanup = (currentInstallDir: string, directories?: string[]): Promise<ConfigCleanupPlan> => native('plan_config_cleanup', { currentInstallDir, directories });
/** Inspect only the primary GGUF bundle; configuration files and companions are retained. */
export const planModelDeletion = (profiles: ServiceProfile[]): Promise<import('./types').ModelDeletionPlan> => native('plan_model_deletion', { profiles });
/** Permanently remove the confirmed primary files after repeating reference, process and stat checks. */
export const deleteModelFiles = (profiles: ServiceProfile[], expectedFiles: import('./types').ModelDeletionFile[]): Promise<import('./types').ModelDeletionSummary> => native('delete_model_files', { profiles, expectedFiles });
export const listLocalModels = (profile: ServiceProfile): Promise<LocalModel[]> => native('list_local_models', { profile });
export const exportDiagnostics = (profile: ServiceProfile): Promise<string> => native('export_diagnostics', { profile });
export const repairPythonDependencies = (installDir: string): Promise<{ pythonPath: string; installed: string[]; alreadyPresent: string[]; message: string }> => native('repair_python_dependencies', { installDir });
export const supportDiagnosticsText = (input: { profile?: ServiceProfile; installDir?: string; pythonPath?: string; configPath?: string; reason?: string; runtimeVersion?: string; name?: string } = {}): Promise<string> => {
  const { profile, ...extras } = input;
  return native('support_diagnostics_text', { ...(profile ? { profile } : {}), extras });
};
export const assessSetupResources = (request: ResourceAssessmentRequest): Promise<SetupResourceAssessment> => native('assess_setup_resources', { request: validateResourceAssessmentRequest(request) });
export const serviceSharingStatus = (profile: ServiceProfile): Promise<ServiceSharingStatus> => native('service_sharing_status', { profile });
export const setServiceAuth = (profile: ServiceProfile, request: SetServiceAuthRequest): Promise<ServiceAuthResult> => native('set_service_auth', { profile, request });
export const benchmarkIdentity = async (profile: ServiceProfile): Promise<BenchmarkIdentity> => {
  const value = await native<BenchmarkIdentity & { resourceConfiguration?: JsonObject }>('benchmark_identity', { profile });
  const { resourceConfiguration, ...identity } = value;
  const recipe = resourceRequestFromConfiguration(resourceConfiguration,profile.id);
  const launch = arenaLaunchParams(resourceConfiguration);
  return { ...identity, ...(recipe ? { resourceRequest: recipe } : {}), ...(launch ? { launch } : {}) };
};
// Benchmark Arena. Uploads and API reads go through the native side (signing, queue, retry, CSP-safe network).
export const arenaStatus = (): Promise<ArenaStatus> => native('arena_status');
export const arenaConsent = (consentVersion: number, autoUpload: boolean): Promise<ArenaStatus> => native('arena_consent', { consentVersion, autoUpload });
export const arenaSetAutoUpload = (enabled: boolean): Promise<ArenaStatus> => native('arena_set_auto_upload', { enabled });
/** Queues a whitelisted payload; the native side refuses it without consent and auto-upload. */
export const arenaEnqueue = (payload: ArenaPayload): Promise<ArenaStatus> => { assertArenaPayloadSafe(payload); return native('arena_enqueue', { payload }); };
export const arenaFlush = (): Promise<ArenaStatus> => native('arena_flush');
export const arenaWithdraw = (): Promise<{ deleted: number }> => native('arena_withdraw');
export const arenaGet = <T>(path: 'groups' | 'leaderboard' | 'recommend', query: Record<string, string> = {}): Promise<T> => native('arena_get', { path, query });
export const applySettings = (settings: AppSettings): Promise<void> => native('apply_settings', { settings });
export const saveMarkdown = (path: string, content: string): Promise<string> => native('write_markdown_export', { path, content });
/** Save an already-previewed PNG to the path selected in the native Save As dialog. */
export const savePng = (path: string, bytes: number[]): Promise<string> => native('write_png_export', { path, bytes });
export const discoverLocal = (directories?: string[]): Promise<LocalCandidate[]> => native('discover_local', { ...(directories ? { directories } : {}) });
export const connectRunningService = (candidate: LocalCandidate): Promise<{ profileId: string; restarting: boolean }> => native('connect_running_service', { candidate });
export const importLocal = (candidate: LocalCandidate): Promise<ServiceProfile> => native('import_local', { candidate });
export const ensureLocalService = (profileId: string): Promise<ProcessStatus> => native('ensure_local_service', { profileId });
export const switchLocalService = (profileId: string): Promise<ProcessStatus> => native('switch_local_service', { profileId });
export const supervisorStatus = (): Promise<SupervisorStatus> => native('supervisor_status');
export const shutdownSupervisor = (): Promise<void> => native('shutdown_supervisor');
export const localInstallations = (): Promise<ServiceProfile[]> => native('local_installations');
export const localInstallationDetails = (): Promise<import('./types').LocalInstallationDetails[]> => native('local_installation_details');
export const renameLocalInstallation = (profileId: string, name: string): Promise<ServiceProfile> => native('rename_local_installation', { profileId, name });
export const removeLocalInstallation = (profileId: string): Promise<void> => native('remove_local_installation', { profileId });
export const startupStatus = (): Promise<StartupStatus> => native('get_startup_status');
export const setStartupEnabled = (enabled: boolean): Promise<StartupStatus> => native('set_startup_enabled', { enabled });
export const backgroundPolicy = (): Promise<BackgroundPolicy> => native('get_background_policy');
export const setBackgroundPolicy = (mode: BackgroundPolicy['mode'], autoRecover: boolean, idleUnloadMinutes = 15): Promise<BackgroundPolicy> => native('set_background_policy', { mode, autoRecover, idleUnloadMinutes });
export const prepareAppUpdate = (): Promise<void> => native('prepare_app_update');
export const restartInterface = (): Promise<void> => native('restart_interface');
export const supportsFullScenarioTuning = (status: SupervisorStatus | undefined): boolean =>
  Number.isSafeInteger(status?.capabilities?.fullScenarioTuning) && (status?.capabilities?.fullScenarioTuning ?? 0) >= 1;
export const tuningStart = async (profileId: string, request: import('./tuning-types').TuningStartRequest): Promise<import('./tuning-types').TuningJob> => {
  if (request.useCase && !supportsFullScenarioTuning(await supervisorStatus())) {
    throw new StrataError('SUPERVISOR_CAPABILITY_REQUIRED', '当前后台不支持完整场景实测。请完成当前请求并停止模型服务，让后台更新后重试。');
  }
  return native('tuning_start', { profileId, request });
};
export const tuningStatus = (profileId: string): Promise<import('./tuning-types').TuningJob | null> => native('tuning_status', { profileId });
export const tuningCancel = (jobId: string): Promise<void> => native('tuning_cancel', { jobId });
export const tuningApply = (jobId: string, candidateId: string): Promise<import('./tuning-types').TuningJob> => native('tuning_apply', { jobId, candidateId });
export const tuningRestore = (jobId: string): Promise<import('./tuning-types').TuningJob> => native('tuning_restore', { jobId });
export const supportsQuickCalibration = (status: SupervisorStatus | undefined): boolean =>
  Number.isSafeInteger(status?.capabilities?.quickCalibration) && (status?.capabilities?.quickCalibration ?? 0) >= 1;
export const supportsTuningLive = (status: SupervisorStatus | undefined): boolean =>
  Number.isSafeInteger(status?.capabilities?.tuningLive) && (status?.capabilities?.tuningLive ?? 0) >= 1;
/** Live progress of a running job; null when idle or on a supervisor without live support. */
export const tuningLive = (jobId: string): Promise<import('./tuning-types').TuningLiveSnapshot | null> => native('tuning_live', { jobId });
export const calibrateStart = async (profileId: string, request: import('./tuning-types').CalibrateRequest = {}): Promise<import('./tuning-types').CalibrationJob> => {
  if (!supportsQuickCalibration(await supervisorStatus())) {
    throw new StrataError('SUPERVISOR_CAPABILITY_REQUIRED', '当前后台不支持快速校准。请完成当前请求并停止模型服务，让后台更新后重试。');
  }
  return native('calibrate_start', { profileId, request });
};
export const calibrateStatus = (profileId: string): Promise<import('./tuning-types').CalibrationJob | null> => native('calibrate_status', { profileId });
export const calibrateCancel = (jobId: string): Promise<void> => native('calibrate_cancel', { jobId });
export const analyticsQuery = <T extends import('./analytics-types').ApiAnalyticsData = import('./analytics-types').ApiAnalyticsData>(query: import('./analytics-types').ApiAnalyticsQuery): Promise<import('./analytics-types').ApiAnalyticsResult<T>> => native('analytics_query', { query });
