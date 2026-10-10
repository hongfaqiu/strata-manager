import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { downloadPublicFixtureAsset, downloadUpgradeFixture, UPGRADE_FIXTURE, validateUpgradeRelease } from './download-upgrade-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const installerBytes = Buffer.from('synthetic inert fixture payload; never executed');
const signatureBytes = Buffer.from('synthetic signature; not genuine minisign');
const fixture = { ...UPGRADE_FIXTURE,
  installer: { ...UPGRADE_FIXTURE.installer, size: installerBytes.length, sha256: sha(installerBytes) },
  signature: { ...UPGRADE_FIXTURE.signature, size: signatureBytes.length, sha256: sha(signatureBytes) },
};
const publicRepository = { full_name: fixture.repository, private: false };
const metadata = (expectation = fixture) => ({ id: expectation.releaseId, tag_name: expectation.tag, draft: false, prerelease: true,
  url: `https://api.github.com/repos/${expectation.repository}/releases/${expectation.releaseId}`,
  html_url: `https://github.com/${expectation.repository}/releases/tag/${expectation.tag}`,
  assets: [expectation.installer, expectation.signature].map(asset => ({ ...asset, state: 'uploaded',
    digest: `sha256:${asset.sha256}`, url: `https://api.github.com/repos/${expectation.repository}/releases/assets/${asset.id}`,
    browser_download_url: `https://github.com/${expectation.repository}/releases/download/${expectation.tag}/${asset.name}` })),
});
const reference = commit => ({ ref: `refs/tags/${fixture.tag}`, object: { type: 'commit', sha: commit } });

async function harness(run) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'strata-upgrade-contract-')));
  const runner = join(temporary, 'runner'); await mkdir(runner);
  const output = join(runner, 'github-output'); await writeFile(output, '');
  const verifier = join(temporary, 'strata-update-verifier.exe'); await writeFile(verifier, 'inert mock verifier; never executed');
  const env = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows', RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: fixture.repository, RUNNER_TEMP: runner, GITHUB_WORKSPACE: root,
    GITHUB_OUTPUT: output, UPDATE_VERIFIER_BIN: verifier, GH_TOKEN: 'dummy-secret-must-not-be-printed' };
  const events = []; const messages = [];
  const options = { env, platform: 'win32', fixture, logger: message => messages.push(message),
    fetchJson: async path => {
      events.push(['metadata', path]);
      if (path === `/repos/${fixture.repository}`) return publicRepository;
      if (path === `/repos/${fixture.repository}/git/ref/tags/${fixture.tag}`) return reference(fixture.commit);
      if (path === `/repos/${fixture.repository}/releases/${fixture.releaseId}`) return metadata();
      assert.fail('unexpected metadata endpoint');
    },
    fetchAsset: async (asset, destination) => {
      events.push(['download', asset, destination]);
      assert.equal(await readFile(output, 'utf8'), '', 'outputs must wait for all verification');
      await writeFile(destination, asset.id === fixture.installer.id ? installerBytes : signatureBytes, { flag: 'wx' });
    },
    execute: (executable, args, executionOptions) => {
      events.push(['verifier', executable, args, executionOptions]);
      assert.equal(executable, verifier);
      assert.notEqual(executable, args[args.indexOf('--artifact') + 1], 'installer must not be executed');
      assert.equal(args[args.indexOf('--config') + 1], join(root, 'apps/desktop/src-tauri/tauri.conf.json'));
      assert.equal(args[args.indexOf('--version') + 1], '0.1.0-beta.2');
      assert.equal(args.at(-1), '--require-signed-version');
      assert.equal(executionOptions.timeout, 30000);
      assert.deepEqual(executionOptions.stdio, ['ignore', 'pipe', 'pipe']);
      return '';
    },
  };
  const owned = async () => (await readdir(runner)).filter(name => name.startsWith('strata-upgrade-fixture-'));
  try { await run({ temporary, runner, output, verifier, env, events, messages, options, owned }); }
  finally {
    assert.equal(dirname(await realpath(temporary)), await realpath(tmpdir()));
    assert.ok(basename(temporary).startsWith('strata-upgrade-contract-'));
    await rm(temporary, { recursive: true, force: true });
  }
}

test('production fixture pins retain the verified historical release, assets and byte hashes', () => {
  assert.equal(UPGRADE_FIXTURE.repository, 'hongfaqiu/strata-manager');
  assert.equal(UPGRADE_FIXTURE.commit, '0db2fea5128144fe2fe00cca992bd5139c831508');
  assert.equal(UPGRADE_FIXTURE.releaseId, 409177062);
  assert.deepEqual([UPGRADE_FIXTURE.installer.id, UPGRADE_FIXTURE.installer.size, UPGRADE_FIXTURE.installer.sha256],
    [628882710, 6702725, '36c50b76cbeb1ba0d769c426b1d471cd2d6c790f3d46bc1740bb13041526830c']);
  assert.deepEqual([UPGRADE_FIXTURE.signature.id, UPGRADE_FIXTURE.signature.size, UPGRADE_FIXTURE.signature.sha256],
    [628882746, 464, '71716ecf3c65fc662591c31a4e68b0d79ff8c8cf46e4794f726512c78625cffd']);
  assert.ok(Object.isFrozen(UPGRADE_FIXTURE) && Object.isFrozen(UPGRADE_FIXTURE.installer));
  validateUpgradeRelease(publicRepository, metadata(UPGRADE_FIXTURE));
});

