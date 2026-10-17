// Website hosting for the same Worker: the static site (dist/website, Workers static assets) and the
// Arena API share strata-manager.cosfoc.com. arena.cosfoc.com stays an API host for shipped apps; its
// non-API paths redirect to the website.
export const SITE_ORIGIN = 'https://strata-manager.cosfoc.com';
export const API_HOSTS = new Set(['arena.cosfoc.com']);

export const isApiPath = (pathname) => pathname === '/v1' || pathname.startsWith('/v1/');

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000',
};

/** Cache policy by path. No file name is fingerprinted, so HTML and data revalidate on every visit. */
export function cacheControl(pathname) {
  if (pathname.startsWith('/vendor/')) return 'public, max-age=604800, stale-while-revalidate=2592000';
  if (pathname.startsWith('/assets/')) return 'public, max-age=86400, stale-while-revalidate=604800';
  if (/\.(?:css|js)$/.test(pathname)) return 'public, max-age=600, stale-while-revalidate=86400';
  if (pathname === '/arena-snapshot.json') return 'public, max-age=300, stale-while-revalidate=3600';
  return 'public, max-age=0, must-revalidate';
}

export async function serveSite(request, env, url) {
  if (API_HOSTS.has(url.hostname)) {
    const target = url.pathname === '/' ? '/leaderboard' : url.pathname;
    return new Response(null, { status: 301, headers: { Location: SITE_ORIGIN + target + url.search, 'Cache-Control': 'public, max-age=86400' } });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });
  }
  const asset = await env.ASSETS.fetch(request);
  const response = new Response(asset.body, asset);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  if (asset.status === 200 || asset.status === 304) response.headers.set('Cache-Control', cacheControl(url.pathname));
  return response;
}
