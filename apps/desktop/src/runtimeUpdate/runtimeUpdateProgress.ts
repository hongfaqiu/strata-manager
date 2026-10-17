// Turns the Strata ZIP-update task (message + task log) into a stage timeline and download figures.
// The backend has no structured progress: it writes Chinese status lines such as
// "下载进度：82894086 / 137300495 字节" roughly once per second. Everything here is derived
// from those lines and their log timestamps; nothing is invented when a line is missing.

export type UpdateStageId = 'source' | 'download' | 'extract' | 'apply' | 'restore';
export const UPDATE_STAGES: readonly UpdateStageId[] = ['source', 'download', 'extract', 'apply', 'restore'];
export type StageState = 'done' | 'active' | 'pending' | 'failed';
export type UpdateDetail =
  | 'sourceDownload' | 'sourceCheck' | 'sourceUnreviewed' | 'engineStart' | 'retry' | 'waitingShared' | 'cacheReused'
  | 'cacheMismatch' | 'noResume' | 'localRead' | 'verified' | 'extracting' | 'checkingPython' | 'backupReady'
  | 'draining' | 'restoring' | 'rollingBack' | 'rolledBack';

export interface UpdateLogLine { timestamp: number; message: string; level?: string }
export interface UpdateTaskLike { state: 'running' | 'completed' | 'failed' | 'cancelled'; message: string; startedAt: number; finishedAt?: number }
export interface ByteSample { at: number; bytes: number }

export interface ParsedUpdateLine {
  stage?: UpdateStageId;
  detail?: UpdateDetail;
  received?: number;
  /** null: the source declared no length. undefined: the line carries no total. */
  total?: number | null;
  assetName?: string;
  assetSize?: number;
  retry?: { attempt: number; max: number };
  version?: string;
}

const num = (value: string | undefined) => { const parsed = Number(value); return value !== undefined && Number.isFinite(parsed) ? parsed : undefined; };

/** Recognises one backend status line. Unknown lines return {} and leave the stage unchanged. */
export function parseUpdateLine(message: string): ParsedUpdateLine {
  const text = message.trim();
  let match: RegExpMatchArray | null;
  if ((match = text.match(/下载进度：\s*(\d+)\s*\/\s*(\d+)\s*字节/))) return { stage: 'download', received: num(match[1]), total: num(match[2]) };
  if ((match = text.match(/下载进度：\s*(\d+)\s*字节\s*\/\s*总量未知/))) return { stage: 'download', received: num(match[1]), total: null };
  if ((match = text.match(/已读取本地 ZIP\s*(\d+)\s*\/\s*(\d+)\s*字节/))) return { stage: 'download', detail: 'localRead', received: num(match[1]), total: num(match[2]) };
  if ((match = text.match(/下载重试\s*(\d+)\s*\/\s*(\d+)/))) { const saved = text.match(/已保存\s*(\d+)\s*字节/); return { stage: 'download', detail: 'retry', retry: { attempt: num(match[1])!, max: num(match[2])! }, received: num(saved?.[1]) }; }
  if ((match = text.match(/正在下载官方Release v([\w.\-]+)：(.+?)(?:（(\d+)字节）)?及同提交源码/))) return { stage: 'source', detail: 'sourceDownload', version: match[1], assetName: match[2], assetSize: num(match[3]) };
  if ((match = text.match(/官方同版本源码已下载\s*(\d+)\s*字节/))) return { stage: 'source', detail: 'sourceDownload', received: num(match[1]) };
  if (/正在安全解包同版本源码/.test(text)) return { stage: 'source', detail: 'sourceCheck' };
  if (/服务源码不在已审查清单/.test(text)) return { stage: 'source', detail: 'sourceUnreviewed' };
  if ((match = text.match(/源码兼容检查通过；正在下载官方(.+?)(?:（(\d+)字节）|，|$)/))) return { stage: 'download', detail: 'engineStart', assetName: match[1], assetSize: num(match[2]) };
  if (/相同官方包正在下载/.test(text)) return { stage: 'download', detail: 'waitingShared' };
  if (/已复用经过 ?SHA256 ?校验的下载缓存/.test(text)) return { stage: 'download', detail: 'cacheReused' };
  if (/下载缓存校验不符/.test(text)) return { stage: 'download', detail: 'cacheMismatch' };
  if (/断点续传/.test(text) && /重新下载/.test(text)) return { stage: 'download', detail: 'noResume' };
  if (/正在读取本地更新包/.test(text)) return { stage: 'download', detail: 'localRead' };
  if ((match = text.match(/SHA256 ?校验通过，共\s*(\d+)\s*字节/))) return { stage: 'download', detail: 'verified', received: num(match[1]) };
  if (/正在安全解包运行文件/.test(text)) return { stage: 'extract', detail: 'extracting' };
  if (/正在验证Python依赖/.test(text)) return { stage: 'extract', detail: 'checkingPython' };
  if (/备份已准备/.test(text)) return { stage: 'extract', detail: 'backupReady' };
  if (/等待受管服务请求完成/.test(text)) return { stage: 'apply', detail: 'draining' };
  // New installations only; an update never installs Python packages.
  if (/独立Python环境|私有Python环境|安装此Release的Python依赖|CUDA运行库/.test(text)) return { stage: 'apply' };
  if (/正在恢复原受管服务状态/.test(text)) return { stage: 'restore', detail: 'restoring' };
  if (/正在恢复原程序文件/.test(text)) return { detail: 'rollingBack' };
  if (/原程序文件已恢复|已恢复原程序版本/.test(text)) return { detail: 'rolledBack' };
  if ((match = text.match(/(?:已(?:更新|安装)至|已安装)官方Release v([\w.\-]+)/))) return { version: match[1] };
  return {};
}

