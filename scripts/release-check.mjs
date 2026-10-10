/** Validate version consistency and refuse unsigned release builds. Never print secrets. */
import { appendFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function validateVersions(versions, tag) {
  const first = versions[0]?.version;
  if (!first || !semver.test(first)) throw new Error('The application version must be a valid SemVer.');
  for (const { file, version } of versions) {
    if (version !== first) throw new Error(`Version mismatch: ${file} is ${version ?? 'unset'}, expected ${first}.`);
  }
  if (tag && tag !== `v${first}`) throw new Error(`Release tag must be v${first}; received ${tag}.`);
  return first;
}

export function tomlVersion(contents, section) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\[${escaped}\\][ \\t]*(?:\\r?\\n|$)`, 'm').exec(contents);
  if (!header) throw new Error(`Missing TOML section [${section}].`);
  const remaining = contents.slice(header.index + header[0].length);
  const nextSection = /^\[/m.exec(remaining);
  const body = nextSection ? remaining.slice(0, nextSection.index) : remaining;
  if (/^version\.workspace\s*=\s*true\s*$/m.test(body)) return 'workspace';
  return /^version\s*=\s*"([^"]+)"/m.exec(body)?.[1];
}

export function validateSigning(config, env) {
  if (!env.TAURI_SIGNING_PRIVATE_KEY?.trim()) {
    throw new Error('Release signing is required. Configure the TAURI_SIGNING_PRIVATE_KEY repository secret; set TAURI_SIGNING_PRIVATE_KEY_PASSWORD if the key is password protected.');
  }
  if (config.bundle?.createUpdaterArtifacts !== true) throw new Error('bundle.createUpdaterArtifacts must be true for signed releases.');
  const updater = config.plugins?.updater;
  const pubkey = updater?.pubkey?.trim();
  if (!pubkey || !/^[A-Za-z0-9+/]+={0,2}$/.test(pubkey)) throw new Error('Configure the generated updater public key in plugins.updater.pubkey.');
  const decoded = Buffer.from(pubkey, 'base64').toString('utf8');
  if (!/^untrusted comment:/m.test(decoded) || !/^RW[A-Za-z0-9+/=]+$/m.test(decoded)) throw new Error('plugins.updater.pubkey must contain a Tauri/minisign public key, not a path or placeholder.');
  if (!updater.endpoints?.length || !updater.endpoints.every((endpoint) => {
    try { return new URL(endpoint).protocol === 'https:'; } catch { return false; }
  })) throw new Error('Configure HTTPS updater endpoints.');
  if (updater.dangerousInsecureTransportProtocol) throw new Error('Insecure updater transport is forbidden in releases.');
}

export async function checkRelease({ root = repositoryRoot, tag, requireSigning = false, env = process.env } = {}) {
  const versions = [];
  for (const file of ['package.json', 'apps/desktop/package.json', 'packages/core/package.json', 'apps/desktop/src-tauri/tauri.conf.json']) {
    const json = JSON.parse(await readFile(resolve(root, file), 'utf8'));
    versions.push({ file, version: json.version });
  }
  const workspace = tomlVersion(await readFile(resolve(root, 'Cargo.toml'), 'utf8'), 'workspace.package');
  versions.push({ file: 'Cargo.toml [workspace.package]', version: workspace });
  for (const file of ['apps/desktop/src-tauri/Cargo.toml', 'apps/supervisor/Cargo.toml', 'crates/runtime-core/Cargo.toml', 'crates/local-ipc/Cargo.toml', 'crates/update-verifier/Cargo.toml']) {
    const declared = tomlVersion(await readFile(resolve(root, file), 'utf8'), 'package');
    versions.push({ file, version: declared === 'workspace' ? workspace : declared });
  }
  const version = validateVersions(versions, tag);
  if (requireSigning) validateSigning(JSON.parse(await readFile(resolve(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')), env);
  return { version, prerelease: Boolean(semver.exec(version)?.[4]) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let tag = process.env.RELEASE_TAG;
  let requireSigning = false;
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--tag' && process.argv[index + 1]) tag = process.argv[++index];
    else if (process.argv[index] === '--require-signing') requireSigning = true;
    else throw new Error(`Unknown argument: ${process.argv[index]}`);
  }
  const result = await checkRelease({ tag, requireSigning });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${result.version}\nprerelease=${result.prerelease}\n`);
  console.log(`Version check passed: ${result.version}${tag ? ` (${tag})` : ''}${requireSigning ? '; signing configuration present' : ''}.`);
}
