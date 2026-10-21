import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { checkRelease, tomlVersion, validateSigning, validateVersions } from './release-check.mjs';
import { downloadAssetToFile, findDraftRelease, ghJson, validateRelease, verifyRelease } from './release-verify.mjs';

const repository = 'example/strata-manager';
const version = '0.1.0';
const tag = `v${version}`;
const filenames = { windows: 'Strata.Manager_0.1.0_x64-setup.exe', linux: 'Strata.Manager_0.1.0_amd64.AppImage', deb: 'Strata.Manager_0.1.0_amd64.deb', macos: 'Strata.Manager_0.1.0_aarch64.app.tar.gz', dmg: 'Strata.Manager_0.1.0_aarch64.dmg' };
const commitSha = '1'.repeat(40);
const options = { repository, tag, version, expectedSha: commitSha, tagCommitSha: commitSha };
function releaseFixture(signature = 'x'.repeat(50)) {
  const server = [`Strata.Manager.Server_${version}_amd64.tar.gz`, `Strata.Manager.Server_${version}_amd64.deb`];
  const assets = [filenames.windows, `${filenames.windows}.sig`, filenames.linux, `${filenames.linux}.sig`, filenames.deb, `${filenames.deb}.sig`, filenames.macos, `${filenames.macos}.sig`, filenames.dmg, `${filenames.dmg}.sig`, 'latest.json', ...server].map((name, id) => ({ name, id: id + 1, size: 100 }));
  const release = { tag_name: tag, draft: true, target_commitish: 'main', assets };
  const update = name => ({ signature, url: `https://github.com/${repository}/releases/download/${tag}/${name}` });
  const manifest = { version, platforms: { 'windows-x86_64': update(filenames.windows), 'linux-x86_64': update(filenames.linux), 'darwin-aarch64': update(filenames.macos) } };
  return { release, manifest, update };
}

async function ownedTemporary() {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'strata-release-test-'));
  return { directory, cleanup: async () => {
    const checked = await realpath(directory);
    assert.equal(dirname(checked), parent);
    assert.equal(checked, directory);
    assert.ok(basename(checked).startsWith('strata-release-test-'));
    await rm(checked, { recursive: true, force: true });
  } };
}

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
  const { release, manifest } = releaseFixture();
  const assets = release.assets;
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
  assert.throws(() => validateRelease(release, manifest, { ...options, tagCommitSha: '4'.repeat(40) }), /workflow commit/);
  assert.doesNotThrow(() => validateRelease({ ...release, target_commitish: 'another-creation-hint' }, manifest, options));
  assert.throws(() => validateRelease({ ...release, assets: assets.filter(asset => asset.name !== `${filenames.windows}.sig`) }, manifest, options), /signature is missing/);
  assert.throws(() => validateRelease({ ...release, assets: assets.filter(asset => asset.name !== 'latest.json') }, manifest, options), /latest.json/);
});

