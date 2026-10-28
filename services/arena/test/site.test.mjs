import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { cacheControl, isRangedMedia, parseRange, SITE_ORIGIN } from '../src/site.js';

// A stand-in for the Workers static assets binding: records what it served.
function assets() {
  const served = [];
  return {
    served,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      served.push(pathname);
      if (pathname === '/missing') return new Response('<h1>404</h1>', { status: 404, headers: { 'Content-Type': 'text/html' } });
      return new Response(`asset ${pathname}`, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"x"', 'Cache-Control': 'public, max-age=0, must-revalidate' } });
    },
  };
}
const env = (extra = {}) => ({ ASSETS: assets(), POW_BITS: '8', ...extra });
const get = (url, init) => worker.fetch(new Request(url, init), init?.env ?? env(), { waitUntil() {} });

test('the API answers identically on both hosts and never reaches the assets', async () => {
  for (const host of ['https://arena.cosfoc.com', SITE_ORIGIN]) {
    const e = env();
    const health = await worker.fetch(new Request(`${host}/v1/health`), e, { waitUntil() {} });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, schema: 1, consentVersion: 1, official: true });
    assert.equal(health.headers.get('access-control-allow-origin'), '*');
    const preflight = await worker.fetch(new Request(`${host}/v1/groups`, { method: 'OPTIONS' }), e, { waitUntil() {} });
    assert.equal(preflight.status, 204);
    const missing = await worker.fetch(new Request(`${host}/v1/nope`), e, { waitUntil() {} });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'not_found');
    assert.deepEqual(e.ASSETS.served, []);
  }
});

test('non-API paths on the API host redirect to the website, keeping path and query', async () => {
  const root = await get('https://arena.cosfoc.com/');
  assert.equal(root.status, 301);
  assert.equal(root.headers.get('location'), `${SITE_ORIGIN}/leaderboard`);
  const page = await get('https://arena.cosfoc.com/docs/changelog?x=1');
  assert.equal(page.headers.get('location'), `${SITE_ORIGIN}/docs/changelog?x=1`);
});

test('the website host serves assets with security headers and a per-type cache policy', async () => {
  const e = env();
  const home = await worker.fetch(new Request(`${SITE_ORIGIN}/`), e, { waitUntil() {} });
  assert.equal(home.status, 200);
  assert.equal(await home.text(), 'asset /');
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  assert.equal(home.headers.get('etag'), '"x"');
  const css = await worker.fetch(new Request(`${SITE_ORIGIN}/docs.css`), e, { waitUntil() {} });
  assert.match(css.headers.get('cache-control'), /max-age=600/);
  const missing = await worker.fetch(new Request(`${SITE_ORIGIN}/missing`), e, { waitUntil() {} });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('x-frame-options'), 'DENY');
  const post = await worker.fetch(new Request(`${SITE_ORIGIN}/leaderboard`, { method: 'POST' }), e, { waitUntil() {} });
  assert.equal(post.status, 405);
  assert.deepEqual(e.ASSETS.served, ['/', '/docs.css', '/missing']);
});

test('cache policy: HTML and data revalidate, static files are cached', () => {
  assert.equal(cacheControl('/leaderboard'), 'public, max-age=0, must-revalidate');
  assert.equal(cacheControl('/sitemap.xml'), 'public, max-age=0, must-revalidate');
  assert.match(cacheControl('/assets/screenshots/a.webp'), /max-age=86400/);
  assert.match(cacheControl('/vendor/gsap.min.js'), /max-age=604800/);
  assert.match(cacheControl('/arena-snapshot.json'), /max-age=300/);
});

test('without the assets binding (API-only deploys, tests) non-API paths keep the JSON 404', async () => {
  const response = await worker.fetch(new Request('https://arena.cosfoc.com/'), { POW_BITS: '8' }, { waitUntil() {} });
  assert.equal(response.status, 404);
});

test('videos answer byte ranges with 206 so Safari and iOS can play them', async () => {
  const bytes = new Uint8Array(1000).map((_, i) => i % 251);
  let chunked = false;
  const e = env({ ASSETS: { async fetch(request) {
    assert.equal(request.headers.get('Range'), null, 'the asset store is asked for the full file');
    assert.equal(request.method, 'GET');
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'video/mp4', ...(chunked ? {} : { 'Content-Length': String(bytes.length) }), ETag: '"v"' } });
  } } });
  const at = (range, method = 'GET') => worker.fetch(new Request(`${SITE_ORIGIN}/assets/video/intro.zh.mp4`, { method, headers: range ? { Range: range } : {} }), e, { waitUntil() {} });
  const whole = await at();
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal((await whole.arrayBuffer()).byteLength, 1000);
  assert.match(whole.headers.get('cache-control'), /max-age=86400/);
  const probe = await at('bytes=0-1');
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get('content-range'), 'bytes 0-1/1000');
  assert.equal(probe.headers.get('content-length'), '2');
  assert.deepEqual([...new Uint8Array(await probe.arrayBuffer())], [0, 1]);
  const middle = await at('bytes=300-');
  assert.equal(middle.headers.get('content-range'), 'bytes 300-999/1000');
  assert.deepEqual(new Uint8Array(await middle.arrayBuffer()), bytes.slice(300));
  const suffix = await at('bytes=-10');
  assert.equal(suffix.headers.get('content-range'), 'bytes 990-999/1000');
  assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), bytes.slice(990));
  const clamp = await at('bytes=995-5000');
  assert.equal(clamp.headers.get('content-range'), 'bytes 995-999/1000');
  const beyond = await at('bytes=1000-');
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get('content-range'), 'bytes */1000');
  const head = await at('bytes=0-99', 'HEAD');
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '100');
  const multi = await at('bytes=0-1,5-6');
  assert.equal(multi.status, 200, 'multiple ranges fall back to the whole file');
  assert.equal(multi.headers.get('x-frame-options'), 'DENY');
  chunked = true;
  const noLength = await at('bytes=10-19');
  assert.equal(noLength.headers.get('content-range'), 'bytes 10-19/1000');
  assert.deepEqual(new Uint8Array(await noLength.arrayBuffer()), bytes.slice(10, 20));
});

test('parseRange handles the single-range forms browsers send', () => {
  assert.equal(parseRange(null, 10), null);
  assert.equal(parseRange('bytes=-', 10), null);
  assert.deepEqual(parseRange('bytes=2-4', 10), { start: 2, end: 4 });
  assert.deepEqual(parseRange('bytes=-100', 10), { start: 0, end: 9 });
  assert.equal(parseRange('bytes=-0', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-2', 10), 'unsatisfiable');
  assert.equal(isRangedMedia('/assets/video/intro.en.mp4'), true);
  assert.equal(isRangedMedia('/assets/screenshots/a.webp'), false);
});
