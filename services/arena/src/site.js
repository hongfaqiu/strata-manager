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

/** Media served by the Worker (not straight from the asset store) so byte ranges work. */
export const isRangedMedia = (pathname) => pathname.startsWith('/assets/video/');

/**
 * Parse a single `Range: bytes=…` header against a known size. Returns { start, end } (inclusive),
 * 'unsatisfiable', or null when the header is absent or not a single byte range (serve the whole file).
 */
export function parseRange(header, size) {
  const match = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** Stream only bytes [start, end] of a body, cancelling the source once the range has been sent. */
function sliceStream(body, start, end) {
  const reader = body.getReader();
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        if (offset > end) { controller.close(); reader.cancel().catch(() => {}); return; }
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        const chunkStart = offset;
        offset += value.byteLength;
        if (offset <= start) continue;
        const from = Math.max(0, start - chunkStart);
        const to = Math.min(value.byteLength, end - chunkStart + 1);
        controller.enqueue(value.subarray(from, to));
        return;
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

/**
 * Workers static assets answer Range requests with the whole file (200). Safari and iOS refuse to
 * play <video> from such a server, so video files get 206 responses sliced here.
 */
async function serveRangedMedia(request, env) {
  const range = request.headers.get('Range');
  // Always ask the asset store for the full file; byte ranges are applied below.
  const asset = await env.ASSETS.fetch(new Request(request.url, { headers: { Accept: request.headers.get('Accept') || '*/*' } }));
  if (asset.status !== 200 || !asset.body) return asset;
  let body = asset.body;
  let size = Number(asset.headers.get('Content-Length') ?? NaN);
  if (!Number.isSafeInteger(size) || size <= 0) {
    // No declared length (chunked): buffer once to learn the size. Videos are a few MB.
    const buffer = await asset.arrayBuffer();
    size = buffer.byteLength;
    body = new Blob([buffer]).stream();
  }
  const headers = new Headers(asset.headers);
  headers.set('Content-Length', String(size));
  headers.set('Accept-Ranges', 'bytes');
  const parsed = parseRange(range, size);
  if (parsed === null) {
    if (request.method === 'HEAD') { body.cancel().catch(() => {}); return new Response(null, { status: 200, headers }); }
    return new Response(body, { status: 200, headers });
  }
  if (parsed === 'unsatisfiable') {
    body.cancel().catch(() => {});
    headers.set('Content-Range', `bytes */${size}`);
    headers.delete('Content-Length');
    return new Response(null, { status: 416, headers });
  }
  const { start, end } = parsed;
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  if (request.method === 'HEAD') { body.cancel().catch(() => {}); return new Response(null, { status: 206, headers }); }
  return new Response(sliceStream(body, start, end), { status: 206, headers });
}

export async function serveSite(request, env, url) {
  if (API_HOSTS.has(url.hostname)) {
    const target = url.pathname === '/' ? '/leaderboard' : url.pathname;
    return new Response(null, { status: 301, headers: { Location: SITE_ORIGIN + target + url.search, 'Cache-Control': 'public, max-age=86400' } });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });
  }
  const asset = isRangedMedia(url.pathname) ? await serveRangedMedia(request, env) : await env.ASSETS.fetch(request);
  const response = new Response(asset.body, asset);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  if (asset.status === 200 || asset.status === 206 || asset.status === 304) response.headers.set('Cache-Control', cacheControl(url.pathname));
  return response;
}
