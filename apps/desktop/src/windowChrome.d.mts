export type WindowChrome = 'macos' | 'custom';
export function detectWindowChrome(input: { desktop: boolean; platform?: string; userAgent?: string; override?: string | null }): WindowChrome;
export function currentWindowChrome(root?: { dataset?: { windowChrome?: string } } | null): WindowChrome;