test('tiny synthetic success verifies first, retains only its owned directory, then emits paths once', async () => harness(async context => {
  const { options, events, output, owned, runner } = context;
  const result = await downloadUpgradeFixture(options);
  assert.equal(result.version, '0.1.0-beta.2'); assert.ok(isAbsolute(result.installer));
  assert.equal(dirname(dirname(result.installer)), runner);
  assert.deepEqual(await readFile(result.installer), installerBytes);
  assert.equal(await readFile(output, 'utf8'), `installer=${result.installer}\nversion=0.1.0-beta.2\n`);
  assert.equal((await owned()).length, 1);
  assert.equal(events.filter(event => event[0] === 'download').length, 2);
  assert.equal(events.filter(event => event[0] === 'verifier').length, 1);
  assert.equal(events.at(-1)[0], 'metadata', 'tag must be rechecked before exposing paths');
  const before = events.length;
  await assert.rejects(downloadUpgradeFixture(options), /already prepared/);
  assert.equal(events.length, before, 'second invocation must not download or run anything');
}));

test('local, self-hosted, Linux and fork environments fail before metadata, downloads or execution', async () => harness(async ({ options, env, events, owned }) => {
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_OS: 'Linux' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REPOSITORY: 'other/repo' }]) {
    await assert.rejects(downloadUpgradeFixture({ ...options, env: { ...env, ...change } }), /Windows GitHub-hosted/);
  }
  await assert.rejects(downloadUpgradeFixture({ ...options, platform: 'linux' }), /Windows GitHub-hosted/);
  assert.deepEqual(events, []); assert.deepEqual(await owned(), []);
}));

test('shell-control path characters and arbitrary external output files are refused', async () => harness(async ({ options, env, temporary, events }) => {
  for (const key of ['RUNNER_TEMP', 'GITHUB_WORKSPACE', 'GITHUB_OUTPUT', 'UPDATE_VERIFIER_BIN']) {
    for (const character of ['"', "'", '`', '$', '\r', '\n', '\0', '\t', '\u001b', ';', '&', '|', '<', '>']) {
      await assert.rejects(downloadUpgradeFixture({ ...options, env: { ...env, [key]: env[key] + character } }), /shell-safe/);
    }
  }
  const external = join(temporary, 'external-output'); await writeFile(external, 'preserve');
  await assert.rejects(downloadUpgradeFixture({ ...options, env: { ...env, GITHUB_OUTPUT: external } }), /runner-temp/);
  assert.equal(await readFile(external, 'utf8'), 'preserve'); assert.deepEqual(events, []);
}));

test('zero-argument CLI rejects arbitrary output-dir and local invocation without requesting metadata', () => {
  const script = join(root, 'scripts/download-upgrade-fixture.mjs');
  const env = { ...process.env, GITHUB_ACTIONS: 'false', GH_TOKEN: 'dummy-secret-must-not-be-printed' };
  for (const args of [['--output-dir', tmpdir()], []]) {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /takes no arguments|Windows GitHub-hosted/);
    assert.equal(result.stderr.includes(env.GH_TOKEN), false);
  }
});

test('private, draft, wrong release, duplicate, wrong digest/size/ID/name and foreign asset URLs fail closed', async () => harness(async ({ options, events, output, owned }) => {
  const variants = [
    value => { value.id++; }, value => { value.tag_name = 'v0.1.0'; }, value => { value.draft = true; },
    value => { value.prerelease = false; }, value => { delete value.prerelease; },
    value => { value.url += '/other'; }, value => { value.html_url = 'https://github.com/other/repo/releases/tag/v0.1.0-beta.2'; },
    value => { value.assets.push({ ...value.assets[0] }); }, value => { value.assets[1].id = value.assets[0].id; },
    value => { value.assets.pop(); }, value => { value.assets[0].id++; }, value => { value.assets[0].name = '../bad.exe'; },
    value => { value.assets[0].size++; }, value => { value.assets[1].digest = 'sha256:' + 'a'.repeat(64); },
    value => { value.assets[0].state = 'new'; }, value => { value.assets[0].url += '?token=dummy'; },
    value => { value.assets[0].browser_download_url = 'https://example.invalid/install.exe'; },
  ];
  for (const mutate of variants) {
    const release = metadata(); mutate(release);
    await assert.rejects(downloadUpgradeFixture({ ...options, fetchJson: async path => path.includes('/releases/') ? release
      : path.includes('/git/ref/') ? reference(fixture.commit) : publicRepository }), /fixture|assets/i);
  }
  await assert.rejects(downloadUpgradeFixture({ ...options, fetchJson: async path => path.includes('/git/ref/') ? reference(fixture.commit)
    : path.includes('/releases/') ? metadata() : { ...publicRepository, private: true } }), /public/);
  assert.deepEqual(events, []); assert.deepEqual(await owned(), []); assert.equal(await readFile(output, 'utf8'), '');
}));