export interface StageView { id: UpdateStageId; state: StageState; startedAt?: number; endedAt?: number }
export interface UpdateProgressModel {
  outcome: UpdateTaskLike['state'];
  current: UpdateStageId;
  stages: StageView[];
  detail?: UpdateDetail;
  /** Raw backend line for anything this model does not recognise. */
  rawDetail?: string;
  version?: string;
  assetName?: string;
  retry?: { attempt: number; max: number };
  rollingBack: boolean;
  rolledBack: boolean;
  download?: { received: number; total?: number; declared: 'server' | 'manifest' | 'unknown'; verified: boolean };
  /** Same-revision source archive bytes; its size is never declared in advance. */
  sourceReceived?: number;
  samples: ByteSample[];
}

/** Lines from the log (oldest first) plus the task's current message when the log has not caught up yet. */
export function updateLines(task: UpdateTaskLike, logs: UpdateLogLine[], now = Date.now()): UpdateLogLine[] {
  const lines = [...logs].sort((a, b) => a.timestamp - b.timestamp);
  // Tasks and logs are polled separately, so the status line may be older than the newest log line.
  if (task.message && !lines.slice(-30).some(line => line.message === task.message)) lines.push({ timestamp: task.finishedAt ?? (task.state === 'running' ? now : lines.at(-1)?.timestamp ?? now), message: task.message });
  return lines;
}