test('only current installers and official aliases may enter the updater manifest', () => {
  const { release, manifest, update } = releaseFixture();
  manifest.platforms['windows-x86_64-nsis'] = update(filenames.windows);
  manifest.platforms['linux-x86_64-appimage'] = update(filenames.linux);
  manifest.platforms['linux-x86_64-deb'] = update(filenames.deb);
  assert.doesNotThrow(() => validateRelease(release, manifest, options));
  const extraPlatform = structuredClone(manifest);
  extraPlatform.platforms['darwin-x86_64'] = { signature: 'x'.repeat(50), url: 'https://foreign.example/update.dmg' };
  assert.throws(() => validateRelease(release, extraPlatform, options), /Unsupported updater platform/);
  const wrongAlias = structuredClone(manifest);
  wrongAlias.platforms['windows-x86_64-nsis'] = update(filenames.linux);
  assert.throws(() => validateRelease(release, wrongAlias, options), /alias must reference/);
  const wrongSignature = structuredClone(manifest);
  wrongSignature.platforms['linux-x86_64-appimage'].signature = 'y'.repeat(50);
  assert.throws(() => validateRelease(release, wrongSignature, options), /alias must reference/);
  for (const name of ['foreign-old-installer.exe', 'Strata.Manager_0.0.9_x64-setup.exe', 'foreign.deb.sig', 'foreign-installer.zip']) {
    assert.throws(() => validateRelease({ ...release, assets: [...release.assets, { name, id: 99, size: 1 }] }, manifest, options), /Unexpected release asset/);
  }
  // Supplementary files stay tolerated so already published releases (which still carry SHA256SUMS) keep verifying;
  // new releases no longer produce it (see release-from-ci.test.mjs).
  assert.doesNotThrow(() => validateRelease({ ...release, assets: [...release.assets, { name: 'LICENSE', id: 98, size: 1 }] }, manifest, options));
  assert.doesNotThrow(() => validateRelease({ ...release, assets: [...release.assets, { name: 'SHA256SUMS', id: 99, size: 1 }] }, manifest, options));
  assert.ok(!release.assets.some(asset => asset.name === 'SHA256SUMS'), 'the release fixture does not contain SHA256SUMS');
  assert.throws(() => validateRelease({ ...release, assets: [...release.assets, { name: 'Strata.Manager_0.1.0_arm64.deb', id: 99, size: 1 }] }, manifest, options), /exactly one/);
  assert.throws(() => validateRelease({ ...release, assets: [...release.assets, { ...release.assets[0] }] }, manifest, options), /Duplicate/);
});

test('a nonempty current-version DEB signature is mandatory with or without a manifest alias', () => {
  for (const hasAlias of [false, true]) {
    const { release, manifest, update } = releaseFixture();
    if (hasAlias) manifest.platforms['linux-x86_64-deb'] = update(filenames.deb);
    assert.doesNotThrow(() => validateRelease(release, manifest, options));
    const missingSignature = { ...release, assets: release.assets.filter(asset => asset.name !== `${filenames.deb}.sig`) };
    assert.throws(() => validateRelease(missingSignature, manifest, options), /DEB update signature is missing/);
    const emptySignature = { ...release, assets: release.assets.map(asset => asset.name === `${filenames.deb}.sig` ? { ...asset, size: 0 } : asset) };
    assert.throws(() => validateRelease(emptySignature, manifest, options), /nonempty sizes/);
  }
});

test('wrong product, version or architecture cannot masquerade as the required installer', () => {
  for (const replacement of ['Other.App_0.1.0_x64-setup.exe', 'Strata.Manager_0.0.9_x64-setup.exe', 'Strata.Manager_0.1.0_arm64-setup.exe']) {
    const { release, manifest, update } = releaseFixture();
    release.assets[0].name = replacement;
    release.assets[1].name = replacement + '.sig';
    manifest.platforms['windows-x86_64'] = update(replacement);
    assert.throws(() => validateRelease(release, manifest, options), /current-version windows installer/);
  }
});

test('macOS updater archive and DMG are required with signatures', () => {
  const { release, manifest, update } = releaseFixture();
  assert.doesNotThrow(() => validateRelease(release, manifest, options));
  assert.throws(() => validateRelease({ ...release, assets: release.assets.filter(a => !a.name.endsWith('.dmg') && !a.name.endsWith('.dmg.sig')) }, manifest, options), /\.dmg/);
  assert.throws(() => validateRelease({ ...release, assets: release.assets.filter(a => a.name !== `${filenames.dmg}.sig`) }, manifest, options), /DMG update signature is missing/);
  const wrongArch = structuredClone(manifest);
  const bad = 'Strata.Manager_0.1.0_x86_64.app.tar.gz';
  release.assets.find(a => a.name === filenames.macos).name = bad;
  release.assets.find(a => a.name === `${filenames.macos}.sig`).name = bad + '.sig';
  wrongArch.platforms['darwin-aarch64'] = update(bad);
  assert.throws(() => validateRelease(release, wrongArch, options), /current-version macos installer/);
});

