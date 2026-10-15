import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { createReleaseSnapshot, fetchReleaseSnapshot, loadWebsiteReleaseCatalog, publishWebsiteReleaseSnapshot } from './website-release-snapshot.mjs';

const catalog = await loadWebsiteReleaseCatalog();
const generatedAt = '2026-10-12T00:00:00.000Z';
const base = 'https://github.com/hongfaqiu/strata-manager/releases';
function release(tag = 'v0.1.2', overrides = {}) {
  const version = tag.slice(1);
  const names = [`Strata.Manager_${version}_x64-setup.exe`, `Strata.Manager_${version}_amd64.AppImage`, `Strata.Manager_${version}_amd64.deb`, 'SHA256SUMS'];
  return {
    tag_name: tag, draft: false, prerelease: version.includes('-'), published_at: '2026-10-11T21:00:00Z', html_url: `${base}/tag/${tag}`,
    author: { login: 'not-needed' }, body: 'Not needed in a download snapshot', node_id: 'not-needed', token: 'must-not-be-published',
    assets: names.map((name) => ({ name, state: 'uploaded', size: 100, browser_download_url: `${base}/download/${tag}/${name}`, uploader: { login: 'not-needed' } })),
    ...overrides,
  };
}
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('authenticated snapshot requests the two exact repository endpoints and publishes only minimal public fields', async () => {
  const selected = release();
  const requests = [];
  const snapshot = await fetchReleaseSnapshot({ token: 'test-credential', catalog, generatedAt, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(url.endsWith('/latest') ? selected : [selected, release('v9.0.0-beta.1')]);
  } });
  assert.deepEqual(requests.map((request) => request.url).sort(), ['https://api.github.com/repos/hongfaqiu/strata-manager/releases/latest', 'https://api.github.com/repos/hongfaqiu/strata-manager/releases?per_page=100'].sort());
  assert.ok(requests.every((request) => request.options.headers.Authorization === 'Bearer test-credential'));
  assert.deepEqual(Object.keys(snapshot), ['schemaVersion', 'generatedAt', 'release']);
  assert.deepEqual(Object.keys(snapshot.release), ['tag_name', 'draft', 'prerelease', 'published_at', 'html_url', 'assets']);
  assert.equal(snapshot.generatedAt, generatedAt);
  assert.equal(snapshot.release.tag_name, 'v0.1.2');
  assert.equal(snapshot.release.assets.length, 4);
  for (const asset of snapshot.release.assets) assert.deepEqual(Object.keys(asset), ['name', 'state', 'size', 'browser_download_url']);
  assert.doesNotMatch(JSON.stringify(snapshot), /test-credential|must-not-be-published|not-needed|Authorization|uploader|body|author/);
  assert.equal(Object.keys(catalog.assets(snapshot.release)).length, 5);
  assert.equal(catalog.assets(snapshot.release).dmg, undefined);
});

test('an uploaded Apple Silicon DMG is kept in the public snapshot and a missing DMG is omitted', async () => {
  const selected = release();
  const name = 'Strata.Manager_0.1.2_aarch64.dmg';
  const url = `${base}/download/v0.1.2/${name}`;
  selected.assets.push({ name, state: 'uploaded', size: 100, browser_download_url: url, uploader: { login: 'not-needed' } });
  const snapshot = await fetchReleaseSnapshot({ token: 'test-credential', catalog, generatedAt, fetchImpl: async (requestUrl) => jsonResponse(requestUrl.endsWith('/latest') ? selected : [selected]) });
  assert.equal(snapshot.release.assets.length, 5);
  assert.equal(snapshot.release.assets.some((asset) => asset.name === name && asset.browser_download_url === url), true);
  assert.equal(catalog.assets(snapshot.release).dmg, url);
  const without = createReleaseSnapshot(release(), catalog, generatedAt);
  assert.equal(without.release.assets.length, 4);
  assert.equal(catalog.assets(without.release).dmg, undefined);
});

test('rate limits, unexpected HTTP responses and network failures fail publication without logging secret response text', async () => {
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(fetchReleaseSnapshot({ token: 'hidden', catalog, fetchImpl: async (url) => jsonResponse(url.endsWith('/latest') ? { message: 'hidden server detail' } : [release()], url.endsWith('/latest') ? status : 200) }), (error) => error.message.includes(`HTTP ${status}`) && !error.message.includes('hidden'));
  }
  await assert.rejects(fetchReleaseSnapshot({ token: 'hidden', catalog, fetchImpl: async () => { throw new Error('hidden request details'); } }), (error) => error.message.includes('Cannot fetch') && !error.message.includes('hidden'));
  await assert.rejects(fetchReleaseSnapshot({ token: 'hidden', catalog, fetchImpl: async (url) => jsonResponse(url.endsWith('/latest') ? release() : { error: 'not a release list' }) }), /unexpected shape/);
  await assert.rejects(fetchReleaseSnapshot({ token: 'hidden', catalog, fetchImpl: async (url) => jsonResponse(url.endsWith('/latest') ? {} : []) }), /No valid published release/);
});

