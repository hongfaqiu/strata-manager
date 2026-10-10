/** Verify a draft release is complete before the workflow makes it public. */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

export function validateRelease(release, manifest, { repository, tag, version, expectedSha }) {
  if (release.tag_name !== tag || release.draft !== true) throw new Error('Expected a draft release for the exact requested tag.');
  if (expectedSha && release.target_commitish !== expectedSha) throw new Error('Release commit does not match the workflow commit.');
  if (manifest.version?.replace(/^v/, '') !== version) throw new Error('latest.json version does not match the application.');
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const suffix of ['.exe', '.exe.sig', '.AppImage', '.AppImage.sig', '.deb']) {
    if (![...assets.values()].some((asset) => asset.name.endsWith(suffix) && asset.size > 0)) throw new Error(`Missing nonempty release asset: ${suffix}`);
  }
  const required = { 'windows-x86_64': '.exe', 'linux-x86_64': '.AppImage' };
  const signatures = {};
  for (const [platform, suffix] of Object.entries(required)) {
    const update = manifest.platforms?.[platform];
    if (!update?.signature || update.signature.length < 40 || !update.url) throw new Error(`Incomplete updater entry: ${platform}`);
    const url = new URL(update.url);
    let asset;
    const downloadPrefix = `/${repository}/releases/download/${encodeURIComponent(tag)}/`;
    if (url.protocol === 'https:' && !url.search && !url.hash) {
      if (url.hostname === 'github.com' && url.pathname.startsWith(downloadPrefix)) {
        asset = assets.get(decodeURIComponent(url.pathname.slice(downloadPrefix.length)));
      } else if (url.hostname === 'api.github.com') {
        // Current official tauri-action uses release-asset API URLs. Membership
        // in this exact release is verified rather than guessing a download URL.
        asset = [...assets.values()].find((item) => url.pathname === `/repos/${repository}/releases/assets/${item.id}`);
      }
    }
    if (!asset) throw new Error(`Updater URL must target this exact repository and release: ${platform}`);
    const signature = assets.get(`${asset.name}.sig`);
    if (!asset.name.endsWith(suffix) || asset.size <= 0 || !signature || signature.size <= 0) throw new Error(`Updater asset or signature is missing: ${platform}`);
    signatures[platform] = signature;
  }
  return signatures;
}

function ghJson(path) {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
}
function downloadAsset(repository, asset) {
  return execFileSync('gh', ['api', `/repos/${repository}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}

export async function verifyRelease({ repository = process.env.GITHUB_REPOSITORY, tag = process.env.RELEASE_TAG, expectedSha = process.env.GITHUB_SHA } = {}) {
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !tag) throw new Error('GITHUB_REPOSITORY and RELEASE_TAG are required.');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(await readFile(resolve(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  const release = ghJson(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
  const manifestAsset = release.assets.find((asset) => asset.name === 'latest.json' && asset.size > 0);
  if (!manifestAsset) throw new Error('The official Tauri action did not upload latest.json.');
  const manifest = JSON.parse(downloadAsset(repository, manifestAsset));
  const signatures = validateRelease(release, manifest, { repository, tag, version, expectedSha });
  for (const [platform, signature] of Object.entries(signatures)) {
    const update = manifest.platforms[platform];
    if (downloadAsset(repository, signature).trim() !== update.signature.trim()) throw new Error(`latest.json signature does not match the uploaded .sig: ${platform}`);
  }
  console.log(`Draft release verified: ${tag}; Windows NSIS + Linux AppImage/DEB, signatures and updater entries are complete.`);
  console.log('Signature presence and manifest consistency are verified here; the installed updater also verifies the cryptographic signature.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await verifyRelease();
