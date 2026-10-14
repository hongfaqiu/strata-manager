/**
 * Whether the installed engine documents a flag in its own `--help`.
 * 'supported' = listed; 'unlisted' = help was read and the flag is absent (the form disables it,
 * an existing saved value is kept untouched); 'unknown' = help unavailable, so nothing is hidden.
 * Config keys (no leading --) are owned by server.py's config, not the engine, and stay 'unknown'.
 */
export type EngineFlagSupport = 'supported' | 'unlisted' | 'unknown';
export function engineFlagSupport(flag: string, documented: ReadonlySet<string> | readonly string[] | null | undefined): EngineFlagSupport {
  if (!flag.startsWith('--') || !documented) return 'unknown';
  const set = documented instanceof Set ? documented : new Set(documented as readonly string[]);
  if (set.size < 3) return 'unknown';
  return set.has(flag.toLowerCase()) ? 'supported' : 'unlisted';
}
