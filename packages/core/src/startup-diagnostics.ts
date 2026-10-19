import { asObject, normalizeError } from './errors';

export type StartupDiagnosticCategory = 'resource' | 'port' | 'files' | 'config' | 'auth' | 'timeout' | 'engine' | 'python' | 'unknown';
export type StartupDiagnosticConfidence = 'confirmed' | 'suspected' | 'unknown';
export type StartupDiagnosticAction = 'openResources' | 'openNetwork' | 'openFiles' | 'openConfig' | 'openCredentials' | 'checkStatus' | 'viewLogs' | 'exportDiagnostics';
export interface StartupDiagnosticEvidence { source: 'startupError' | 'httpStatus' | 'serviceLog' | 'process'; at: number; message: string }
export interface StartupFailureDiagnostic {
  profileId: string;
  attemptStartedAt: number;
  failedAt: number;
  phase: 'prepare' | 'starting' | 'loading';
  category: StartupDiagnosticCategory;
  confidence: StartupDiagnosticConfidence;
  code: string;
  message: string;
  evidence: StartupDiagnosticEvidence[];
  actions: StartupDiagnosticAction[];
  processRunning?: boolean;
  pid?: number;
  exitCode?: number;
}

const categories: StartupDiagnosticCategory[] = ['resource', 'port', 'files', 'config', 'auth', 'timeout', 'engine', 'python', 'unknown'];
const confidences: StartupDiagnosticConfidence[] = ['confirmed', 'suspected', 'unknown'];
const actions: StartupDiagnosticAction[] = ['openResources', 'openNetwork', 'openFiles', 'openConfig', 'openCredentials', 'checkStatus', 'viewLogs', 'exportDiagnostics'];
const evidenceSources: StartupDiagnosticEvidence['source'][] = ['startupError', 'httpStatus', 'serviceLog', 'process'];
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const safe = (value: string) => {
  if (/api[_-]?key|authorization|bearer\s|password|secret|cookie|access_token|credential|hf_|ghp_|github_pat_|sk-/i.test(value)) return '[redacted sensitive diagnostic]';
  const scrubbed = value.replace(/https?:\/\/[^\s<>"'`]+/gi, text => {
    try { const url = new URL(text); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
    catch { return '[invalid diagnostic URL]'; }
  });
  return [...scrubbed].slice(0, 1024).join('');
};

/** Validate optional fields from a newer supervisor; old data stays unclassified. */
export function parseStartupDiagnostic(value: unknown, profileId?: string, attemptStartedAt?: number): StartupFailureDiagnostic | null {
  const row = asObject(value);
  if (typeof row.profileId !== 'string' || (profileId !== undefined && row.profileId !== profileId)
    || !number(row.attemptStartedAt) || !number(row.failedAt) || row.failedAt < row.attemptStartedAt
    || (attemptStartedAt !== undefined && row.attemptStartedAt < attemptStartedAt)
    || !categories.includes(row.category as StartupDiagnosticCategory) || !confidences.includes(row.confidence as StartupDiagnosticConfidence)
    || !['prepare', 'starting', 'loading'].includes(String(row.phase)) || typeof row.code !== 'string' || typeof row.message !== 'string') return null;
  let evidence = (Array.isArray(row.evidence) ? row.evidence : []).flatMap(item => {
    const entry = asObject(item);
    return number(entry.at) && entry.at >= (row.attemptStartedAt as number) && entry.at <= (row.failedAt as number)
      && evidenceSources.includes(entry.source as StartupDiagnosticEvidence['source']) && typeof entry.message === 'string'
      ? [{ source: entry.source as StartupDiagnosticEvidence['source'], at: entry.at, message: safe(entry.message) }] : [];
  }).slice(-6);
  const authentication = row.category === 'auth';
  if (authentication) evidence = evidence.filter(item => item.source === 'httpStatus' && /^HTTP (401|403)$/.test(item.message));
  const allowed = (Array.isArray(row.actions) ? row.actions : []).filter((action): action is StartupDiagnosticAction => actions.includes(action as StartupDiagnosticAction)
    && (action !== 'checkStatus' || row.processRunning === true));
  return {
    profileId: row.profileId, attemptStartedAt: row.attemptStartedAt, failedAt: row.failedAt,
    phase: row.phase as StartupFailureDiagnostic['phase'], category: row.category as StartupDiagnosticCategory,
    confidence: row.confidence as StartupDiagnosticConfidence, code: /^[A-Za-z0-9_.-]{1,80}$/.test(row.code) ? row.code : 'STARTUP_UNKNOWN',
    message: authentication ? '连接鉴权失败；请检查本应用的连接凭据，未保留服务响应正文。 / Authentication failed; check the client credential. Response bodies are omitted.' : safe(row.message), evidence,
    actions: [...new Set<StartupDiagnosticAction>([...allowed, 'viewLogs', 'exportDiagnostics'])],
    ...(typeof row.processRunning === 'boolean' ? { processRunning: row.processRunning } : {}),
    ...(number(row.pid) ? { pid: row.pid } : {}), ...(typeof row.exitCode === 'number' && Number.isInteger(row.exitCode) ? { exitCode: row.exitCode } : {}),
  };
}

export function readStartupDiagnostic(error: unknown, profileId: string, attemptStartedAt: number): StartupFailureDiagnostic {
  const normalized = normalizeError(error);
  const embedded = asObject(asObject(normalized.details).details).startupDiagnostic;
  const structured = parseStartupDiagnostic(embedded, profileId, attemptStartedAt);
  if (structured) return structured;
  const failedAt = Math.max(Date.now(), attemptStartedAt);
  // A plain old error, process exit code or memory keyword does not establish a cause.
  const message = embedded !== undefined ? '启动诊断记录未匹配本次操作，请查看当前模型日志。 / The diagnostic does not match this startup; check the current model logs.' : safe(normalized.message);
  return { profileId, attemptStartedAt, failedAt, phase: 'prepare', category: 'unknown', confidence: 'unknown',
    code: safe(normalized.code), message, evidence: [{ source: 'startupError', at: failedAt, message }],
    actions: ['viewLogs', 'exportDiagnostics'] };
}

export function latestStartupDiagnostic(failures: unknown, profileId: string, attemptStartedAt?: number): StartupFailureDiagnostic | undefined {
  return (Array.isArray(failures) ? failures : []).map(item => parseStartupDiagnostic(item, profileId, attemptStartedAt))
    .filter((item): item is StartupFailureDiagnostic => item !== null).sort((left, right) => right.failedAt - left.failedAt)[0];
}

/** Exactly one suggested action; opening or refreshing diagnostics never starts a service. */
export function primaryStartupDiagnosticAction(diagnostic: StartupFailureDiagnostic): StartupDiagnosticAction {
  return diagnostic.actions.find(action => action !== 'viewLogs' && action !== 'exportDiagnostics'
    && (action !== 'checkStatus' || diagnostic.processRunning === true)) ?? 'viewLogs';
}

/**
 * A stored service error (a native JSON envelope such as
 * `{"code":"STARTUP_UNKNOWN","details":{…},"message":"…"}`) as one readable line.
 * Raw JSON is never shown to users; the structured detail stays in diagnostics.
 */
export function readableServiceError(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = normalizeError(value);
  const message = safe(normalized.message.trim());
  if (!message) return undefined;
  // #78: the raw transport text ("error sending request for url (.../load)") says nothing about the cause;
  // it stays in the startup log and the diagnostic details, never in the headline.
  if (/error sending request|operation timed out|connection (?:refused|reset|closed)/i.test(message)) return '本机服务没有响应这次请求（模型可能仍在加载，或引擎已经出错）；原始错误和引擎输出在启动日志里 / The local service did not answer (the model may still be loading, or the engine failed); the raw error and engine output are in the startup log.';
  if (/^\s*[[{]/.test(message)) return '后台返回了无法识别的错误，请导出诊断查看详情 / The backend returned an unreadable error; export diagnostics for details.';
  return message;
}
