/**
 * The run config's draft-model choice ("预测（投机解码）" / Drafting), aligned with upstream Strata v0.2.6:
 * - strata_control/drafting.py: MODES auto | mtp | dflash2 | off, default auto; an unknown value reads as auto.
 *   `"drafting": "off"` strips --mtp / --spec-min-p / --batch-mtp (and --draft / --draft-model) at start.
 * - Engines 0.1.46–0.1.47 only know the older `"mtp": false` switch (draft_layer.is_off); `drafting` arrives in 0.1.48.
 * - apps/host/src/lib/drafting.ts: DFlash2 is offered only for the qwen / gyro / unsloth families (Unsloth's quantizations of
 *   the same Qwen3.8-Flash-Next weights, e.g. qwen3.8-flash-next-unsloth-ud-q4_k_xl) AND only while Control reports
 *   `capabilities.dflash2 === true` (ENGINE_SERVES_DFLASH2). Strata v0.2.10 (engine 0.1.56) makes DFlash2 the Auto drafter for
 *   Qwen3.8, so the manager offers it from engine 0.1.56 on (DFLASH2_SINCE). DFlash2 answers one request at a time: with
 *   `parallel` / `--parallel` / `--batch` / `--slots` of 2 or more Strata runs MTP instead (strata_control/drafting.py blocked_by).
 * - server.py still reads the original `mtp` key: an explicit Auto / MTP must remove a stale `"mtp": false`, or MTP stays off.
 * Every change takes effect on the next start. Nothing here reads or writes files.
 */
import type { JsonObject } from './types';

export type DraftingMode = 'auto' | 'mtp' | 'dflash2' | 'off';
export const DRAFTING_MODES: readonly DraftingMode[] = ['auto', 'mtp', 'dflash2', 'off'];
export const DRAFTING_FAMILIES: readonly string[] = ['qwen', 'gyro', 'unsloth'];
/** First engine that reads `"drafting"`. */
export const DRAFTING_KEY_SINCE = '0.1.48';
/** First engine that honours `"mtp": false`. */
export const MTP_SWITCH_SINCE = '0.1.46';
/** First engine that ships DFlash2 as the Auto drafter (Strata v0.2.10). */
export const DFLASH2_SINCE = '0.1.56';
/** First engine where hand-selected DFlash2 (`"drafting": "dflash2"`) runs per-request slot drafts on non-Metal backends (Strata v0.2.11). */
export const DFLASH2_NAMED_BATCH_SINCE = '0.1.57';
/** `drafting`: writes the key; `mtpSwitch`: only `"mtp": false`; `none`: too old; `unknown`: engine version not detected. */
export type DraftingSupport = 'drafting' | 'mtpSwitch' | 'none' | 'unknown';
export type DraftingBackend = 'cuda' | 'hip' | 'sycl' | 'metal' | 'unknown';
export type DraftingConcurrencyReason =
  | 'none'
  | 'pipeline_windows'
  | 'auto_multi_request'
  | 'metal_multi_request'
  | 'legacy_multi_request'
  | 'named_batch_allowed';

export interface DraftingConcurrencyInput {
  config?: JsonObject | null;
  engineVersion?: string | null;
  /** Explicit backend ('cuda' | 'hip' | 'sycl' | 'metal'); otherwise inferred from config.backend / mac flag / exe path. */
  backend?: string | null;
  mac?: boolean;
  dflash2Served?: boolean | null;
}

export interface DraftingConcurrencyDecision {
  mode: DraftingMode;
  requests: number;
  backend: DraftingBackend;
  hasPipelineWindows: boolean;
  /** Engine 0.1.57+ supports per-request DFlash2 when DFlash2 is chosen by name on non-Metal backends. */
  namedBatchSupported: boolean;
  /** True when the current choice (auto or dflash2) is blocked from running DFlash2 and falls back to MTP. */
  blockedToMtp: boolean;
  /** True when DFlash2 is hand-selected with 2+ requests on 0.1.57+ non-Metal and runs per-slot DFlash2. */
  runsNamedBatchDflash2: boolean;
  reason: DraftingConcurrencyReason;
}

