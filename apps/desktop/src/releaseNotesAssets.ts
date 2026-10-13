/** Map repository screenshot links to the exact assets bundled with this build. */
export function createReleaseNotesAssetResolver(assets: Readonly<Record<string, string>>) {
  const bundled = new Map(Object.entries(assets).filter(([path, url]) =>
    /^docs\/screenshots\/(?:[a-z0-9.-]+\.webp|changelog\/[0-9]+\.[0-9]+\.[0-9]+\/[a-z0-9.-]+\.webp|daily-experience\/(?:model-download-detail|api-verification|history-comparison)\.(?:zh|en)\.webp)$/.test(path)
    && /^\/(?:assets\/|@fs\/)/.test(url)
    && !/[\\\u0000-\u0020]/.test(url),
  ));
  return (url: string): string => {
    // Ordinary links and remote images still use ReactMarkdown's default URL policy.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return url;
    const path = url.split(/[?#]/, 1)[0]!.replace(/^(?:\.\/|\/)/, '');
    let candidate = path.replaceAll('\\', '/');
    try { candidate = decodeURIComponent(candidate); } catch { /* Reject malformed screenshot paths below. */ }
    if (!candidate.includes('docs/screenshots')) return url;
    // Screenshot URLs are a closed resource set; no traversal or decoded aliases.
    if (/[\\%]/.test(path) || path.split('/').some(segment => segment === '.' || segment === '..')) return '';
    return bundled.get(path) ?? '';
  };
}