test('draft lookup uses the authenticated release list and scans beyond the first matching page', async () => {
  const { release } = releaseFixture();
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ tag_name: `v-old-${index}`, draft: false }));
  const found = await findDraftRelease(repository, tag, { fetchPage: async path => {
    calls.push(path);
    return calls.length === 1 ? firstPage : [release];
  } });
  assert.equal(found, release);
  assert.deepEqual(calls, [`/repos/${repository}/releases?per_page=100&page=1`, `/repos/${repository}/releases?per_page=100&page=2`]);

  // Finding a draft in a full page must not hide another exact-tag release.
  firstPage[0] = release;
  const duplicateCalls = [];
  await assert.rejects(findDraftRelease(repository, tag, { fetchPage: async path => {
    duplicateCalls.push(path);
    return duplicateCalls.length === 1 ? firstPage : [{ ...release, draft: false }];
  } }), /Duplicate releases/);
  assert.equal(duplicateCalls.length, 2);

  const terminalCalls = [];
  assert.equal(await findDraftRelease(repository, tag, { fetchPage: async path => {
    terminalCalls.push(path);
    return terminalCalls.length === 1 ? firstPage : [];
  } }), release);
  assert.equal(terminalCalls.length, 2, 'A full page needs an additional empty terminal page');
});

test('draft lookup rejects published, duplicate, missing and malformed release metadata', async () => {
  const { release } = releaseFixture();
  const rejected = [
    [[{ ...release, draft: false }], /unpublished draft/],
    [[release, { ...release }], /Duplicate releases/],
    [[], /No release found/],
    [[{ ...release, tag_name: `${tag}-other` }], /No release found/],
    [release, /Expected a release list/],
    [null, /Expected a release list/],
    [[null], /Invalid release list entry/],
    [[[]], /Invalid release list entry/],
    [[{ draft: true }], /Invalid release list entry/],
    [[{ ...release, tag_name: 1 }], /Invalid release list entry/],
    [[{ ...release, draft: 'true' }], /Invalid release list entry/],
    [Array.from({ length: 101 }, () => release), /Expected a release list/],
  ];
  for (const [metadata, error] of rejected) await assert.rejects(findDraftRelease(repository, tag, { fetchPage: async () => metadata }), error);
  await assert.rejects(findDraftRelease(repository, tag, { fetchPage: async () => { throw new Error('HTTP 403'); } }), /HTTP 403/);
});

test('draft pagination cannot succeed at its bound even after finding a matching draft', async () => {
  const { release } = releaseFixture();
  for (const includeMatch of [true, false]) {
    const calls = [];
    await assert.rejects(findDraftRelease(repository, tag, { maxPages: 2, fetchPage: async path => {
      calls.push(path);
      const page = Array.from({ length: 100 }, (_, index) => ({ tag_name: `v-other-${calls.length}-${index}`, draft: false }));
      if (includeMatch && calls.length === 1) page[0] = release;
      return page;
    } }), /pagination limit reached/);
    assert.deepEqual(calls, [`/repos/${repository}/releases?per_page=100&page=1`, `/repos/${repository}/releases?per_page=100&page=2`]);
  }
  for (const maxPages of [0, -1, 1.5, 11, Infinity]) await assert.rejects(findDraftRelease(repository, tag, { maxPages, fetchPage: async () => { assert.fail('Invalid bounds must not make a request'); } }), /bounded/);
});

test('GitHub release metadata commands have a finite timeout and forced termination signal', () => {
  const endpoint = `/repos/${repository}/releases?per_page=100&page=1`;
  assert.deepEqual(ghJson(endpoint, { execute: (command, arguments_, executionOptions) => {
    assert.equal(command, 'gh');
    assert.deepEqual(arguments_, ['api', endpoint]);
    assert.equal(executionOptions.timeout, 30000);
    assert.equal(executionOptions.killSignal, 'SIGKILL');
    assert.equal(executionOptions.encoding, 'utf8');
    assert.equal(executionOptions.maxBuffer, 4 * 1024 * 1024);
    return '[]';
  } }), []);
  assert.throws(() => ghJson(endpoint, { execute: () => { throw new Error('ETIMEDOUT'); } }), /ETIMEDOUT/);
});