export function deriveUpdateProgress(task: UpdateTaskLike, logs: UpdateLogLine[], now = Date.now()): UpdateProgressModel {
  const lines = updateLines(task, logs, now);
  let stageIndex = 0, detail: UpdateDetail | undefined, rawDetail: string | undefined, version: string | undefined, assetName: string | undefined, assetSize: number | undefined;
  let retry: UpdateProgressModel['retry'], rollingBack = false, rolledBack = false, verified = false;
  let received: number | undefined, total: number | null | undefined, sourceReceived: number | undefined;
  const starts: (number | undefined)[] = UPDATE_STAGES.map(() => undefined);
  starts[0] = task.startedAt;
  for (const line of lines) {
    const parsed = parseUpdateLine(line.message);
    if (parsed.version) version = parsed.version;
    if (parsed.assetName) assetName = parsed.assetName;
    if (parsed.assetSize) assetSize = parsed.assetSize;
    if (parsed.stage && !rollingBack) {
      const index = UPDATE_STAGES.indexOf(parsed.stage);
      // Stages only move forward: a later Python check after replacement stays in "apply".
      if (index > stageIndex) { for (let skipped = stageIndex + 1; skipped <= index; skipped++) starts[skipped] ??= line.timestamp; stageIndex = index; }
    }
    if (parsed.detail === 'rollingBack') rollingBack = true;
    if (parsed.detail === 'rolledBack') { rollingBack = true; rolledBack = true; }
    if (parsed.stage === 'download' && parsed.received !== undefined) {
      received = parsed.received;
      if (parsed.detail === 'verified') verified = true;
      else if (parsed.detail !== 'retry') { verified = false; if (parsed.total !== undefined) total = parsed.total; }
    }
    if (parsed.stage === 'source' && parsed.received !== undefined) sourceReceived = parsed.received;
    if (parsed.detail === 'cacheReused') verified = true;
    if (parsed.detail === 'retry') retry = parsed.retry;
    if (verified || (parsed.stage && parsed.stage !== 'download')) retry = undefined;
    // The latest line decides the sub-status: progress lines clear it, unknown lines are shown verbatim.
    if (parsed.detail) { detail = parsed.detail; rawDetail = undefined; }
    else if (parsed.stage) { detail = undefined; rawDetail = undefined; }
    else if (!parsed.version) { detail = undefined; rawDetail = line.message; }
  }
  const outcome = task.state;
  const ended = outcome === 'running' ? undefined : task.finishedAt ?? lines.at(-1)?.timestamp;
  const stages: StageView[] = UPDATE_STAGES.map((id, index) => {
    const startedAt = starts[index], endedAt = index < stageIndex ? starts.slice(index + 1).find(value => value !== undefined) : index === stageIndex ? ended : undefined;
    let state: StageState = index < stageIndex ? 'done' : index === stageIndex ? 'active' : 'pending';
    if (outcome === 'completed') state = 'done';
    else if ((outcome === 'failed' || outcome === 'cancelled') && index === stageIndex) state = 'failed';
    return { id, state, startedAt: state === 'pending' ? undefined : startedAt, endedAt };
  });
  const knownTotal = typeof total === 'number' && total > 0 ? total : undefined;
  const fallbackTotal = assetSize && assetSize >= (received ?? 0) ? assetSize : undefined;
  const download = received === undefined && !verified ? undefined : {
    received: received ?? 0,
    total: knownTotal ?? fallbackTotal ?? (verified && received ? received : undefined),
    declared: knownTotal ? 'server' as const : fallbackTotal ? 'manifest' as const : 'unknown' as const,
    verified,
  };
  return { outcome, current: UPDATE_STAGES[stageIndex]!, stages, detail, rawDetail, version, assetName, retry, rollingBack, rolledBack, download, sourceReceived, samples: downloadSamples(lines) };
}

/** Engine download byte samples from the most recent continuous attempt (a drop means the download restarted). */
export function downloadSamples(lines: UpdateLogLine[]): ByteSample[] {
  let samples: ByteSample[] = [];
  for (const line of lines) {
    const parsed = parseUpdateLine(line.message);
    if (parsed.stage !== 'download' || parsed.received === undefined || parsed.detail === 'verified' || parsed.detail === 'retry') continue;
    const last = samples.at(-1);
    if (last && parsed.received < last.bytes) samples = [];
    if (last && line.timestamp <= last.at) { if (parsed.received >= last.bytes) samples[samples.length - 1] = { at: last.at, bytes: parsed.received }; continue; }
    samples.push({ at: line.timestamp, bytes: parsed.received });
  }
  return samples;
}

/** Bytes per second over the trailing window (least-squares slope, so one late log line does not spike it). */
export function estimateRate(samples: ByteSample[], windowMs = 10_000): number | undefined {
  if (samples.length < 2) return undefined;
  const end = samples.at(-1)!.at;
  const recent = samples.filter(sample => sample.at >= end - windowMs);
  const points = recent.length >= 2 ? recent : samples.slice(-2);
  const span = points.at(-1)!.at - points[0]!.at;
  if (span < 1500) return undefined;
  const meanT = points.reduce((sum, p) => sum + p.at, 0) / points.length, meanB = points.reduce((sum, p) => sum + p.bytes, 0) / points.length;
  let numerator = 0, denominator = 0;
  for (const p of points) { numerator += (p.at - meanT) * (p.bytes - meanB); denominator += (p.at - meanT) ** 2; }
  if (!denominator) return undefined;
  const perMs = numerator / denominator;
  return perMs > 0 ? perMs * 1000 : 0;
}

