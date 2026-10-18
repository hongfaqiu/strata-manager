import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'hongfaqiu/strata-manager';

// Reuse the browser's exact release/asset rules; do not maintain a second list
// of filenames or guess download URLs from the package version.
export async function loadWebsiteReleaseCatalog() {
  const source = await readFile(join(root, 'website', 'app.js'), 'utf8');
  const boundary = source.indexOf('// Website interactions.');
  if (boundary < 0) throw new Error('Website release catalog boundary is missing.');
  const catalog = runInNewContext(`${source.slice(0, boundary)}\nstrataReleaseCatalog;`, {}, { timeout: 1000 });
  if (catalog.repo !== repository) throw new Error('Website release catalog must use the expected repository.');
  return catalog;
}

export function createReleaseSnapshot(release, catalog, generatedAt = new Date().toISOString()) {
  const selected = catalog.select([release]);
  if (!selected) throw new Error('No valid published release is available for the website snapshot.');
  if (typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt))) throw new Error('Release snapshot timestamp is invalid.');
  const accepted = catalog.assets(selected);
  const downloadKeys = [...catalog.keys, ...(Array.isArray(catalog.optionalKeys) ? catalog.optionalKeys : [])];
  const urls = new Set(downloadKeys.map((key) => accepted[key]).filter(Boolean));
  return {
    schemaVersion: 1,
    generatedAt: new Date(generatedAt).toISOString(),
    release: {
      tag_name: selected.tag_name,
      draft: false,
      prerelease: selected.prerelease,
      published_at: selected.published_at,
      html_url: selected.html_url,
      assets: (Array.isArray(selected.assets) ? selected.assets : [])
        .filter((asset) => urls.has(asset?.browser_download_url)
          && Object.values(catalog.assets({ ...selected, assets: [asset] })).some((url) => urls.has(url)))
        .map((asset) => ({ name: asset.name, state: asset.state, size: asset.size, browser_download_url: asset.browser_download_url })),
    },
  };
}

export async function fetchReleaseSnapshot({ token, catalog, fetchImpl = fetch, generatedAt = new Date().toISOString() }) {
  if (!token?.trim()) throw new Error('Authenticated website release snapshots require GITHUB_TOKEN.');
  const base = `https://api.github.com/repos/${repository}/releases`;
  async function metadata(url, single) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token.trim()}`, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
    } catch (_) {
      // Never include request options or arbitrary network/body error text,
      // which could contain credentials, in a publication log.
      throw new Error(`Cannot fetch GitHub release metadata: ${single ? 'latest' : 'list'}.`);
    }
    if (single && response.status === 404) return { status: 404, releases: [] };
    if (response.status !== 200) throw new Error(`GitHub release metadata ${single ? 'latest' : 'list'} returned HTTP ${response.status}; refusing an incomplete website snapshot.`);
    let value;
    try { value = await response.json(); }
    catch (_) { throw new Error(`GitHub release metadata ${single ? 'latest' : 'list'} is not valid JSON.`); }
    if (single ? (!value || typeof value !== 'object' || Array.isArray(value)) : !Array.isArray(value)) {
      throw new Error(`GitHub release metadata ${single ? 'latest' : 'list'} has an unexpected shape.`);
    }
    return { status: 200, releases: single ? [value] : value };
  }
  const results = await Promise.allSettled([metadata(`${base}/latest`, true), metadata(`${base}?per_page=100`, false)]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  const selected = catalog.selectResponses(results[0].value, results[1].value);
  return createReleaseSnapshot(selected, catalog, generatedAt);
}

export async function publishWebsiteReleaseSnapshot(output, { env = process.env, fetchImpl = fetch, generatedAt = new Date().toISOString() } = {}) {
  const token = env.GITHUB_TOKEN?.trim();
  const input = env.WEBSITE_RELEASE_SNAPSHOT_INPUT?.trim();
  const ci = Boolean(env.CI && env.CI !== 'false');
  if (input && (ci || token)) throw new Error('Local release snapshot input is only allowed outside CI without GITHUB_TOKEN.');
  if (!token && !input) {
    if (ci) throw new Error('CI website publication requires GITHUB_TOKEN for a current release snapshot.');
    return null;
  }
  const catalog = await loadWebsiteReleaseCatalog();
  let snapshot;
  if (input) {
    let value;
    try { value = JSON.parse(await readFile(resolve(input), 'utf8')); }
    catch (_) { throw new Error('Cannot read a valid JSON local release snapshot.'); }
    if (value?.schemaVersion !== 1) throw new Error('Local release snapshot schemaVersion must be 1.');
    if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) throw new Error('Local release snapshot generatedAt is invalid.');
    snapshot = createReleaseSnapshot(value.release, catalog, value.generatedAt);
  } else {
    snapshot = await fetchReleaseSnapshot({ token, catalog, fetchImpl, generatedAt });
  }
  await writeFile(join(output, 'release-catalog.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}
