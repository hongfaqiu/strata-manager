// Maps the supervisor's maintenance-gate messages (crates/runtime-core/src/maintenance.rs)
// to localized, actionable text. The backend speaks Chinese; any message not listed
// here is shown unchanged. Keep these strings byte-identical to the Rust constants
// (speedBoostFailure.test.mjs checks that).
export const observerFailureKeys: ReadonlyArray<readonly [string, string]> = [
  ['服务观察器没有运行，无法安全暂停请求。请重启这个模型服务后再试', 'sbObsMissing'],
  ['这个 Strata 版本的服务端还不在统计观察器的兼容列表里，无法安全暂停请求。请把 Strata Manager 更新到最新版本，然后重启这个模型服务', 'sbObsUnsupported'],
  ['统计观察器写不进本地数据库（可能是磁盘已满或没有写入权限）。请检查磁盘空间后重启这个模型服务', 'sbObsJournal'],
  ['服务观察器超过 1 分钟没有心跳，可能已经卡住。请重启这个模型服务后再试', 'sbObsStale'],
  ['服务观察器当前没有接管这个服务（可能是会话已结束），保留当前服务。请重启这个模型服务后再试', 'sbObsInactive'],
  // Messages persisted by Strata Manager 0.2.8 and earlier. The usual cause was a
  // Strata server the observer did not support yet (0.2.0).
  ['服务观察器版本、心跳或持久化状态不完整，保留当前服务', 'sbObsLegacy'],
  ['服务观察器不可用，无法核验安全维护，请先修复兼容性', 'sbObsMissing'],
];

/** The translation key for a known maintenance-gate failure, or null to show the message as is. */
export function speedBoostFailureKey(message: string | null | undefined): string | null {
  if (!message) return null;
  for (const [text, key] of observerFailureKeys) if (message.includes(text)) return key;
  return null;
}

/** Localized failure text: a known gate failure is translated, anything else is kept. */
export function speedBoostFailureText(message: string | null | undefined, t: (key: string) => string): string {
  const key = speedBoostFailureKey(message);
  return key ? t(key) : message ?? '';
}

/**
 * A failed or interrupted run that ended before this page was opened is history,
 * not a current error: it is shown as "the last measurement did not finish" with its time.
 */
export function isEarlierFailure(job: { state: string; startedAt: number; finishedAt?: number; updatedAt?: number } | null | undefined, openedAt: number): boolean {
  if (!job || !['failed', 'interrupted'].includes(job.state)) return false;
  const ended = job.finishedAt ?? job.updatedAt ?? job.startedAt;
  return ended < openedAt;
}