test('explicit latest 404 allows verified preview fallback; a successful stable endpoint keeps previews out', async () => {
  const previews = [release('v0.2.0-beta.2'), release('v0.2.0-beta.10')];
  const preview = await fetchReleaseSnapshot({ token: 'test', catalog, generatedAt, fetchImpl: async (url) => url.endsWith('/latest') ? jsonResponse({}, 404) : jsonResponse(previews) });
  assert.equal(preview.release.tag_name, 'v0.2.0-beta.10');
  const stable = await fetchReleaseSnapshot({ token: 'test', catalog, generatedAt, fetchImpl: async (url) => jsonResponse(url.endsWith('/latest') ? release() : previews) });
  assert.equal(stable.release.tag_name, 'v0.1.2');
});

test('partial releases retain only exact valid assets and leave missing or ambiguous downloads absent', () => {
  const selected = release();
  const windows = selected.assets[0];
  selected.assets = [
    windows,
    { ...windows, name: 'unrelated.exe' }, // Same URL is insufficient without the exact name.
    { ...windows, size: 0 },
    { ...windows, state: 'new' },
    { ...selected.assets[1], browser_download_url: selected.assets[1].browser_download_url.replace('hongfaqiu', 'foreign') },
    selected.assets[2], selected.assets[2], // Duplicates remain disabled, as in the browser.
    { ...selected.assets[3], state: 'new' },
    { name: 'private-debug.txt', state: 'uploaded', size: 1, browser_download_url: `${base}/download/v0.1.2/private-debug.txt` },
  ];
  const snapshot = createReleaseSnapshot(selected, catalog, generatedAt);
  assert.equal(snapshot.release.assets.length, 1);
  assert.equal(snapshot.release.assets[0].name, windows.name);
  const urls = catalog.assets(snapshot.release);
  assert.equal(urls.windows, windows.browser_download_url);
  for (const key of ['appimage', 'deb', 'checksums']) assert.equal(urls[key], undefined);
});

test('local builds skip without credentials; explicit local input is revalidated and forbidden in CI', async () => {
  const output = await mkdtemp(join(tmpdir(), 'strata-release-snapshot-'));
  const input = join(output, 'input.json');
  try {
    assert.equal(await publishWebsiteReleaseSnapshot(output, { env: {} }), null);
    await assert.rejects(access(join(output, 'release-catalog.json')), /ENOENT/);
    await writeFile(input, JSON.stringify({ schemaVersion: 1, generatedAt, release: release() }));
    let networkCalls = 0;
    const snapshot = await publishWebsiteReleaseSnapshot(output, { env: { WEBSITE_RELEASE_SNAPSHOT_INPUT: input }, fetchImpl: async () => { networkCalls++; throw new Error('unexpected network'); } });
    assert.equal(networkCalls, 0);
    assert.equal(snapshot.generatedAt, generatedAt);
    assert.equal(JSON.parse(await readFile(join(output, 'release-catalog.json'), 'utf8')).release.assets.length, 4);
    await assert.rejects(publishWebsiteReleaseSnapshot(output, { env: { CI: 'true', WEBSITE_RELEASE_SNAPSHOT_INPUT: input } }), /only allowed outside CI/);
    await assert.rejects(publishWebsiteReleaseSnapshot(output, { env: { GITHUB_TOKEN: 'test', WEBSITE_RELEASE_SNAPSHOT_INPUT: input } }), /only allowed outside CI/);
    await assert.rejects(publishWebsiteReleaseSnapshot(output, { env: { CI: 'true' } }), /requires GITHUB_TOKEN/);
    await writeFile(input, JSON.stringify({ schemaVersion: 1, release: release() }));
    await assert.rejects(publishWebsiteReleaseSnapshot(output, { env: { WEBSITE_RELEASE_SNAPSHOT_INPUT: input } }), /generatedAt is invalid/);
    await writeFile(input, JSON.stringify({ schemaVersion: 1, generatedAt, release: release('v0.1.2', { draft: true }) }));
    await assert.rejects(publishWebsiteReleaseSnapshot(output, { env: { WEBSITE_RELEASE_SNAPSHOT_INPUT: input } }), /No valid published release/);
  } finally {
    assert.ok(resolve(output).startsWith(resolve(tmpdir()) + sep));
    await rm(output, { recursive: true, force: true });
  }
});