test('moved source tag rejects before downloading and metadata errors cannot expose credentials or headers', async () => harness(async ({ options, events, owned }) => {
  await assert.rejects(downloadUpgradeFixture({ ...options, fetchJson: async path => path.includes('/git/ref/') ? reference('a'.repeat(40))
    : path.includes('/releases/') ? metadata() : publicRepository }), /expected source commit/);
  await assert.rejects(downloadUpgradeFixture({ ...options, fetchJson: async () => { throw new Error('GH_TOKEN=dummy-secret Authorization: dummy-header'); } }),
    error => error.message === 'GitHub fixture metadata could not be read.');
  assert.deepEqual(events, []); assert.deepEqual(await owned(), []);
}));

test('partial download, size drift and same-size altered bytes clean only this helper directory', async () => harness(async ({ options, output, runner, owned, events }) => {
  const other = join(runner, 'unrelated'); await mkdir(other); await writeFile(join(other, 'keep'), 'preserve');
  for (const mode of ['partial', 'size', 'digest']) {
    await assert.rejects(downloadUpgradeFixture({ ...options, fetchAsset: async (asset, destination) => {
      if (mode === 'partial') { await writeFile(destination, 'partial'); throw new Error('Authorization: not-for-output'); }
      const bytes = Buffer.from(asset.id === fixture.installer.id ? installerBytes : signatureBytes);
      if (mode === 'digest') bytes[0] ^= 1;
      await writeFile(destination, mode === 'size' ? bytes.subarray(1) : bytes);
    } }), /transfer failed|size does not match|SHA-256/);
    assert.deepEqual(await owned(), []); assert.equal(await readFile(output, 'utf8'), '');
    assert.equal(await readFile(join(other, 'keep'), 'utf8'), 'preserve');
  }
  assert.equal(events.filter(event => event[0] === 'verifier').length, 0);
}));

test('failed synthetic verifier and a tag moved after verification expose no installer output', async () => harness(async ({ options, output, owned }) => {
  await assert.rejects(downloadUpgradeFixture({ ...options, execute: () => { throw new Error('dummy secret verifier stderr'); } }),
    error => error.message === 'Pinned fixture signature or signed version verification failed.');
  assert.deepEqual(await owned(), []); assert.equal(await readFile(output, 'utf8'), '');
  let tagReads = 0;
  await assert.rejects(downloadUpgradeFixture({ ...options, fetchJson: async path => path.includes('/git/ref/')
    ? reference(++tagReads === 1 ? fixture.commit : 'b'.repeat(40)) : path.includes('/releases/') ? metadata() : publicRepository }), /expected source commit/);
  assert.equal(tagReads, 2); assert.deepEqual(await owned(), []); assert.equal(await readFile(output, 'utf8'), '');
}));

test('output changed during preparation is preserved and never appended with an installer path', async () => harness(async ({ options, output, owned }) => {
  await assert.rejects(downloadUpgradeFixture({ ...options,
    fetchAsset: async (asset, destination) => {
      await writeFile(destination, asset.id === fixture.installer.id ? installerBytes : signatureBytes);
      if (asset.id === fixture.installer.id) await writeFile(output, 'unrelated=keep\n');
    }, execute: () => '' }), /changed during/);
  assert.equal(await readFile(output, 'utf8'), 'unrelated=keep\n'); assert.deepEqual(await owned(), []);
}));

test('public downloader omits auth, enforces bounded bytes and refuses failed or foreign responses', async () => harness(async ({ runner }) => {
  const asset = { ...fixture.installer, url: metadata().assets[0].browser_download_url };
  const response = (bytes, url = asset.url, status = 200) => {
    const value = new Response(bytes, { status }); Object.defineProperty(value, 'url', { value: url }); return value;
  };
  let request;
  const destination = join(runner, 'download-contract');
  await downloadPublicFixtureAsset(asset, destination, { fetchResponse: async (url, options) => {
    request = { url, options }; return response(installerBytes);
  } });
  assert.deepEqual(await readFile(destination), installerBytes);
  assert.equal(request.url, asset.url); assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.redirect, 'follow'); assert.equal(Object.hasOwn(request.options, 'headers'), false);
  assert.ok(request.options.signal instanceof AbortSignal);
  await assert.rejects(downloadPublicFixtureAsset(asset, join(runner, 'over-size'), { fetchResponse: async () => response(Buffer.concat([installerBytes, Buffer.from('x')])) }), /exceeds/);
  const foreign = response(installerBytes, 'https://example.invalid/asset');
  await assert.rejects(downloadPublicFixtureAsset(asset, join(runner, 'foreign'), { fetchResponse: async () => foreign }), /destination/);
  assert.equal(foreign.bodyUsed, true, 'rejected response stream must be cancelled');
  const denied = response('failed', asset.url, 403);
  await assert.rejects(downloadPublicFixtureAsset(asset, join(runner, 'http-error'), { fetchResponse: async () => denied }), /download failed/);
  assert.equal(denied.bodyUsed, true);
}));
