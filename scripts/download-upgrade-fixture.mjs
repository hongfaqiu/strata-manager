/** Prepare the one pinned, signed Windows upgrade fixture on disposable GitHub CI. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireReleaseTagCommit } from './release-tag.mjs';
import { ghJson } from './release-verify.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = 'strata-upgrade-fixture-';
export const UPGRADE_FIXTURE = Object.freeze({
  repository: 'hongfaqiu/strata-manager', tag: 'v0.1.0-beta.2', version: '0.1.0-beta.2',
  commit: '0db2fea5128144fe2fe00cca992bd5139c831508', releaseId: 409177062,
  installer: Object.freeze({ id: 628882710, name: 'Strata.Manager_0.1.0-beta.2_x64-setup.exe', size: 6702725,
    sha256: '36c50b76cbeb1ba0d769c426b1d471cd2d6c790f3d46bc1740bb13041526830c' }),
  signature: Object.freeze({ id: 628882746, name: 'Strata.Manager_0.1.0-beta.2_x64-setup.exe.sig', size: 464,
    sha256: '71716ecf3c65fc662591c31a4e68b0d79ff8c8cf46e4794f726512c78625cffd' }),
});

const publicUrl = (fixture, asset) => `https://github.com/${fixture.repository}/releases/download/${fixture.tag}/${asset.name}`;
const apiUrl = path => `https://api.github.com${path}`;
function safePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || /["'`$\x00-\x1f\x7f;&|<>]/.test(value)) throw new Error(`A shell-safe absolute ${label} is required.`);
}

export function validateUpgradeRelease(repository, release, fixture = UPGRADE_FIXTURE) {
  if (!repository || repository.full_name !== fixture.repository || repository.private !== false) throw new Error('Expected the fixed public fixture repository.');
  if (!release || release.id !== fixture.releaseId || release.tag_name !== fixture.tag || release.draft !== false || release.prerelease !== true
    || release.url !== apiUrl(`/repos/${fixture.repository}/releases/${fixture.releaseId}`)
    || release.html_url !== `https://github.com/${fixture.repository}/releases/tag/${fixture.tag}`) throw new Error('Expected the fixed published fixture release.');
  if (!Array.isArray(release.assets)) throw new Error('Fixture release asset list is missing.');
  const names = new Map(); const ids = new Set();
  for (const asset of release.assets) {
    if (!asset || typeof asset.name !== 'string' || !asset.name || /[\\/\x00-\x1f]/.test(asset.name)
      || !Number.isSafeInteger(asset.id) || asset.id <= 0 || names.has(asset.name) || ids.has(asset.id)) throw new Error('Invalid or duplicate fixture release assets.');
    names.set(asset.name, asset); ids.add(asset.id);
  }
  for (const expected of [fixture.installer, fixture.signature]) {
    const asset = names.get(expected.name);
    if (!asset || asset.id !== expected.id || asset.state !== 'uploaded' || asset.size !== expected.size
      || asset.digest !== `sha256:${expected.sha256}`
      || asset.url !== apiUrl(`/repos/${fixture.repository}/releases/assets/${expected.id}`)
      || asset.browser_download_url !== publicUrl(fixture, expected)) throw new Error('Pinned fixture asset identity, size, digest or URL does not match.');
  }
}

/** Public URL only: no gh token, Authorization header, or installer execution. */
export async function downloadPublicFixtureAsset(asset, destination, { fetchResponse = fetch } = {}) {
  const response = await fetchResponse(asset.url, {
    credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(120000),
  });
  const refuse = async message => {
    try { await response.body?.cancel(); } catch { /* Release the rejected transfer without exposing response data. */ }
    throw new Error(message);
  };
  if (response.status !== 200 || !response.body) return refuse('Public fixture asset download failed.');
  let finalUrl;
  try { finalUrl = new URL(response.url); }
  catch { return refuse('Unexpected public fixture download destination.'); }
  if (finalUrl.protocol !== 'https:' || finalUrl.username || finalUrl.password || finalUrl.port
    || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(finalUrl.hostname)) return refuse('Unexpected public fixture download destination.');
  const length = response.headers.get('content-length');
  if (length !== null && length !== String(asset.size)) return refuse('Public fixture Content-Length does not match.');
  let received = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) {
    received += chunk.length;
    if (received > asset.size) callback(new Error('Public fixture asset exceeds its pinned size.'));
    else callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(destination, { flags: 'wx' }));
}

async function validateBytes(path, asset) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.size) throw new Error('Downloaded fixture file type or size does not match.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== asset.sha256) throw new Error('Downloaded fixture SHA-256 does not match.');
}

async function cleanupOwned(directory, parent) {
  const info = await lstat(directory); const actual = await realpath(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || actual !== directory || dirname(actual) !== parent
    || !basename(actual).startsWith(prefix)) throw new Error('Refusing unexpected fixture cleanup path.');
  await rm(actual, { recursive: true, force: true });
}