const parts = (version: string) => version.trim().replace(/^v/i, '').split(/[.\-+_]/).map(part => /^\d+$/.test(part) ? Number(part) : NaN);
/** Numeric dotted comparison; null when either side is not a plain engine version such as 0.1.47 or 0.1.43.1. */
function compare(a: string, b: string): number | null {
  const x = parts(a), y = parts(b);
  if (x.some(Number.isNaN) || y.some(Number.isNaN) || !x.length) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}

export function draftingSupport(engineVersion: string | null | undefined): DraftingSupport {
  if (!engineVersion) return 'unknown';
  const key = compare(engineVersion, DRAFTING_KEY_SINCE), mtp = compare(engineVersion, MTP_SWITCH_SINCE);
  if (key === null || mtp === null) return 'unknown';
  return key >= 0 ? 'drafting' : mtp >= 0 ? 'mtpSwitch' : 'none';
}

/** Engine 0.1.56+ serves DFlash2; null when the version is unknown. */
export function engineServesDflash2(engineVersion: string | null | undefined): boolean | null {
  if (!engineVersion) return null;
  const since = compare(engineVersion, DFLASH2_SINCE);
  return since === null ? null : since >= 0;
}

const groupFlag = (g: readonly string[]): string => {
  const head = g[0];
  if (!head || !head.startsWith('--')) return '';
  const eq = head.indexOf('=');
  return eq >= 0 ? head.slice(0, eq) : head;
};
const groupArgs = (raw: unknown): string[][] => {
  const out: string[][] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    if (item.startsWith('--') || !out.length || out[out.length - 1]![0]!.includes('=')) out.push([item]);
    else out[out.length - 1]!.push(item);
  }
  return out;
};
const effectiveDraftingArgs = (config: JsonObject | undefined | null): string[] => {
  const base = Array.isArray(config?.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : [];
  if (!Array.isArray(config?.user_args) || !config.user_args.length) return base;
  const ug = groupArgs(config.user_args);
  const mine = new Set(ug.map(groupFlag).filter(Boolean));
  if (!mine.size) return base;
  return [...groupArgs(base).filter(g => !mine.has(groupFlag(g))), ...ug].flat();
};

/** Concurrent requests the config asks for: `parallel`, else the largest `--parallel` / `--batch` / `--slots` value; 1 when unset. */
export function draftingRequestsOf(config: JsonObject | undefined | null): number {
  const counts: number[] = [];
  const add = (value: unknown) => { const n = Number(typeof value === 'string' ? value.trim() : value); if (Number.isSafeInteger(n) && n > 0) counts.push(n); };
  add(config?.parallel);
  const args = effectiveDraftingArgs(config);
  args.forEach((arg, index) => {
    for (const flag of ['--parallel', '--batch', '--slots']) {
      if (arg === flag) add(args[index + 1]);
      else if (arg.startsWith(`${flag}=`)) add(arg.slice(flag.length + 1));
    }
  });
  return counts.length ? Math.max(...counts) : 1;
}

/** Upstream drafting.normalize: an unknown or missing value is auto. */
export function normalizeDrafting(value: unknown): DraftingMode {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (DRAFTING_MODES as readonly string[]).includes(text) ? text as DraftingMode : 'auto';
}

/** The qwen / gyro / unsloth family from the run config's model name (upstream drafting._SUPPORTED_NAME), else null. */
export function draftingFamilyOf(config: JsonObject | undefined | null): 'qwen' | 'gyro' | 'unsloth' | null {
  const name = typeof config?.model_name === 'string' ? config.model_name.trim() : '';
  if (!/^qwen3\.8-flash-next(-gyro-[a-z0-9._-]+|-unsloth-[a-z0-9._-]+|-(q|iq|tq)\d[a-z0-9_.]*)?$/i.test(name)) return null;
  return /^qwen3\.8-flash-next-gyro-/i.test(name) ? 'gyro' : /^qwen3\.8-flash-next-unsloth-/i.test(name) ? 'unsloth' : 'qwen';
}

/** Choices for the toggle. DFlash2 needs a supported family and `dflash2Served === true`; a saved dflash2 still shows. */
export function draftingChoices(family: string | null | undefined, dflash2Served: boolean | null | undefined, current?: DraftingMode): DraftingMode[] {
  const served = DRAFTING_FAMILIES.includes(String(family)) && dflash2Served === true;
  return served || current === 'dflash2' ? ['auto', 'mtp', 'dflash2', 'off'] : ['auto', 'mtp', 'off'];
}

/** What the config asks for: `drafting` first, then the legacy `"mtp": false`; otherwise auto. */
export function draftingModeOf(config: JsonObject | undefined | null): DraftingMode {
  if (!config) return 'auto';
  if (typeof config.drafting === 'string') return normalizeDrafting(config.drafting);
  return config.mtp === false ? 'off' : 'auto';
}

/**
 * Write a drafting choice for the given engine version. Only the boolean `mtp: false` is ever removed; a string `mtp`
 * (an older data-folder path) is left alone.
 * - 0.1.48+: `drafting: mode`; a stale `mtp: false` is removed so server.py does not keep MTP off.
 * - 0.1.46–0.1.47: Off writes `mtp: false`; Auto / MTP write no field (and drop a `drafting` key the engine ignores).
 * - Unknown version: Off writes both keys (each engine reads the one it knows); Auto / MTP drop `mtp: false` and only
 *   update a `drafting` key that is already there.
 * - Older than 0.1.46 (or DFlash2 without the drafting key): unchanged.
 */
export function applyDrafting(config: JsonObject, mode: DraftingMode, engineVersion: string | null | undefined): JsonObject {
  const support = draftingSupport(engineVersion);
  if (support === 'none' || (mode === 'dflash2' && support !== 'drafting')) return config;
  const next: JsonObject = { ...config };
  const dropMtpOff = () => { if (next.mtp === false) delete next.mtp; };
  if (support === 'drafting') {
    next.drafting = mode;
    dropMtpOff();
  } else if (support === 'mtpSwitch') {
    delete next.drafting;
    if (mode === 'off') next.mtp = false; else dropMtpOff();
  } else if (mode === 'off') {
    next.drafting = 'off';
    next.mtp = false;
  } else {
    dropMtpOff();
    if ('drafting' in next) next.drafting = mode;
  }
  return next;
}

/** What actually ran, from the effective engine args: `--draft dflash2` → dflash2, `--mtp <dir>` → mtp, else off. */
export function effectiveDraftingOf(args: readonly string[] | undefined | null): 'mtp' | 'dflash2' | 'off' | null {
  if (!Array.isArray(args)) return null;
  const value = (flag: string) => { const i = args.findIndex(arg => arg === flag || arg.startsWith(`${flag}=`)); return i < 0 ? undefined : args[i] === flag ? args[i + 1] : args[i]!.slice(flag.length + 1); };
  if (value('--draft')?.toLowerCase() === 'dflash2') return 'dflash2';
  return args.some(arg => arg === '--mtp' || arg.startsWith('--mtp=')) ? 'mtp' : 'off';
}

/** The DFlash2 drafter download (upstream strata_control/drafting.py): stock HF ~1.2 GB (0.52 GB on disk), tuned release ~0.34 GB (selq4) or 0.52 GB (bf16sel). */
export const DFLASH2_DOWNLOAD = { repo: 'incoai/Qwen3.8-Flash-Next-DFlash2', license: 'Apache-2.0', downloadGb: 1.2, diskGb: 0.52, tunedSelq4Gb: 0.34, tunedBf16Gb: 0.52, vramGb: 0.89, vramSelq4Gb: 0.72 } as const;

export interface Dflash2Plan {
  ready: boolean;
  needed: boolean;
  tuned: boolean;
  tunedUpdate: boolean;
  gb: number;
  downloadGb: number;
  diskGb: number;
  vramGb?: number | null;
  selq4?: boolean | null;
  pack?: string | null;
  repo?: string | null;
  drafter?: 'dflash2' | 'mtp' | 'off' | null;
  choice?: 'dflash2' | 'mtp' | 'off' | null;
  note?: string | null;
  line?: string | null;
  support?: string | null;
  supportLine?: string | null;
  text?: string | null;
}

export interface Dflash2Status {
  ready: boolean | null;
  fetchable: boolean;
  tunedUpdate?: boolean | null;
  plan?: Dflash2Plan | null;
}

export interface Dflash2DownloadCopy {
  tuned: boolean;
  tunedUpdate: boolean;
  downloadGb: number;
  diskGb: number;
  vramText: string;
  buttonLabel: string;
  statusHint: string;
  confirmSourceParagraph: string;
  confirmFolderParagraph: string;
}

function resolveDraftingBackend(input: DraftingConcurrencyInput): DraftingBackend {
  for (const raw of [input.backend, input.config?.backend]) {
    if (typeof raw === 'string') {
      const lower = raw.trim().toLowerCase();
      if (lower === 'cuda' || lower === 'hip' || lower === 'sycl' || lower === 'metal') return lower;
    }
  }
  if (input.mac === true) return 'metal';
  const exe = typeof input.config?.exe === 'string' ? input.config.exe.toLowerCase() : '';
  if (exe.includes('metal')) return 'metal';
  if (exe.includes('sycl')) return 'sycl';
  if (exe.includes('hip') || exe.includes('rdna') || exe.includes('rx')) return 'hip';
  if (exe.includes('cuda')) return 'cuda';
  return 'unknown';
}

/**
 * Centralized DFlash2 concurrency policy (upstream strata_control/drafting.py `blocked_by`, v0.2.10 vs v0.2.11+):
 * - `--pipeline-windows` always blocks DFlash2 (both Auto and named DFlash2).
 * - With 2+ concurrent requests (`parallel`, `--parallel`, `--batch`, `--slots`):
 *   - Auto always switches to MTP (`auto_multi_request`).
 *   - Named `"dflash2"` on engine 0.1.57+ and non-Metal backends (CUDA/HIP/SYCL) keeps concurrent slots (`named_batch_allowed`).
 *   - Named `"dflash2"` on Metal (`metal_multi_request`) or on engine <= 0.1.56 (`legacy_multi_request`) falls back to MTP.
 */
export function draftingConcurrencyPolicy(input: DraftingConcurrencyInput): DraftingConcurrencyDecision {
  const config = input.config ?? null;
  const mode = draftingModeOf(config);
  const requests = draftingRequestsOf(config);
  const backend = resolveDraftingBackend(input);
  const args = effectiveDraftingArgs(config);
  const hasPipelineWindows = args.some(arg => arg === '--pipeline-windows' || arg.startsWith('--pipeline-windows='));
  const hasMultiRequestFlag = requests >= 2 || args.some(arg => arg === '--batch' || arg.startsWith('--batch=') || arg === '--slots' || arg.startsWith('--slots=') || arg === '--parallel' || arg.startsWith('--parallel='));
  const cmp = input.engineVersion ? compare(input.engineVersion, DFLASH2_NAMED_BATCH_SINCE) : null;
  const namedBatchSupported = cmp !== null && cmp >= 0 && backend !== 'metal';
  if (mode !== 'auto' && mode !== 'dflash2') {
    return { mode, requests, backend, hasPipelineWindows, namedBatchSupported, blockedToMtp: false, runsNamedBatchDflash2: false, reason: 'none' };
  }
  if (hasPipelineWindows) {
    return { mode, requests, backend, hasPipelineWindows, namedBatchSupported, blockedToMtp: true, runsNamedBatchDflash2: false, reason: 'pipeline_windows' };
  }
  if (hasMultiRequestFlag && requests >= 2) {
    if (mode === 'auto') {
      return { mode, requests, backend, hasPipelineWindows, namedBatchSupported, blockedToMtp: true, runsNamedBatchDflash2: false, reason: 'auto_multi_request' };
    }
    if (backend === 'metal') {
      return { mode, requests, backend, hasPipelineWindows, namedBatchSupported, blockedToMtp: true, runsNamedBatchDflash2: false, reason: 'metal_multi_request' };
    }
    if (namedBatchSupported) {
      return { mode, requests, backend, hasPipelineWindows, namedBatchSupported, blockedToMtp: false, runsNamedBatchDflash2: true, reason: 'named_batch_allowed' };
    }
    return { mode, requests, backend, hasPipelineWindows, namedBatchSupported, blockedToMtp: true, runsNamedBatchDflash2: false, reason: 'legacy_multi_request' };
  }
  return { mode, requests, backend, hasPipelineWindows, namedBatchSupported, blockedToMtp: false, runsNamedBatchDflash2: false, reason: 'none' };
}

/** Bilingual UI note for `draftingConcurrencyPolicy`; null when no concurrency note applies. */
export function draftingConcurrencyNote(decision: DraftingConcurrencyDecision, zh: boolean): string | null {
  switch (decision.reason) {
    case 'pipeline_windows':
      return zh
        ? '已启用 --pipeline-windows：DFlash2 不支持流水线窗口，将改用 MTP。'
        : '--pipeline-windows is enabled: DFlash2 does not run with pipeline windows, so MTP runs instead.';
    case 'auto_multi_request':
      if (decision.namedBatchSupported) {
        return zh
          ? `并发 ${decision.requests} 个请求：“自动”在多并发时改用 MTP；若需并发使用 DFlash2，可手动选择「DFlash2」。`
          : `${decision.requests} concurrent requests: Auto switches to MTP for multiple requests; choose “DFlash2” explicitly to run DFlash2 with concurrent slots.`;
      }
      return zh
        ? `并发 ${decision.requests} 个请求：DFlash2 一次只服务一个请求，将改用 MTP。`
        : `${decision.requests} concurrent requests: DFlash2 serves one request at a time, so MTP runs instead.`;
    case 'metal_multi_request':
      return zh
        ? `并发 ${decision.requests} 个请求：Mac（Metal）引擎不支持多并发 DFlash2，将改用 MTP。`
        : `${decision.requests} concurrent requests: the Mac (Metal) engine does not support concurrent DFlash2 slots, so MTP runs instead.`;
    case 'legacy_multi_request':
      return zh
        ? `并发 ${decision.requests} 个请求：DFlash2 一次只服务一个请求，将改用 MTP。`
        : `${decision.requests} concurrent requests: DFlash2 serves one request at a time, so MTP runs instead.`;
    case 'named_batch_allowed':
      return zh
        ? `并发 ${decision.requests} 个请求：已手动选择 DFlash2，引擎将为每个并发槽启用 DFlash2 草稿。`
        : `${decision.requests} concurrent requests: with DFlash2 chosen explicitly, the engine runs a DFlash2 drafter per request slot.`;
    default:
      return null;
  }
}

/** Source, size and confirmation copy for DFlash2 download / tuned update, driven by `strata drafting plan` when available. */
export function dflash2DownloadCopy(status: Dflash2Status | null | undefined, zh: boolean): Dflash2DownloadCopy {
  const plan = status?.plan ?? null;
  const tuned = plan?.tuned === true;
  const tunedUpdate = status?.tunedUpdate === true || plan?.tunedUpdate === true;
  const downloadGb = plan?.downloadGb && plan.downloadGb > 0 ? plan.downloadGb : tuned ? DFLASH2_DOWNLOAD.tunedSelq4Gb : DFLASH2_DOWNLOAD.downloadGb;
  const diskGb = plan?.diskGb && plan.diskGb > 0 ? plan.diskGb : tuned ? DFLASH2_DOWNLOAD.tunedSelq4Gb : DFLASH2_DOWNLOAD.diskGb;
  const vramText = plan?.vramGb && plan.vramGb > 0 ? String(Number(plan.vramGb.toFixed(2))) : `${DFLASH2_DOWNLOAD.vramSelq4Gb}–${DFLASH2_DOWNLOAD.vramGb}`;
  const repo = plan?.repo || DFLASH2_DOWNLOAD.repo;
  const license = DFLASH2_DOWNLOAD.license;
  const buttonLabel = tunedUpdate
    ? (zh ? '更新微调版 DFlash2' : 'Update to tuned DFlash2')
    : (zh ? '下载 DFlash2' : 'Download DFlash2');
  const statusHint = tunedUpdate
    ? (zh
      ? `已有旧版 DFlash2 预测器可用；可下载官方微调版更新（约 ${downloadGb} GB，来自 Strata 签名更新源）。`
      : `A stock DFlash2 pack is available on disk; a tuned update (about ${downloadGb} GB from Strata's signed update feed) can be downloaded.`)
    : status?.ready === false
      ? (zh ? '还没有 DFlash2 预测器文件：未下载时将改用 MTP。' : 'No DFlash2 drafter file yet: without it Strata runs MTP.')
      : (zh ? '未能确认 DFlash2 预测器文件是否已下载。' : 'Could not confirm whether the DFlash2 drafter is downloaded.');
  const confirmSourceParagraph = tuned
    ? (zh
      ? `将从 Strata 签名更新源（GitHub Release，${license} 许可，基于 ${repo} 微调）下载约 ${downloadGb} GB，在磁盘上约占 ${diskGb} GB，运行时约占 ${vramText} GB 显存（不与 MTP 层同时加载）。`
      : `Downloads about ${downloadGb} GB from Strata's signed update feed (GitHub Release, ${license}, tuned from ${repo}); takes about ${diskGb} GB on disk and about ${vramText} GB of VRAM when running (the MTP layer is not loaded beside it).`)
    : (zh
      ? `将从 ${repo}（${license} 许可）下载约 ${downloadGb} GB，打包后在磁盘上约占 ${diskGb} GB，运行时约占 ${vramText} GB 显存（不与 MTP 层同时加载）。`
      : `Downloads about ${downloadGb} GB from ${repo} (${license}); takes about ${diskGb} GB on disk after packing and about ${vramText} GB of VRAM when running (the MTP layer is not loaded beside it).`);
  const confirmFolderParagraph = zh
    ? '文件放在这个模型的数据目录（dflash2 文件夹）。启动服务不会自动下载；下载完成后，下次启动即可按当前配置启用 DFlash2。'
    : "The file goes into this model's data folder (dflash2). Starting the service never downloads it; once downloaded, the next start uses DFlash2 according to this configuration.";
  return { tuned, tunedUpdate, downloadGb, diskGb, vramText, buttonLabel, statusHint, confirmSourceParagraph, confirmFolderParagraph };
}

export interface Dflash2FetchProgress {
  step?: string; done?: number; total?: number;
  /** The final line: ok with the pack path, or the error message. */
  result?: { ok: true; pack: string | null } | { ok: false; message: string };
}

/** Reads `strata drafting fetch --output jsonl` lines (task log messages): the last progress line and the result line. */
export function dflash2FetchProgress(lines: readonly string[]): Dflash2FetchProgress {
  const out: Dflash2FetchProgress = {};
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let value: unknown;
    try { value = JSON.parse(text); } catch { continue; }
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (row.event === 'progress') {
      const done = Number(row.done), total = Number(row.total);
      out.step = typeof row.step === 'string' ? row.step : undefined;
      out.done = Number.isFinite(done) && done >= 0 ? done : undefined;
      out.total = Number.isFinite(total) && total > 0 ? total : undefined;
    } else if (row.ok === true && row.event === 'result') {
      out.result = { ok: true, pack: typeof row.pack === 'string' ? row.pack : null };
    } else if (row.ok === false) {
      const error = row.error as Record<string, unknown> | undefined;
      out.result = { ok: false, message: typeof error?.message === 'string' ? error.message : String(error?.code ?? 'drafting_failed') };
    }
  }
  return out;
}
