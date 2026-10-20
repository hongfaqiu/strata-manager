// Pure first-run guide logic: persisted progress, environment checks, step detection,
// recommendations and Arena matching. No React or native IO here so it stays testable.
import * as core from '@strata-manager/core';
import { fitState } from '../pages/d2Estimates';

export const ONBOARDING_KEY = 'onboardingV1';
export type GuidePath = 'install' | 'connect';
export type GuideStatus = 'active' | 'skipped' | 'completed';
export type Scene = 'chat' | 'long' | 'code';
export interface GuideSelection { family: string; quant: string; context: number; images: boolean }
export interface OnboardingProgress {
  schemaVersion: 1;
  status: GuideStatus;
  path: GuidePath | null;
  scene: Scene;
  selection?: GuideSelection;
  runtimeTaskId?: string;
  setupTaskId?: string;
  profileId?: string;
  environmentAccepted?: boolean;
  /** Default OFF: starting and loading after download needs an explicit opt-in. */
  autoStart: boolean;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown) => typeof value === 'string' && value.trim() && value.length < 512 ? value : undefined;

export function newProgress(now: number, path: GuidePath | null = null): OnboardingProgress {
  return { schemaVersion: 1, status: 'active', path, scene: 'chat', autoStart: false, startedAt: now, updatedAt: now };
}

/** Invalid or foreign values are discarded; the guide then falls back to detection. */
export function normalizeProgress(value: unknown): OnboardingProgress | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const status = value.status === 'skipped' || value.status === 'completed' ? value.status : value.status === 'active' ? 'active' : null;
  if (!status) return null;
  const path = value.path === 'install' || value.path === 'connect' ? value.path : null;
  const scene = value.scene === 'long' || value.scene === 'code' ? value.scene : 'chat';
  const startedAt = typeof value.startedAt === 'number' && Number.isFinite(value.startedAt) ? value.startedAt : 0;
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : startedAt;
  const progress: OnboardingProgress = { schemaVersion: 1, status, path, scene, autoStart: value.autoStart === true, startedAt, updatedAt };
  const selection = isRecord(value.selection) ? value.selection : undefined;
  if (selection) {
    const model = core.MODEL_CATALOG.find(entry => entry.family === selection.family);
    const quant = str(selection.quant);
    const context = Number(selection.context);
    if (model && quant && model.quants.includes(quant) && Number.isInteger(context) && context >= 512 && context <= 1048576) {
      progress.selection = { family: model.family, quant, context, images: selection.images === true && model.images };
    }
  }
  for (const key of ['runtimeTaskId', 'setupTaskId', 'profileId'] as const) { const item = str(value[key]); if (item) progress[key] = item; }
  if (value.environmentAccepted === true) progress.environmentAccepted = true;
  if (typeof value.completedAt === 'number' && Number.isFinite(value.completedAt)) progress.completedAt = value.completedAt;
  return progress;
}

/** Existing users (anything already configured) are never pushed into the guide. */
export function effectiveStatus(progress: OnboardingProgress | null, hasProfiles: boolean): GuideStatus {
  return progress?.status ?? (hasProfiles ? 'completed' : 'active');
}

// ---- Environment -------------------------------------------------------------------------
export interface ParsedGpu { name: string; driver?: string; vramGB?: number; nvidia: boolean }
/** `environmentInfo().gpus` entries look like "NVIDIA GeForce RTX 4090, 560.94, 24564 MiB". */
export function parseGpu(value: string): ParsedGpu {
  const parts = value.split(',').map(part => part.trim()).filter(Boolean);
  const name = parts[0] ?? value.trim();
  const memory = parts.find(part => /\d\s*(MiB|MB|GiB|GB)$/i.test(part));
  let vramGB: number | undefined;
  if (memory) {
    const amount = Number(memory.match(/[\d.]+/)?.[0]);
    if (Number.isFinite(amount) && amount > 0) vramGB = Math.round(/G/i.test(memory) ? amount : amount / 1024);
  }
  const driver = parts.slice(1).find(part => /^\d+(\.\d+)+$/.test(part));
  return { name, driver, vramGB, nvidia: /nvidia|geforce|rtx|quadro|tesla/i.test(name) };
}

export type CheckState = 'ok' | 'warn' | 'fail';
export interface EnvironmentCheck { id: 'system' | 'gpu' | 'memory' | 'python'; state: CheckState; value: string; detail?: string; params?: Record<string, number> }
const GB = 1024 ** 3;
export const smallestCatalogRamGB = () => Math.min(...core.MODEL_CATALOG.flatMap(model => Object.values(model.quantInfo).map(info => info.ramGB)));

