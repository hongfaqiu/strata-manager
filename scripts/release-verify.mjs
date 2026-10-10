/** Verify this draft's installer bytes before the workflow makes it public. */
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { requireReleaseTagCommit } from './release-tag.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredPlatforms = { 'windows-x86_64': 'windows', 'linux-x86_64': 'appimage' };
const platformAliases = { 'windows-x86_64-nsis': 'windows-x86_64', 'linux-x86_64-appimage': 'linux-x86_64', 'linux-x86_64-deb': 'deb' };
const installerExtension = /\.(?:exe|msi|appimage|deb|rpm|dmg|pkg|msix|msixbundle|appx|appxbundle|zip|tar\.gz|tgz|tar\.xz)(?:\.sig)?$/i;
const supplementaryAsset = /^(?:LICENSE|LICENCE|COPYING|NOTICE|THIRD_PARTY_NOTICES|README|CHANGELOG|RELEASE_NOTES|CHECKSUMS|SHA\d+SUMS)(?:[._-].*)?$|\.(?:txt|md|pdf|png|jpe?g|webp|json|jsonl|sha(?:256|512)(?:sum)?|asc)$/i;

function assetIndex(release) {
  if (!Array.isArray(release.assets)) throw new Error('The release asset list is missing.');
  const assets = new Map(); const ids = new Set();
  for (const asset of release.assets) {
    if (typeof asset.name !== 'string' || !asset.name || /[\\/\x00-\x1f]/.test(asset.name) || asset.name === '.' || asset.name === '..' || !Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error('Release assets must have safe names, positive IDs and nonempty sizes.');
    if (assets.has(asset.name) || ids.has(asset.id)) throw new Error('Duplicate release asset name or ID.');
    assets.set(asset.name, asset); ids.add(asset.id);
  }
  return assets;
}

function referencedAsset(update, assets, repository, tag, platform) {
  if (typeof update?.signature !== 'string' || !update.signature || typeof update.url !== 'string') throw new Error(`Incomplete updater entry: ${platform}`);
  const url = new URL(update.url);
  let asset;
  const downloadPrefix = `/${repository}/releases/download/${encodeURIComponent(tag)}/`;
  if (url.protocol === 'https:' && !url.search && !url.hash && !url.username && !url.password && !url.port) {
    if (url.hostname === 'github.com' && url.pathname.startsWith(downloadPrefix)) {
      asset = assets.get(decodeURIComponent(url.pathname.slice(downloadPrefix.length)));
    } else if (url.hostname === 'api.github.com') {
      // Official tauri-action also uses API URLs; require membership by exact ID.
      asset = [...assets.values()].find(item => url.pathname === `/repos/${repository}/releases/assets/${item.id}`);
    }
  }
  if (!asset) throw new Error(`Updater URL must target this exact repository and release: ${platform}`);
  const signature = assets.get(`${asset.name}.sig`);
  if (!signature) throw new Error(`Updater signature is missing: ${platform}`);
  return { asset, signature, signatureText: update.signature };
}

function validateInstallerName(asset, kind, version, productName) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = { windows: '_x64-setup\\.exe', appimage: '_amd64\\.AppImage', deb: '_amd64\\.deb' }[kind];
  const match = new RegExp(`^(.+)_${escaped}${suffix}$`, 'i').exec(asset.name);
  // GitHub replaces spaces in Tauri's productName with dots. Linux package
  // names may use hyphens; all retain the same product, version and architecture.
  const product = value => value.toLowerCase().replace(/[ ._-]+/g, '');
  if (!match || product(match[1]) !== product(productName)) throw new Error(`Expected the current-version ${kind} installer for ${productName}: ${asset.name}`);
}

