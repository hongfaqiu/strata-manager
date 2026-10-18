import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../website/app.js', import.meta.url), 'utf8');
const marker = '// Website interactions.';
assert.ok(source.includes(marker), 'the actual release catalog must precede website interactions');
const catalog = runInNewContext(`${source.split(marker)[0]}\nstrataReleaseCatalog;`);
const base = 'https://github.com/hongfaqiu/strata-manager/releases';
function release(tag, overrides = {}) {
  const clean = tag.slice(1);
  const names = [`Strata.Manager_${clean}_x64-setup.exe`, `Strata.Manager_${clean}_amd64.AppImage`, `Strata.Manager_${clean}_amd64.deb`, 'SHA256SUMS'];
  return {
    tag_name: tag, draft: false, prerelease: clean.includes('-'),
    published_at: '2026-10-10T20:25:24Z', html_url: `${base}/tag/${tag}`,
    assets: names.map(name => ({ name, state: 'uploaded', size: 123, browser_download_url: `${base}/download/${tag}/${name}` })),
    ...overrides,
  };
}

test('highest stable SemVer wins over a newer preview or newly published older version', () => {
  const selected = catalog.select([release('v9.0.0-beta.1'), release('v0.9.0'), release('v0.10.0'), release('v0.1.0', { published_at: '2027-01-01T00:00:00Z' })]);
  assert.equal(selected.tag_name, 'v0.10.0');
});

test('no stable release permits an explicit preview fallback ordered by SemVer', () => {
  assert.equal(catalog.select([release('v0.1.0-beta.2'), release('v0.1.0-beta.10')]).tag_name, 'v0.1.0-beta.10');
  assert.equal(catalog.select([release('v0.1.0-beta.2')], false), null);
});

test('drafts, unpublished releases, invalid versions, mismatched preview flags and foreign releases are rejected', () => {
  for (const invalid of [
    release('v0.1.0', { draft: true }), release('v0.1.0', { published_at: null }),
    release('v01.0.0'), release('v0.1.0-beta.01'), release('v0.1.0', { prerelease: true }),
    release('v0.1.0-beta.2', { prerelease: false }),
    release('v0.1.0', { html_url: 'https://github.com/other/strata-manager/releases/tag/v0.1.0' }),
  ]) assert.equal(catalog.select([invalid]), null);
});

test('stable endpoint prevents falling back merely because the bounded list contains only previews', () => {
  const stable = release('v0.1.0');
  const previews = { status: 200, releases: [release('v9.0.0-beta.2')] };
  assert.equal(catalog.selectResponses({ status: 200, releases: [stable] }, previews).tag_name, 'v0.1.0');
  assert.equal(catalog.selectResponses({ status: 404, releases: [] }, previews).prerelease, true);
  for (const latest of [null, { status: 403, releases: [] }, { status: 500, releases: [] }, { status: 200, releases: [] }]) {
    assert.equal(catalog.selectResponses(latest, previews), null);
  }
  assert.equal(catalog.selectResponses(null, { status: 200, releases: [stable] }).tag_name, 'v0.1.0');
  assert.equal(catalog.selectResponses({ status: 404, releases: [] }, { status: 500, releases: previews.releases }), null);
});

test('downloads use exact versioned assets actually returned by this repository', () => {
  const value = catalog.assets(release('v0.1.0'));
  assert.equal(value.windows, `${base}/download/v0.1.0/Strata.Manager_0.1.0_x64-setup.exe`);
  assert.equal(value.checksums, `${base}/download/v0.1.0/SHA256SUMS`);
  assert.equal(Object.keys(value).length, 5);
});

test('missing assets have no guessed URL and a partial release remains visibly incomplete', () => {
  const complete = release('v0.1.0');
  const value = catalog.assets({ ...complete, assets: [complete.assets[0]] });
  assert.equal(value.windows, complete.assets[0].browser_download_url);
  for (const key of ['appimage', 'deb', 'checksums']) assert.equal(value[key], undefined);
  assert.equal(Object.keys(catalog.assets({ ...complete, assets: [] })).length, 1);
});

test('foreign, wrong-version, encoded, credentialed or ambiguous asset URLs fail closed', () => {
  const complete = release('v0.1.0');
  const asset = complete.assets[0];
  for (const url of [
    asset.browser_download_url.replace('/hongfaqiu/', '/foreign/'),
    asset.browser_download_url.replace('/v0.1.0/', '/v0.2.0/'),
    asset.browser_download_url.replace('github.com/', 'github.com.evil.invalid/'),
    asset.browser_download_url.replace('https://', 'https://user@'),
    `${asset.browser_download_url}?redirect=other`, `${asset.browser_download_url}#fragment`,
    asset.browser_download_url.replace('/download/', '/%64ownload/'),
  ]) assert.equal(catalog.assets({ ...complete, assets: [{ ...asset, browser_download_url: url }] }).windows, undefined);
  assert.equal(catalog.assets({ ...complete, assets: [asset, asset] }).windows, undefined);
  assert.equal(catalog.assets({ ...complete, assets: [{ ...asset, size: 0 }] }).windows, undefined);
  assert.equal(catalog.assets({ ...complete, assets: [{ ...asset, state: 'new' }] }).windows, undefined);
  assert.equal(catalog.assets({ ...complete, assets: [{ ...asset, name: 'another-setup.exe' }] }).windows, undefined);
});

test('missing downloads remove stale hrefs and leave keyboard and accessibility disabled state', () => {
  const elements = Object.fromEntries(catalog.keys.map(key => [key, {
    attributes: new Map([['href', 'https://old.invalid/package']]),
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
  }]));
  const urls = catalog.assets(release('v0.1.0'));
  catalog.applyDownloads(elements, {});
  for (const element of Object.values(elements)) {
    assert.equal(element.attributes.has('href'), false);
    assert.equal(element.attributes.get('aria-disabled'), 'true');
    assert.equal(element.attributes.get('tabindex'), '-1');
  }
  catalog.applyDownloads(elements, urls);
  for (const [key, element] of Object.entries(elements)) {
    assert.equal(element.attributes.get('href'), urls[key]);
    assert.equal(element.attributes.has('aria-disabled'), false);
    assert.equal(element.attributes.has('tabindex'), false);
  }
  catalog.applyDownloads(elements, { windows: urls.windows });
  assert.equal(elements.deb.attributes.has('href'), false);
});

test('initial HTML disables every asset download until metadata is verified', () => {
  const html = readFileSync(new URL('../website/index.html', import.meta.url), 'utf8');
  const anchors = [...html.matchAll(/<a\b[^>]*data-download="([^"]+)"[^>]*>/g)];
  assert.equal(anchors.length, 5);
  for (const [tag] of anchors) {
    assert.doesNotMatch(tag, /\bhref=/);
    assert.match(tag, /aria-disabled="true"/);
    assert.match(tag, /tabindex="-1"/);
  }
  assert.match(html, /id="download-status"[^>]*role="status"[^>]*aria-live="polite"/);
});