/** Values are facts; `detail` carries a stable code the UI translates. */
export function environmentChecks(info: core.EnvironmentInfo): EnvironmentCheck[] {
  const windows = /windows/i.test(info.os);
  const arch64 = /x86_64|amd64|x64|aarch64|arm64/i.test(info.arch);
  const gpus = info.gpus.map(parseGpu);
  const apple = core.unifiedGpu(info);
  const memoryGB = info.totalMemory > 0 ? info.totalMemory / GB : 0;
  const minimum = smallestCatalogRamGB();
  const python = info.python?.match(/(\d+)\.(\d+)/);
  const pythonOk = !!python && (Number(python[1]) > 3 || Number(python[1]) === 3 && Number(python[2]) >= 10);
  return [
    { id: 'system', state: arch64 ? 'ok' : 'fail', value: `${info.os} · ${info.arch}`, detail: arch64 ? undefined : 'arch' },
    apple ? appleGpuCheck(apple)
    : gpus.length
      ? { id: 'gpu', state: gpus.some(gpu => gpu.nvidia) ? 'ok' : 'warn', value: gpus.map(gpu => gpu.vramGB ? `${gpu.name} · ${gpu.vramGB} GB` : gpu.name).join(' / '), detail: gpus.some(gpu => gpu.nvidia) ? (gpus.find(gpu => gpu.nvidia)?.driver ? `driver:${gpus.find(gpu => gpu.nvidia)!.driver}` : undefined) : 'nonNvidia' }
      : { id: 'gpu', state: 'warn', value: '', detail: 'noGpu' },
    { id: 'memory', state: !memoryGB ? 'warn' : memoryGB * .8 >= minimum ? 'ok' : 'warn', value: memoryGB ? `${Math.round(memoryGB)} GB` : '', detail: !memoryGB ? 'unknown' : memoryGB * .8 >= minimum ? undefined : 'low' },
    windows
      ? { id: 'python', state: 'ok', value: info.python ?? '', detail: info.python ? undefined : 'bundled' }
      : { id: 'python', state: pythonOk ? 'ok' : 'fail', value: info.python ?? '', detail: pythonOk ? (info.pythonManaged ? 'managed' : undefined) : 'required' },
  ];
}
/**
 * Apple Silicon: the GPU is on the chip and uses the unified memory pool. It runs Strata's Metal engine, so it is
 * not a "no GPU / non-NVIDIA" warning. Without a Metal family (e.g. a VM's paravirtual GPU) it stays a warning.
 */
function appleGpuCheck(gpu: core.GpuDetail): EnvironmentCheck {
  const gib = (bytes?: number) => bytes && bytes > 0 ? Math.round(bytes / GB) : 0;
  const params: Record<string, number> = {};
  if (gpu.cores) params.cores = gpu.cores;
  if (gib(gpu.memoryBytes)) params.total = gib(gpu.memoryBytes);
  if (gib(gpu.gpuBudgetBytes)) params.budget = gib(gpu.gpuBudgetBytes);
  return { id: 'gpu', state: gpu.metal ? 'ok' : 'warn', value: appleGpuValue(gpu), detail: gpu.metal ? 'appleUnified' : 'appleNoMetal', params };
}
/** "Apple M5 Pro · Metal 4": facts that need no translation. */
export function appleGpuValue(gpu: core.GpuDetail): string {
  return gpu.metal ? `${gpu.name} · Metal ${gpu.metal}` : gpu.name;
}
/** One GPU row value for the guide entry, Apple-aware; NVIDIA rows keep "<name> · <VRAM> GB". */
export function gpuRowValue(info: core.EnvironmentInfo | undefined): string | undefined {
  if (!info) return undefined;
  const apple = core.unifiedGpu(info);
  if (apple) return appleGpuValue(apple);
  const gpus = info.gpus.map(parseGpu);
  return gpus.length ? gpus.map(gpu => gpu.vramGB ? `${gpu.name} · ${gpu.vramGB} GB` : gpu.name).join(' / ') : undefined;
}
export function environmentVerdict(checks: EnvironmentCheck[] | undefined): 'loading' | 'pass' | 'warn' | 'fail' {
  if (!checks) return 'loading';
  return checks.some(check => check.state === 'fail') ? 'fail' : checks.some(check => check.state === 'warn') ? 'warn' : 'pass';
}

