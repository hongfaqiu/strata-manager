import { MODEL_CATALOG } from './catalog';
import { normalizeOfficialSetupOptions, type OfficialSetupOptions } from './official-setup';
import type { ServiceProfile } from './types';

export const MODEL_DOWNLOAD_DEFAULTS_KEY = 'modelDownloadDefaultsV1';

export interface ModelDownloadDefaults {
  schemaVersion: 1;
  options: OfficialSetupOptions;
  runtime: ServiceProfile | null;
}

export interface ModelDownloadSelection {
  model: string;
  quant: string;
  context: number;
  images: boolean;
}

export interface ModelDownloadRequest extends ModelDownloadSelection {
  profile: ServiceProfile;
  options: OfficialSetupOptions;
}

const controls = /[\u0000-\u001f\u007f-\u009f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeOptions(value: unknown): OfficialSetupOptions {
  if (!isRecord(value)) throw new Error('下载选项格式无效 / Invalid download options');
  for (const field of ['source', 'hfEndpoint', 'backend', 'gpus'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw new Error('下载选项字段无效 / Invalid download option field');
    }
  }
  return normalizeOfficialSetupOptions({
    source: value.source as OfficialSetupOptions['source'],
    hfEndpoint: value.hfEndpoint as string | undefined,
    backend: value.backend as OfficialSetupOptions['backend'],
    gpus: value.gpus as string | undefined,
  });
}

function snapshotRuntime(value: unknown): ServiceProfile {
  if (!isRecord(value) || value.managed !== true) {
    throw new Error('请选择受管理的本地运行环境 / Select a managed local runtime');
  }
  for (const field of ['id', 'name', 'baseUrl', 'installDir', 'pythonPath', 'configPath'] as const) {
    if (typeof value[field] !== 'string' || controls.test(value[field])) {
      throw new Error('运行环境字段无效 / Invalid runtime field');
    }
  }
  // Paths are validated by the native runtime before execution; keep the registered identity intact.
  const profile = value as unknown as ServiceProfile;
  if (!profile.id.trim() || !profile.name.trim() || !profile.installDir.trim() || profile.baseUrl.includes('\\')) {
    throw new Error('运行环境名称、标识或路径无效 / Invalid runtime identity or path');
  }
  let url: URL;
  try { url = new URL(profile.baseUrl); } catch {
    throw new Error('运行环境服务地址无效 / Invalid runtime service URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('运行环境服务地址不能包含凭据、查询参数或片段 / Runtime URL requires HTTP(S) without credentials, query or fragment');
  }
  return {
    id: profile.id, name: profile.name, baseUrl: profile.baseUrl,
    installDir: profile.installDir, pythonPath: profile.pythonPath, configPath: profile.configPath, managed: true,
  };
}

export function defaultModelDownloadDefaults(): ModelDownloadDefaults {
  return { schemaVersion: 1, options: normalizeOfficialSetupOptions(), runtime: null };
}

/** Only an absent value uses defaults; corrupt stored choices must remain visible as an error. */
export function normalizeModelDownloadDefaults(value: unknown): ModelDownloadDefaults {
  if (value === null || value === undefined) return defaultModelDownloadDefaults();
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('公共下载设置版本或格式无效 / Invalid model download defaults schema');
  }
  return {
    schemaVersion: 1,
    options: normalizeOptions(value.options),
    runtime: value.runtime === null ? null : snapshotRuntime(value.runtime),
  };
}

/** Capture validated values for one task; later defaults edits cannot change this request. */
export function snapshotModelDownloadRequest(
  profile: ServiceProfile,
  selection: ModelDownloadSelection,
  options: OfficialSetupOptions,
): ModelDownloadRequest {
  if (!isRecord(selection)) throw new Error('模型下载选择无效 / Invalid model download selection');
  const model = MODEL_CATALOG.find(entry => entry.family === selection.model);
  if (!model || typeof selection.quant !== 'string' || !model.quants.includes(selection.quant)) {
    throw new Error('请选择官方目录中的模型和量化版本 / Select a model and quant from the official catalog');
  }
  if (typeof selection.context !== 'number' || !Number.isInteger(selection.context)
    || selection.context < 512 || selection.context > 1048576) {
    throw new Error('上下文长度须为 512–1048576 的整数 / Context must be an integer from 512 to 1048576');
  }
  if (model.fixedContext && selection.context !== model.fixedContext) {
    throw new Error(`${model.name} 只支持 ${model.fixedContext} 上下文 / ${model.name} only supports a ${model.fixedContext} context`);
  }
  if (typeof selection.images !== 'boolean' || (selection.images && !model.images)) {
    throw new Error('所选模型不支持此图像选项 / Invalid image support option for the selected model');
  }
  return {
    profile: snapshotRuntime(profile),
    model: selection.model, quant: selection.quant, context: selection.context, images: selection.images,
    options: normalizeOptions(options),
  };
}

/** The host a failed setup says it could not reach ("cannot reach huggingface.co (…)"), or null. */
export function unreachableDownloadHost(message: string | undefined): string | null {
  const match = /cannot reach ([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/i.exec(message ?? '');
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * The options for retrying a download that could not reach Hugging Face (or its mirror) on
 * ModelScope, the domestic source. Null when the failure is not an unreachable host, or the retry
 * already used ModelScope, so the action is only offered where it can help.
 */
export function modelScopeRetryOptions(options: OfficialSetupOptions | undefined, message: string | undefined): OfficialSetupOptions | null {
  const host = unreachableDownloadHost(message);
  if (!host || host.includes('modelscope') || options?.source === 'modelscope') return null;
  const { hfEndpoint: _mirror, ...rest } = normalizeOfficialSetupOptions({ ...options, source: 'modelscope' });
  return rest;
}
