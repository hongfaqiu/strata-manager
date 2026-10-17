import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { cacheControl, SITE_ORIGIN } from '../src/site.js';

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
    assert.deepEqual(await health.json(), { ok: true, schema: 1, consentVersion: 1 });
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