// ---- Step detection ----------------------------------------------------------------------
export type InstallStep = 'environment' | 'runtime' | 'model' | 'download' | 'start' | 'chat';
export type ConnectStep = 'discover' | 'load' | 'chat';
export type StepId = InstallStep | ConnectStep;
export type StepState = 'done' | 'skipped' | 'current' | 'running' | 'failed' | 'todo';
export const INSTALL_STEPS: InstallStep[] = ['environment', 'runtime', 'model', 'download', 'start', 'chat'];
export const CONNECT_STEPS: ConnectStep[] = ['discover', 'load', 'chat'];

export interface GuideFacts {
  environment: 'loading' | 'pass' | 'warn' | 'fail' | 'unavailable';
  runtime: 'unknown' | 'none' | 'running' | 'ready' | 'repair' | 'failed';
  /** The setup task this guide started (or the newest running setup task). */
  setup?: { state: core.TaskStatus['state'] };
  handoff?: core.SetupHandoff['status'];
  /** A usable local model configuration is registered (profile) or discovered on disk. */
  hasModel: boolean;
  /** A model service is selected for this guide (profile exists). */
  hasProfile: boolean;
  online: boolean;
  loaded: boolean;
  starting: boolean;
}
export interface StepView { id: StepId; state: StepState }
export interface GuidePlan { path: GuidePath; steps: StepView[]; current: StepId; index: number; total: number; doneCount: number }

const settled = (state: StepState) => state === 'done' || state === 'skipped';

export function deriveInstallSteps(facts: GuideFacts, progress: OnboardingProgress | null): StepView[] {
  const running = facts.online && facts.loaded;
  const modelReady = facts.hasModel || facts.hasProfile;
  const state = new Map<InstallStep, StepState>();
  // environment: auto-skipped when all checks pass, or when the work it guards is already done.
  if (facts.runtime === 'ready' || modelReady || running) state.set('environment', 'skipped');
  else if (facts.environment === 'pass') state.set('environment', 'skipped');
  else if (progress?.runtimeTaskId || facts.runtime === 'running') state.set('environment', 'done');
  else if (progress?.environmentAccepted && facts.environment !== 'fail') state.set('environment', 'done');
  else state.set('environment', facts.environment === 'fail' ? 'failed' : 'todo');
  // runtime: detected ready runtime counts even when it was installed outside the guide.
  if (facts.runtime === 'ready' || modelReady || running) state.set('runtime', progress?.runtimeTaskId ? 'done' : 'skipped');
  else state.set('runtime', facts.runtime === 'running' ? 'running' : facts.runtime === 'failed' ? 'failed' : 'todo');
  // model + download: an existing model skips both; a started setup task completes "model".
  if (modelReady && !facts.setup) { state.set('model', 'skipped'); state.set('download', 'skipped'); }
  else if (modelReady && facts.setup?.state !== 'running') { state.set('model', 'done'); state.set('download', 'done'); }
  else if (facts.setup) {
    state.set('model', 'done');
    const pendingHandoff = facts.handoff === 'pending' || facts.handoff === 'needs-choice';
    state.set('download', facts.setup.state === 'running' || facts.setup.state === 'completed' && (pendingHandoff || !facts.handoff) ? 'running' : facts.setup.state === 'completed' ? 'done' : 'failed');
  } else { state.set('model', 'todo'); state.set('download', 'todo'); }
  state.set('start', running ? 'done' : facts.starting || facts.online ? 'running' : 'todo');
  state.set('chat', progress?.status === 'completed' ? 'done' : 'todo');
  const steps = INSTALL_STEPS.map(id => ({ id, state: state.get(id)! }));
  return markCurrent(steps);
}

export function deriveConnectSteps(facts: GuideFacts, progress: OnboardingProgress | null): StepView[] {
  const steps: StepView[] = [
    { id: 'discover', state: facts.hasProfile && (facts.online || facts.starting) ? 'done' : 'todo' },
    { id: 'load', state: facts.online && facts.loaded ? 'done' : facts.starting || facts.online ? 'running' : 'todo' },
    { id: 'chat', state: progress?.status === 'completed' ? 'done' : 'todo' },
  ];
  return markCurrent(steps);
}

function markCurrent(steps: StepView[]): StepView[] {
  const index = steps.findIndex(step => !settled(step.state));
  return steps.map((step, position) => position === index && step.state === 'todo' ? { ...step, state: 'current' } : step);
}

export function guidePlan(path: GuidePath, facts: GuideFacts, progress: OnboardingProgress | null): GuidePlan {
  const steps = path === 'install' ? deriveInstallSteps(facts, progress) : deriveConnectSteps(facts, progress);
  const index = Math.max(0, steps.findIndex(step => !settled(step.state)));
  const allDone = steps.every(step => settled(step.state));
  const position = allDone ? steps.length - 1 : index;
  return { path, steps, current: steps[position]!.id, index: position, total: steps.length, doneCount: steps.filter(step => settled(step.state)).length };
}