test('invalid draft metadata refuses verification before any asset download', async () => {
  const temporary = await ownedTemporary();
  try {
    const configDirectory = join(temporary.directory, 'apps/desktop/src-tauri');
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, 'tauri.conf.json'), JSON.stringify({ version, productName: 'Strata Manager' }));
    const { release } = releaseFixture();
    for (const fetchRelease of [async () => [], async () => [{ ...release, draft: false }], async () => [release, release], async () => release, async () => { throw new Error('ETIMEDOUT'); }]) {
      let downloaded = false;
      await assert.rejects(verifyRelease({ ...options, root: temporary.directory, verifierPath: 'must-not-be-executed', fetchRelease, fetchAsset: async () => { downloaded = true; assert.fail('Invalid metadata must not download release assets'); }, logger: () => {} }));
      assert.equal(downloaded, false);
    }
  } finally { await temporary.cleanup(); }
});

test('large binary downloads stream to disk and reject truncated data', async () => {
  const temporary = await ownedTemporary();
  const content = Buffer.alloc(8 * 1024 * 1024, 0xff);
  const mockSpawn = () => {
    const child = new EventEmitter();
    child.stdout = Readable.from((function* () { for (let offset = 0; offset < content.length; offset += 65536) yield content.subarray(offset, offset + 65536); })());
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', null);
    child.stdout.once('end', () => child.emit('close', 0));
    return child;
  };
  try {
    const destination = join(temporary.directory, 'large-artifact');
    await downloadAssetToFile(repository, { id: 1, name: 'large.exe', size: content.length }, destination, { spawnProcess: mockSpawn });
    assert.equal((await stat(destination)).size, content.length);
    assert.deepEqual(await readFile(destination), content);
    await assert.rejects(downloadAssetToFile(repository, { id: 1, name: 'truncated.exe', size: content.length + 1 }, join(temporary.directory, 'truncated-artifact'), { spawnProcess: mockSpawn }), /size does not match/);
  } finally { await temporary.cleanup(); }
});

test('disk failure terminates its download and a stalled child cannot block timeout cleanup', async () => {
  const temporary = await ownedTemporary();
  try {
    const existing = join(temporary.directory, 'existing-file');
    await writeFile(existing, 'retained');
    let killed = false;
    const failedSpawn = () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { killed = true; child.emit('close', null); return true; };
      return child;
    };
    await assert.rejects(downloadAssetToFile(repository, { id: 1, name: 'fixture.exe', size: 1 }, existing, { spawnProcess: failedSpawn }), /EEXIST/);
    assert.ok(killed);
    assert.equal(await readFile(existing, 'utf8'), 'retained');
    const signals = [];
    const stalledSpawn = () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = signal => { signals.push(signal); return false; };
      return child;
    };
    const started = Date.now();
    await assert.rejects(downloadAssetToFile(repository, { id: 1, name: 'fixture.exe', size: 1 }, join(temporary.directory, 'timed-out'), { spawnProcess: stalledSpawn, timeoutMs: 20 }), /timed out/);
    assert.ok(Date.now() - started < 2500, 'A child ignoring kill must still finish within the bounded fallback');
    assert.deepEqual(signals, [undefined, 'SIGKILL']);
  } finally { await temporary.cleanup(); }
});