export function validateRelease(release, manifest, { repository, tag, version, expectedSha, tagCommitSha, productName = 'Strata Manager' }) {
  if (release.tag_name !== tag || release.draft !== true) throw new Error('Expected a draft release for the exact requested tag.');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedSha ?? '') || tagCommitSha !== expectedSha) throw new Error('The actual release tag does not match the workflow commit.');
  if (typeof manifest.version !== 'string' || manifest.version.replace(/^v/, '') !== version) throw new Error('latest.json version does not match the application.');
  const assets = assetIndex(release);
  if (!assets.has('latest.json')) throw new Error('Missing nonempty release asset: latest.json');
  if (!manifest.platforms || typeof manifest.platforms !== 'object' || Array.isArray(manifest.platforms)) throw new Error('Missing updater platforms.');
  const allowedPlatforms = new Set([...Object.keys(requiredPlatforms), ...Object.keys(platformAliases)]);
  for (const platform of Object.keys(manifest.platforms)) if (!allowedPlatforms.has(platform)) throw new Error(`Unsupported updater platform: ${platform}`);
  const updates = {};
  for (const [platform, kind] of Object.entries(requiredPlatforms)) {
    updates[platform] = referencedAsset(manifest.platforms[platform], assets, repository, tag, platform);
    validateInstallerName(updates[platform].asset, kind, version, productName);
  }
  const debs = [...assets.values()].filter(asset => asset.name.endsWith('.deb'));
  if (debs.length !== 1) throw new Error('Expected exactly one current-version .deb installer.');
  validateInstallerName(debs[0], 'deb', version, productName);
  const deb = { asset: debs[0], signature: assets.get(`${debs[0].name}.sig`) };
  for (const [platform, target] of Object.entries(platformAliases)) {
    if (!Object.hasOwn(manifest.platforms, platform)) continue;
    const alias = referencedAsset(manifest.platforms[platform], assets, repository, tag, platform);
    const expected = target === 'deb' ? deb : updates[target];
    if (alias.asset.id !== expected.asset.id || (target !== 'deb' && alias.signatureText !== expected.signatureText)) throw new Error(`Updater alias must reference its verified installer: ${platform}`);
    updates[platform] = alias;
  }
  const installers = [updates['windows-x86_64'].asset, updates['linux-x86_64'].asset, deb.asset];
  const allowedAssets = new Set(['latest.json', ...installers.flatMap(asset => [asset.name, `${asset.name}.sig`])]);
  for (const asset of assets.values()) {
    if (allowedAssets.has(asset.name)) continue;
    if (installerExtension.test(asset.name) || asset.name.endsWith('.sig') || !supplementaryAsset.test(asset.name)) throw new Error(`Unexpected release asset: ${asset.name}`);
  }
  return { updates, deb };
}

export function ghJson(path, { execute = execFileSync } = {}) {
  return JSON.parse(execute('gh', ['api', path], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30000, killSignal: 'SIGKILL' }));
}

export async function findDraftRelease(repository, tag, { fetchPage = ghJson, maxPages = 10 } = {}) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error('Release pagination must be bounded to 1–10 pages.');
  const matches = [];
  // The tag endpoint only finds published releases. Authenticated listReleases
  // includes drafts; scan until its last page to prove the exact tag is unique.
  for (let page = 1; page <= maxPages; page++) {
    const releases = await fetchPage(`/repos/${repository}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases) || releases.length > 100) throw new Error('Expected a release list of at most 100 entries.');
    for (const release of releases) {
      if (!release || typeof release !== 'object' || Array.isArray(release) || typeof release.tag_name !== 'string' || typeof release.draft !== 'boolean') throw new Error('Invalid release list entry: tag_name and draft are required.');
      if (release.tag_name !== tag) continue;
      matches.push(release);
      if (matches.length > 1) throw new Error('Duplicate releases for the exact requested tag.');
    }
    if (releases.length < 100) {
      if (!matches.length) throw new Error('No release found for the exact requested tag.');
      if (matches[0].draft !== true) throw new Error('Expected an unpublished draft release for the exact requested tag.');
      return matches[0];
    }
  }
  throw new Error('Release pagination limit reached before uniqueness could be verified.');
}
export async function downloadAssetToFile(repository, asset, destination, { spawnProcess = spawn, timeoutMs = 600000 } = {}) {
  const child = spawnProcess('gh', ['api', `/repos/${repository}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { if (stderr.length < 32768) stderr += chunk.toString('utf8').slice(0, 32768 - stderr.length); });
  let terminationError; let forceTimer; let rejectCompletion;
  const terminate = error => {
    if (terminationError) return;
    terminationError = error;
    try { child.kill(); } catch { /* The bounded force/stream close still runs. */ }
    forceTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* Never wait indefinitely for close. */ }
      child.stdout.destroy(error); child.stderr.destroy(); rejectCompletion(error);
    }, 1000);
  };
  const completion = new Promise((resolve, reject) => {
    rejectCompletion = reject;
    child.once('error', error => { terminate(error); reject(error); });
    child.once('close', code => terminationError ? reject(terminationError) : code === 0 ? resolve() : reject(new Error(`Release asset download failed (${code}): ${stderr.trim()}`)));
  });
  const timer = setTimeout(() => terminate(new Error('Release asset download timed out.')), timeoutMs);
  try {
    const transfer = pipeline(child.stdout, createWriteStream(destination, { flags: 'wx' })).catch(error => { terminate(error); throw error; });
    const results = await Promise.allSettled([transfer, completion]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    if ((await stat(destination)).size !== asset.size) throw new Error(`Downloaded asset size does not match GitHub metadata: ${asset.name}`);
  } finally { clearTimeout(timer); clearTimeout(forceTimer); }
}