/** A user with a model already somewhere is offered the shorter connect path first. */
export function suggestedPath(facts: Pick<GuideFacts, 'hasModel' | 'hasProfile'> & { runningServices: number }): GuidePath {
  return facts.runningServices > 0 || facts.hasProfile ? 'connect' : 'install';
}

// ---- Recommendations ---------------------------------------------------------------------
export interface Recommendation { family: core.CatalogModel['family']; name: string; quant: string; downloadGB: number; ramGB: number; fit?: 'fits' | 'tight' | 'over'; experimental: boolean; nvidiaOnly: boolean; recommended: boolean }
const fitRank = { fits: 0, tight: 1, over: 2, unknown: 1 } as const;
const sceneFamilies: Record<Scene, core.CatalogModel['family'][]> = { chat: ['swift', 'qwen', 'qwen36', 'unsloth', 'coder'], long: ['qwen', 'qwen36', 'swift', 'unsloth', 'coder'], code: ['coder', 'qwen', 'qwen36', 'swift', 'unsloth'] };

/**
 * Every catalog family+quant ranked for a scene: what fits memory first, then the scene's
 * family order, then the larger (higher quality) quant. Experimental or NVIDIA-only variants
 * on a machine without NVIDIA sink to the end. The first row is the recommendation.
 */
export function recommendations(scene: Scene, memoryGB: number | undefined, nvidia: boolean, limit = 5): Recommendation[] {
  const order = sceneFamilies[scene];
  const catalogPlatform = (typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) && !/Windows/i.test(navigator.userAgent)) ? 'macos' as const : 'other' as const;
  const catalogModels = catalogPlatform === 'macos' ? core.MODEL_CATALOG.filter(m => core.macCatalogFamilyAllowed(m.family)) : core.MODEL_CATALOG;
  const rows = catalogModels.flatMap(model => model.quants.map(quant => {
    const info = model.quantInfo[quant]!;
    return { family: model.family, name: model.name, quant, downloadGB: info.downloadGB, ramGB: info.ramGB, fit: fitState(info.ramGB, memoryGB), experimental: !!info.experimental, nvidiaOnly: !!info.nvidiaOnly, recommended: false };
  }));
  const penalty = (row: Recommendation) => (row.experimental ? 2 : 0) + (row.nvidiaOnly && !nvidia ? 4 : 0);
  rows.sort((a, b) => fitRank[a.fit ?? 'unknown'] - fitRank[b.fit ?? 'unknown'] || penalty(a) - penalty(b) || order.indexOf(a.family) - order.indexOf(b.family) || (a.fit === 'fits' ? b.ramGB - a.ramGB : a.ramGB - b.ramGB));
  // One quant per family in the top list keeps choices distinct; the rest fill in after.
  const seen = new Set<string>(), first: Recommendation[] = [], rest: Recommendation[] = [];
  for (const row of rows) (seen.has(row.family) ? rest : (seen.add(row.family), first)).push(row);
  const list = [...first, ...rest].slice(0, limit);
  if (list[0] && list[0].fit !== 'over') list[0] = { ...list[0], recommended: true };
  return list;
}
export const defaultContext = (scene: Scene) => scene === 'long' ? 131072 : 32768;

// ---- Arena (public, read-only) -----------------------------------------------------------
export interface ArenaGroupSummary { group: string; family: string; quant: string; machines: number; bestDecode?: number; gpus?: { gpu: string; vramGB: number; machines: number }[] }
export interface ArenaMatch { group: string; level: 'gpu' | 'vram'; gpu?: string; vramGB?: number; machines: number }
const gpuKey = (value: string) => value.toLowerCase().replace(/nvidia|geforce|amd|radeon|graphics/g, '').replace(/[^a-z0-9]/g, '');

