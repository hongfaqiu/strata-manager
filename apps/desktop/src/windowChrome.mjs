// Which window chrome the main window uses.
//
// "macos": native traffic lights (titleBarStyle Overlay, see
// src-tauri/tauri.macos.conf.json); the header leaves room for them and
// renders no window buttons of its own.
// "custom": the borderless Windows/Linux window with our own minimize,
// maximize and close buttons on the right (also used in a plain browser).

/** @param {{ desktop: boolean, platform?: string, userAgent?: string, override?: string | null }} input */
export function detectWindowChrome({ desktop, platform = '', userAgent = '', override = null }) {
  if (override === 'macos' || override === 'custom') return override;
  if (!desktop) return 'custom';
  if (platform) return /^Mac/i.test(platform) ? 'macos' : 'custom';
  return /\bMacintosh\b|\bMac OS X\b/.test(userAgent) ? 'macos' : 'custom';
}

/** Reads the value main.tsx stored on <html data-window-chrome>. */
export function currentWindowChrome(root = globalThis.document?.documentElement) {
  return root?.dataset?.windowChrome === 'macos' ? 'macos' : 'custom';
}