function requireCi(env, platform) {
  if (platform !== 'win32' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_OS !== 'Windows'
    || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.GITHUB_REPOSITORY !== UPGRADE_FIXTURE.repository) throw new Error('Upgrade fixture preparation requires this repository on disposable Windows GitHub-hosted CI.');
  for (const key of ['RUNNER_TEMP', 'GITHUB_WORKSPACE', 'GITHUB_OUTPUT', 'UPDATE_VERIFIER_BIN']) safePath(env[key], key);
  if (basename(env.UPDATE_VERIFIER_BIN).toLowerCase() !== 'strata-update-verifier.exe') throw new Error('UPDATE_VERIFIER_BIN must be the built update verifier.');
}

/** Explicit dependency/byte-expectation injection is for tiny synthetic contracts;
 * the zero-argument CLI always uses the immutable real fixture above. */
export async function downloadUpgradeFixture({ env = process.env, platform = process.platform,
  fetchJson = ghJson, fetchAsset = downloadPublicFixtureAsset, execute = execFileSync,
  fixture = UPGRADE_FIXTURE, logger = console.log } = {}) {
  requireCi(env, platform);
  for (const key of ['repository', 'tag', 'version', 'commit', 'releaseId']) {
    if (fixture[key] !== UPGRADE_FIXTURE[key]) throw new Error('Fixture identity cannot be overridden.');
  }
  for (const key of ['installer', 'signature']) {
    if (fixture[key]?.id !== UPGRADE_FIXTURE[key].id || fixture[key]?.name !== UPGRADE_FIXTURE[key].name
      || !Number.isSafeInteger(fixture[key].size) || fixture[key].size < 1 || fixture[key].size > UPGRADE_FIXTURE[key].size
      || !/^[0-9a-f]{64}$/.test(fixture[key].sha256)) throw new Error('Invalid fixture byte expectations.');
  }
  const runnerInfo = await lstat(env.RUNNER_TEMP);
  if (!runnerInfo.isDirectory() || runnerInfo.isSymbolicLink()) throw new Error('RUNNER_TEMP must be a real directory.');
  const parent = await realpath(env.RUNNER_TEMP);
  safePath(parent, 'canonical RUNNER_TEMP');
  const outputInfo = await lstat(env.GITHUB_OUTPUT); const output = await realpath(env.GITHUB_OUTPUT);
  const outputRelative = relative(parent, output);
  safePath(output, 'canonical GITHUB_OUTPUT');
  if (!outputInfo.isFile() || outputInfo.isSymbolicLink() || outputInfo.size > 65536 || !outputRelative
    || outputRelative === '..' || outputRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(outputRelative)) throw new Error('GITHUB_OUTPUT must be a regular runner-temp file.');
  if (/^(?:installer|version)=/m.test(await readFile(output, 'utf8'))) throw new Error('This step already prepared its upgrade fixture.');
  const verifierInfo = await lstat(env.UPDATE_VERIFIER_BIN);
  if (!verifierInfo.isFile() || verifierInfo.isSymbolicLink()) throw new Error('The built update verifier is missing or is not a regular file.');
  const configPath = join(repositoryRoot, 'apps/desktop/src-tauri/tauri.conf.json');
  safePath(configPath, 'current application config');
  const checkedJson = async path => {
    try { return await fetchJson(path); }
    catch { throw new Error('GitHub fixture metadata could not be read.'); }
  };
  const repository = await checkedJson(`/repos/${fixture.repository}`);
  await requireReleaseTagCommit(fixture.repository, fixture.tag, fixture.commit, { fetchJson: checkedJson });
  const release = await checkedJson(`/repos/${fixture.repository}/releases/${fixture.releaseId}`);
  validateUpgradeRelease(repository, release, fixture);
  const directory = await mkdtemp(join(parent, prefix));
  try {
    for (const asset of [fixture.signature, fixture.installer]) {
      const path = join(directory, asset.name);
      try { await fetchAsset({ ...asset, url: publicUrl(fixture, asset) }, path); }
      catch { throw new Error('Public fixture asset transfer failed.'); }
      await validateBytes(path, asset);
    }
    const installer = join(directory, fixture.installer.name);
    try {
      await execute(env.UPDATE_VERIFIER_BIN, ['--config', configPath, '--signature', join(directory, fixture.signature.name),
        '--artifact', installer, '--version', fixture.version, '--require-signed-version'], {
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 32768,
      });
    } catch { throw new Error('Pinned fixture signature or signed version verification failed.'); }
    await requireReleaseTagCommit(fixture.repository, fixture.tag, fixture.commit, { fetchJson: checkedJson });
    safePath(installer, 'verified installer output');
    const finalOutput = await lstat(output);
    if (!finalOutput.isFile() || finalOutput.isSymbolicLink() || finalOutput.dev !== outputInfo.dev
      || finalOutput.ino !== outputInfo.ino || finalOutput.size !== outputInfo.size) throw new Error('GITHUB_OUTPUT changed during fixture preparation.');
    logger('Pinned Windows upgrade fixture verified.');
    await appendFile(output, `installer=${installer}\nversion=${fixture.version}\n`, 'utf8');
    return { installer, version: fixture.version };
  } catch (error) {
    await cleanupOwned(directory, parent);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('This fixed CI helper takes no arguments.');
    await downloadUpgradeFixture();
  } catch (error) {
    console.error(`Upgrade fixture preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
