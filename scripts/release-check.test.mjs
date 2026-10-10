import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRelease, tomlVersion, validateSigning, validateVersions } from './release-check.mjs';
import { validateRelease } from './release-verify.mjs';

test('all workspace versions agree', async () => {
  const { version } = await checkRelease();
  assert.match(version, /^\d+\.\d+\.\d+/);
});
test('a tag or Rust package drift cannot release the wrong version', () => {
  assert.throws(() => validateVersions([{ file: 'app', version: '0.1.0' }], 'v0.2.0'), /Release tag/);
  assert.throws(() => validateVersions([{ file: 'app', version: '0.1.0' }, { file: 'daemon', version: '0.2.0' }]), /Version mismatch/);
  assert.throws(() => validateVersions([{ file: 'app', version: '0.1.0-01' }]), /SemVer/);
  assert.equal(validateVersions([{ file: 'app', version: '0.1.0-beta.1' }], 'v0.1.0-beta.1'), '0.1.0-beta.1');
});
test('TOML lookup respects package sections and workspace inheritance', () => {
  assert.equal(tomlVersion('[package]\nname="daemon"\nversion.workspace = true\n\n[dependencies]\nversion="9.9.9"', 'package'), 'workspace');
  assert.equal(tomlVersion('[workspace]\nmembers=[]\n\n[workspace.package]\nversion = "0.1.0"\nedition="2021"\n', 'workspace.package'), '0.1.0');
});
test('release signing fails closed without exposing secret values', () => {
  const pubkey = Buffer.from('untrusted comment: minisign public key\nRWtestKey1234567890==\n').toString('base64');
  const config = { bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey, endpoints: ['https://github.com/example/app/releases/latest/download/latest.json'] } } };
  const env = { TAURI_SIGNING_PRIVATE_KEY: 'test-secret', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'test-password' };
  assert.doesNotThrow(() => validateSigning(config, env));
  assert.doesNotThrow(() => validateSigning(config, { TAURI_SIGNING_PRIVATE_KEY: 'test-secret' }));
  assert.throws(() => validateSigning(config, {}), /signing is required/);
  assert.throws(() => validateSigning({ ...config, bundle: {} }, env), /createUpdaterArtifacts/);
  assert.throws(() => validateSigning({ ...config, plugins: { updater: { ...config.plugins.updater, endpoints: ['http://localhost/latest.json'] } } }, env), /HTTPS/);
  assert.throws(() => validateSigning({ ...config, plugins: { updater: { ...config.plugins.updater, pubkey: 'placeholder' } } }, env), /public key/);
});
test('a partial, foreign or unsigned release stays a draft', () => {
  const repository = 'example/strata-manager';
  const tag = 'v0.1.0';
  const assets = ['windows.exe', 'windows.exe.sig', 'linux.AppImage', 'linux.AppImage.sig', 'linux.deb'].map((name, id) => ({ name, id: id + 1, size: 100 }));
  const release = { tag_name: tag, draft: true, target_commitish: '123', assets };
  const manifest = { version: '0.1.0', platforms: Object.fromEntries([['windows-x86_64', 'windows.exe'], ['linux-x86_64', 'linux.AppImage']].map(([platform, name]) => [platform, { signature: 'x'.repeat(50), url: `https://github.com/${repository}/releases/download/${tag}/${name}` }])) };
  const options = { repository, tag, version: '0.1.0', expectedSha: '123' };
  assert.doesNotThrow(() => validateRelease(release, manifest, options));
  const officialApiUrls = structuredClone(manifest);
  officialApiUrls.platforms['windows-x86_64'].url = `https://api.github.com/repos/${repository}/releases/assets/1`;
  officialApiUrls.platforms['linux-x86_64'].url = `https://api.github.com/repos/${repository}/releases/assets/3`;
  assert.doesNotThrow(() => validateRelease(release, officialApiUrls, options));
  officialApiUrls.platforms['linux-x86_64'].url = `https://api.github.com/repos/${repository}/releases/assets/99`;
  assert.throws(() => validateRelease(release, officialApiUrls, options), /exact repository/);
  assert.throws(() => validateRelease({ ...release, assets: assets.filter((asset) => !asset.name.endsWith('.deb')) }, manifest, options), /\.deb/);
  assert.throws(() => validateRelease(release, { ...manifest, platforms: { 'windows-x86_64': manifest.platforms['windows-x86_64'] } }, options), /linux-x86_64/);
  const foreign = structuredClone(manifest);
  foreign.platforms['linux-x86_64'].url = 'https://github.com/other/repo/releases/download/v0.1.0/linux.AppImage';
  assert.throws(() => validateRelease(release, foreign, options), /exact repository/);
  assert.throws(() => validateRelease({ ...release, target_commitish: '456' }, manifest, options), /workflow commit/);
});