async function limitedText(path, maximum, label) {
  if ((await stat(path)).size > maximum) throw new Error(`${label} is too large.`);
  return readFile(path, 'utf8');
}

async function cleanupOwnedDirectory(directory, parent) {
  const checked = await realpath(directory);
  if (checked !== directory || dirname(checked) !== parent || !basename(checked).startsWith('strata-release-verify-') || !(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error('Refusing unexpected release verification cleanup path.');
  await rm(checked, { recursive: true, force: true });
}

export async function verifyRelease({ repository = process.env.GITHUB_REPOSITORY, tag = process.env.RELEASE_TAG, expectedSha = process.env.GITHUB_SHA, root = repositoryRoot, verifierPath = process.env.UPDATE_VERIFIER_BIN, fetchRelease = ghJson, fetchTag = ghJson, fetchAsset = downloadAssetToFile, logger = console.log } = {}) {
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !tag) throw new Error('GITHUB_REPOSITORY and RELEASE_TAG are required.');
  if (!verifierPath) throw new Error('Build strata-update-verifier and set UPDATE_VERIFIER_BIN before publishing.');
  const configPath = resolve(root, 'apps/desktop/src-tauri/tauri.conf.json');
  const { version, productName } = JSON.parse(await readFile(configPath, 'utf8'));
  const release = await findDraftRelease(repository, tag, { fetchPage: fetchRelease });
  // target_commitish is only a creation hint when the tag already exists.
  // Resolve the exact tag ref, including annotated tags, for source identity.
  const tagCommitSha = await requireReleaseTagCommit(repository, tag, expectedSha, { fetchJson: fetchTag });
  const assets = assetIndex(release);
  const manifestAsset = assets.get('latest.json');
  if (!manifestAsset) throw new Error('The official Tauri action did not upload latest.json.');
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'strata-release-verify-'));
  try {
    const manifestPath = join(directory, 'latest.json');
    await fetchAsset(repository, manifestAsset, manifestPath);
    const manifest = JSON.parse(await limitedText(manifestPath, 1024 * 1024, 'latest.json'));
    const { updates, deb } = validateRelease(release, manifest, { repository, tag, version, expectedSha, tagCommitSha, productName });
    // An ordinary DEB without an updater entry needs its current-version name;
    // if a signature was uploaded, it must be genuine even without an alias.
    if (deb.signature && !updates['linux-x86_64-deb']) updates.deb = deb;
    const downloaded = new Set();
    for (const [platform, update] of Object.entries(updates)) {
      if (downloaded.has(update.asset.id)) continue;
      const signaturePath = join(directory, `signature-${update.signature.id}`);
      await fetchAsset(repository, update.signature, signaturePath);
      const signatureText = (await limitedText(signaturePath, 16384, 'Updater signature')).replace(/[\r\n]+$/, '');
      if (update.signatureText !== undefined && signatureText !== update.signatureText) throw new Error(`latest.json signature does not match the uploaded .sig: ${platform}`);
      const artifactPath = join(directory, `artifact-${update.asset.id}`);
      await fetchAsset(repository, update.asset, artifactPath);
      // The helper only reads public config, signature and payload. It reuses
      // Tauri's minisign-verify; all exposed entries must verify before publish.
      execFileSync(verifierPath, ['--config', configPath, '--signature', signaturePath, '--artifact', artifactPath, '--version', version, '--require-signed-version'], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32768 });
      downloaded.add(update.asset.id);
    }
    logger(`Draft release verified: ${tag}; both updater artifacts match the built-in public key, signed version and uploaded signatures.`);
  } finally {
    await cleanupOwnedDirectory(directory, parent);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await verifyRelease();