/** Exponential smoothing in time: the displayed value moves ~63% toward a new estimate every `tauMs`. */
export function smoothRate(previous: number | undefined, next: number | undefined, elapsedMs: number, tauMs = 3000): number | undefined {
  if (next === undefined) return previous;
  if (previous === undefined || !Number.isFinite(previous)) return next;
  const weight = 1 - Math.exp(-Math.max(0, elapsedMs) / tauMs);
  return previous + (next - previous) * weight;
}

/** Per-interval rates for a sparkline, newest last. */
export function rateSeries(samples: ByteSample[], limit = 36): number[] {
  const series: number[] = [];
  for (let index = 1; index < samples.length; index++) {
    const dt = samples[index]!.at - samples[index - 1]!.at;
    if (dt > 0) series.push((samples[index]!.bytes - samples[index - 1]!.bytes) / dt * 1000);
  }
  return series.slice(-limit);
}

/** Seconds left, rounded so the number does not flicker: 5 s steps under a minute, whole minutes after. */
export function estimateEta(received: number, total: number | undefined, rate: number | undefined): number | undefined {
  if (!total || !rate || rate <= 0 || received >= total) return undefined;
  const seconds = (total - received) / rate;
  if (!Number.isFinite(seconds) || seconds > 48 * 3600) return undefined;
  if (seconds < 60) return Math.max(5, Math.ceil(seconds / 5) * 5);
  if (seconds < 3600) return Math.ceil(seconds / 60) * 60;
  return Math.ceil(seconds / 600) * 600;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
/** 1024-based sizes with the units Windows Explorer shows: 820 KB, 8.42 MB, 85.3 MB, 131 MB, 1.27 GB. */
export function formatBytes(bytes: number, locale = 'en'): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) { value /= 1024; unit++; }
  const digits = unit === 0 || unit === 1 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)} ${UNITS[unit]}`;
}
export const formatRate = (bytesPerSecond: number, locale = 'en') => `${formatBytes(bytesPerSecond, locale)}/s`;

export function formatPercent(received: number, total: number | undefined, locale = 'en'): string | undefined {
  if (!total) return undefined;
  const ratio = Math.max(0, Math.min(1, received / total));
  // Never show 100% before the last byte, and keep one decimal below 10% so slow starts still move.
  const shown = ratio >= 1 ? 1 : Math.min(ratio, 0.999);
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: shown < 0.1 ? 1 : 0, ...(ratio < 1 ? { roundingMode: 'floor' } as Intl.NumberFormatOptions : {}) }).format(shown);
}

/** Localised "42 seconds" / "3 minutes" / "1.5 hours" through Intl, so every app language is covered. */
export function formatEta(seconds: number, locale = 'en'): string {
  const unit = (value: number, name: 'second' | 'minute' | 'hour', digits = 0) => new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'long', maximumFractionDigits: digits }).format(value);
  if (seconds < 60) return unit(seconds, 'second');
  if (seconds < 3600) return unit(Math.round(seconds / 60), 'minute');
  return unit(Math.round(seconds / 360) / 10, 'hour', 1);
}

/** Clock-style elapsed time: 0:42, 12:05, 1:02:10. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  const two = (value: number) => String(value).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Rewrites raw byte counts in a backend line ("82894086 / 137300495 字节") into readable sizes. */
export function humanizeTaskMessage(message: string, locale = 'en'): string {
  const size = (value: string) => formatBytes(Number(value), locale);
  return message
    .replace(/(\d{4,})\s*\/\s*(\d{4,})\s*字节/g, (_, a: string, b: string) => `${size(a)} / ${size(b)}`)
    .replace(/(\d{4,})\s*\/\s*(\d{4,})/g, (whole, a: string, b: string) => Number(b) >= 1024 * 64 ? `${size(a)} / ${size(b)}` : whole)
    .replace(/（(\d{4,})\s*字节）/g, (_, a: string) => `（${size(a)}）`)
    .replace(/(\d{4,})\s*字节/g, (_, a: string) => size(a));
}