test('real verifier checks every exposed installer and deduplicates official aliases', { skip: !process.env.UPDATE_VERIFIER_BIN }, async () => {
  await cryptoReleaseFixture({}, async ({ run, downloads, paths, logs }) => {
    await run();
    for (const name of Object.values(filenames)) {
      assert.equal(downloads.filter(value => value === name).length, 1);
      assert.equal(downloads.filter(value => value === `${name}.sig`).length, 1);
    }
    assert.match(logs[0], /all installers \(NSIS, AppImage, DEB, macOS app archive, DMG\)/);
    for (const path of paths) await assert.rejects(stat(path), { code: 'ENOENT' });
  });
});

test('wrong key, altered bytes or matching fake signature refuses publication and cleans its files', { skip: !process.env.UPDATE_VERIFIER_BIN }, async () => {
  for (const scenario of [{ wrongKey: true }, { tamper: true }, { signature: 'x'.repeat(50) }, { signature: '' }, { mismatch: true }, { publicWhitespace: true }, { signatureWhitespace: true }, { noDebAlias: true, tamperDeb: true }, { noDebAlias: true, fakeDebSignature: true }]) {
    await cryptoReleaseFixture(scenario, async ({ run, paths }) => {
      await assert.rejects(run());
      for (const path of paths) await assert.rejects(stat(path), { code: 'ENOENT' });
    });
  }
});

test('the real verifier rejects tampered bytes in each of the three installers independently', { skip: !process.env.UPDATE_VERIFIER_BIN }, async () => {
  for (const name of Object.values(filenames)) {
    await cryptoReleaseFixture({ tamperInstaller: name }, async ({ run, paths, logs }) => {
      await assert.rejects(run());
      assert.deepEqual(logs, []);
      for (const path of paths) await assert.rejects(stat(path), { code: 'ENOENT' });
    });
  }
});

test('an uploaded DEB signature is verified even without a manifest alias', { skip: !process.env.UPDATE_VERIFIER_BIN }, async () => {
  await cryptoReleaseFixture({ noDebAlias: true }, async ({ run, downloads, logs }) => {
    await run();
    for (const name of Object.values(filenames)) {
      assert.equal(downloads.filter(value => value === name).length, 1);
      assert.equal(downloads.filter(value => value === `${name}.sig`).length, 1);
    }
    assert.match(logs[0], /all installers \(NSIS, AppImage, DEB, macOS app archive, DMG\)/);
  });
});

test('the real verification flow refuses a missing DEB signature and alias before installer downloads', { skip: !process.env.UPDATE_VERIFIER_BIN }, async () => {
  await cryptoReleaseFixture({ noDebAlias: true, missingDebSignature: true }, async ({ run, downloads, paths, logs }) => {
    await assert.rejects(run(), /DEB update signature is missing/);
    assert.deepEqual(downloads, ['latest.json']);
    assert.deepEqual(logs, []);
    for (const path of paths) await assert.rejects(stat(path), { code: 'ENOENT' });
  });
});

test('a moved remote tag prevents publication before any installer or manifest download', { skip: !process.env.UPDATE_VERIFIER_BIN }, async () => {
  await cryptoReleaseFixture({ tagMismatch: true }, async ({ run, downloads }) => {
    await assert.rejects(run(), /commit/);
    assert.deepEqual(downloads, []);
  });
});