/** Prefer the same GPU model, otherwise the same VRAM tier. Nothing else is shown as "measured". */
export function arenaMatch(groups: ArenaGroupSummary[] | undefined, family: string, quant: string, gpu: ParsedGpu | undefined): ArenaMatch | null {
  const group = groups?.find(item => item.family === family && item.quant === quant) ?? groups?.find(item => item.group === `${family}:${quant}`);
  if (!group?.gpus?.length || !gpu) return null;
  const key = gpuKey(gpu.name);
  const same = key ? group.gpus.find(item => gpuKey(item.gpu) === key) : undefined;
  if (same && same.machines > 0) return { group: group.group, level: 'gpu', gpu: same.gpu, machines: same.machines };
  if (!gpu.vramGB) return null;
  const tier = group.gpus.filter(item => item.vramGB === gpu.vramGB);
  const machines = tier.reduce((sum, item) => sum + item.machines, 0);
  return machines > 0 ? { group: group.group, level: 'vram', vramGB: gpu.vramGB, machines } : null;
}
/** Query map for the native `arena_get` leaderboard call; keys are within the backend's QUERY_KEYS allow-list. */
export function arenaLeaderboardQuery(match: ArenaMatch): Record<string, string> {
  const query: Record<string, string> = { group: match.group };
  if (match.level === 'gpu' && match.gpu) query.gpu = match.gpu; else if (match.vramGB) query.vram = String(match.vramGB);
  return query;
}
/** Machine count drives the 1–3 bar confidence glyph (not a colour scale). */
export const confidenceBars = (machines: number) => machines >= 10 ? 3 : machines >= 3 ? 2 : machines > 0 ? 1 : 0;

// ---- Live detection ----------------------------------------------------------------------
export interface GuideInput {
  progress: OnboardingProgress | null;
  desktop: boolean;
  tasks: core.TaskStatus[];
  handoffs: core.SetupHandoff[];
  runtime?: { taskId?: string; result?: { installDir: string; pythonPath: string; profile: core.ServiceProfile }; detectedRuntimes?: { readiness: 'ready' | 'repair'; runtimeVersion?: string; profile: core.ServiceProfile }[] };
  runtimePending: boolean;
  environment?: core.EnvironmentInfo;
  environmentFailed: boolean;
  profiles: core.ServiceProfile[];
  candidates: core.LocalCandidate[];
  activeProfile?: core.ServiceProfile;
  online: boolean;
  loaded: boolean;
  starting: boolean;
}
export interface GuideState {
  facts: GuideFacts;
  plan?: GuidePlan;
  checks?: EnvironmentCheck[];
  runtimeTask?: core.TaskStatus;
  setupTask?: core.TaskStatus;
  handoff?: core.SetupHandoff;
  readyRuntime?: { runtimeVersion?: string; profile: core.ServiceProfile };
  target?: core.ServiceProfile;
}

/** Everything the guide shows is re-derived from backend state; stored progress only adds intent. */
export function deriveGuide(input: GuideInput): GuideState {
  const { progress, tasks, handoffs, profiles } = input;
  const runtimeTask = tasks.find(task => task.id === progress?.runtimeTaskId)
    ?? tasks.find(task => task.kind.includes('install') && task.state === 'running')
    ?? tasks.find(task => task.id === input.runtime?.taskId);
  const detected = input.runtime?.detectedRuntimes ?? (input.runtime?.result ? [{ readiness: 'ready' as const, runtimeVersion: undefined, profile: input.runtime.result.profile }] : []);
  const readyRuntime = detected.find(item => item.readiness === 'ready');
  const runtime: GuideFacts['runtime'] = runtimeTask?.state === 'running' ? 'running' : readyRuntime ? 'ready'
    : runtimeTask && runtimeTask.id === progress?.runtimeTaskId && runtimeTask.state !== 'completed' ? 'failed'
    : detected.some(item => item.readiness === 'repair') ? 'repair' : input.desktop && input.runtimePending ? 'unknown' : 'none';
  const setupTask = tasks.find(task => task.id === progress?.setupTaskId) ?? tasks.find(task => task.kind.includes('setup') && task.state === 'running');
  const handoff = setupTask ? handoffs.find(item => item.taskId === setupTask.id) : undefined;
  const checks = input.environment ? environmentChecks(input.environment) : undefined;
  const environment: GuideFacts['environment'] = !input.desktop || input.environmentFailed && !checks ? 'unavailable' : environmentVerdict(checks);
  const target = profiles.find(item => item.id === progress?.profileId)
    ?? (handoff?.profileId ? profiles.find(item => item.id === handoff.profileId) : undefined)
    ?? input.activeProfile ?? profiles[0];
  const isTarget = !!target && input.activeProfile?.id === target.id;
  const facts: GuideFacts = {
    environment, runtime, setup: setupTask ? { state: setupTask.state } : undefined, handoff: handoff?.status,
    hasModel: profiles.length > 0 || input.candidates.length > 0, hasProfile: profiles.length > 0,
    online: input.online && isTarget, loaded: input.loaded && isTarget, starting: input.starting,
  };
  const plan = progress?.path ? guidePlan(progress.path, facts, progress) : undefined;
  return { facts, plan, checks, runtimeTask, setupTask, handoff, readyRuntime, target };
}
