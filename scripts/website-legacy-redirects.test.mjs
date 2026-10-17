import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { buildLegacyRedirects, redirectPage } from './build-legacy-redirects.mjs';

const scriptOf = (html) => /<script>([\s\S]*?)<\/script>/.exec(html)[1];
function run(html, href) {
  const url = new URL(href);
  let replaced;
  vm.runInNewContext(scriptOf(html), { location: { pathname: url.pathname, search: url.search, hash: url.hash, replace: (to) => { replaced = to; } } });
  return replaced;
}

test('every old GitHub Pages page redirects to its clean URL on the new domain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'strata-legacy-'));
  try {
    const site = join(dir, 'site'), out = join(dir, 'out');
    await mkdir(join(site, 'docs'), { recursive: true });
    await mkdir(join(site, 'en'), { recursive: true });
    for (const page of ['index.html', 'en/index.html', 'leaderboard.html', 'docs/index.html', 'docs/changelog.en.html', '404.html']) await writeFile(join(site, page), '<!doctype html>');
    const pages = await buildLegacyRedirects(site, out);
    assert.deepEqual(pages, ['docs/changelog.en.html', 'docs/index.html', 'en/index.html', 'index.html', 'leaderboard.html']);
    const expect = { 'index.html': 'https://strata-manager.cosfoc.com/', 'en/index.html': 'https://strata-manager.cosfoc.com/en/', 'leaderboard.html': 'https://strata-manager.cosfoc.com/leaderboard', 'docs/index.html': 'https://strata-manager.cosfoc.com/docs/', 'docs/changelog.en.html': 'https://strata-manager.cosfoc.com/docs/changelog.en' };
    for (const [page, target] of Object.entries(expect)) {
      const html = await readFile(join(out, page), 'utf8');
      assert.ok(html.includes(`<link rel="canonical" href="${target}">`), page);
      assert.ok(html.includes(`<meta http-equiv="refresh" content="0; url=${target}">`), page);
      assert.equal(run(html, `https://hongfaqiu.github.io/strata-manager/${page}?lang=en#get-started`), `${target}?lang=en#get-started`);
    }
    const notFound = await readFile(join(out, '404.html'), 'utf8');
    assert.equal(run(notFound, 'https://hongfaqiu.github.io/strata-manager/docs/user-guide.html#start'), 'https://strata-manager.cosfoc.com/docs/user-guide#start');
    assert.equal(run(notFound, 'https://hongfaqiu.github.io/strata-manager/assets/icon.svg'), 'https://strata-manager.cosfoc.com/assets/icon.svg');
    assert.match(await readFile(join(out, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/strata-manager\.cosfoc\.com\/sitemap\.xml/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('redirect pages escape their target', () => {
  assert.ok(redirectPage('https://example.com/?a="b"').includes('href="https://example.com/?a=&quot;b&quot;"'));
});