async function cryptoReleaseFixture(scenario, operation) {
  const temporary = await ownedTemporary();
  const fixtureDirectory = resolve('crates/update-verifier/tests/fixtures');
  let publicKey = (await readFile(join(fixtureDirectory, scenario.wrongKey ? 'wrong-public.txt' : 'public.txt'), 'utf8')).trim();
  let signature = scenario.signature ?? (await readFile(join(fixtureDirectory, 'artifact.sig'), 'utf8')).trim();
  if (scenario.publicWhitespace) publicKey = ' ' + publicKey;
  if (scenario.signatureWhitespace) signature = ' ' + signature;
  const payload = await readFile(join(fixtureDirectory, 'artifact.bin'));
  const { release, manifest, update } = releaseFixture(signature);
  manifest.platforms['windows-x86_64-nsis'] = update(filenames.windows);
  manifest.platforms['linux-x86_64-appimage'] = update(filenames.linux);
  manifest.platforms['linux-x86_64-deb'] = update(filenames.deb);
  if (scenario.noDebAlias) delete manifest.platforms['linux-x86_64-deb'];
  if (scenario.missingDebSignature) release.assets = release.assets.filter(asset => asset.name !== `${filenames.deb}.sig`);
  const downloads = []; const paths = []; const logs = [];
  try {
    const configDirectory = join(temporary.directory, 'apps/desktop/src-tauri');
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, 'tauri.conf.json'), JSON.stringify({ version, productName: 'Strata Manager', plugins: { updater: { pubkey: publicKey } } }));
    const run = () => verifyRelease({ ...options, root: temporary.directory, verifierPath: process.env.UPDATE_VERIFIER_BIN, fetchRelease: async path => {
      assert.equal(path, `/repos/${repository}/releases?per_page=100&page=1`);
      return [release];
    }, fetchTag: async path => {
      assert.equal(path, `/repos/${repository}/git/ref/tags/${tag}`);
      return { ref: `refs/tags/${tag}`, object: { type: 'commit', sha: scenario.tagMismatch ? '4'.repeat(40) : commitSha } };
    }, logger: message => logs.push(message), fetchAsset: async (_repository, asset, destination) => {
      downloads.push(asset.name); paths.push(destination);
      const bytes = asset.name === 'latest.json' ? JSON.stringify(manifest) : asset.name.endsWith('.sig') ? (scenario.mismatch || scenario.fakeDebSignature && asset.name.endsWith('.deb.sig') ? 'signature mismatch' : signature) : scenario.tamper || scenario.tamperDeb && asset.name.endsWith('.deb') || scenario.tamperInstaller === asset.name ? 'tampered installer' : payload;
      await writeFile(destination, bytes, { flag: 'wx' });
    } });
    await operation({ run, downloads, paths, logs });
  } finally { await temporary.cleanup(); }
}

test('deferred macOS releases verify without macOS assets and refuse any macOS asset or darwin entry', () => {
  const { release, manifest } = releaseFixture();
  const deferredNames = new Set([filenames.macos, `${filenames.macos}.sig`, filenames.dmg, `${filenames.dmg}.sig`]);
  const deferredRelease = { ...release, assets: release.assets.filter(asset => !deferredNames.has(asset.name)) };
  const deferredManifest = { ...manifest, platforms: { ...manifest.platforms } };
  delete deferredManifest.platforms['darwin-aarch64'];
  const result = validateRelease(deferredRelease, deferredManifest, { ...options, macos: 'deferred' });
  assert.equal(result.dmg, null);
  assert.equal(Object.hasOwn(result.updates, 'darwin-aarch64'), false);
  // Default mode still requires macOS.
  assert.throws(() => validateRelease(deferredRelease, deferredManifest, options), /darwin-aarch64|dmg/i);
  // Deferred mode rejects a darwin entry and any macOS asset.
  assert.throws(() => validateRelease(deferredRelease, manifest, { ...options, macos: 'deferred' }), /darwin-aarch64/);
  for (const name of deferredNames) {
    const withMac = { ...deferredRelease, assets: [...deferredRelease.assets, { name, id: 900, size: 100 }] };
    assert.throws(() => validateRelease(withMac, deferredManifest, { ...options, macos: 'deferred' }), /macOS assets/);
  }
  assert.throws(() => validateRelease(deferredRelease, deferredManifest, { ...options, macos: 'later' }), /mode/);
});

test('the macOS follow-up verifies a published release only when asked to', () => {
  const { release, manifest } = releaseFixture();
  const published = { ...release, draft: false };
  assert.ok(validateRelease(published, manifest, { ...options, published: true }));
  assert.throws(() => validateRelease(published, manifest, options), /draft/);
  assert.throws(() => validateRelease(release, manifest, { ...options, published: true }), /published/);
});
