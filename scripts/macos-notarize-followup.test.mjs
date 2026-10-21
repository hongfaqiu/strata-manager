import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPlan, MACOS_DEFERRED_MARKER, MACOS_DEFERRED_NOTE, MACOS_COMPLETED_NOTE, releaseBody } from './release-from-ci.mjs';
import { RECORD_PROTOCOL, completedBody, completedManifest, macosAssets, pendingReleases, validateNotaryLog, validateRecord, validateTarEntries } from './macos-notarize-followup.mjs';

const plan = { ...createPlan({ tag: 'v0.2.12', version: '0.2.12', sourceSha: 'b'.repeat(40), productName: 'Strata Manager', macos: 'followup' }), runId: 77, runAttempt: 1 };
const submittedSha = 'c'.repeat(64);
const dmgSha = 'a'.repeat(64);
const record = () => ({ protocol: RECORD_PROTOCOL, submissionId: '12345678-90ab-cdef-1234-567890abcdef', version: '0.2.12',
  sourceSha: 'b'.repeat(40), runId: 77, runAttempt: 1, mode: 'auto', stapled: false,
  dmg: { name: 'Strata Manager_0.2.12_aarch64.dmg', sha256: dmgSha, size: 10 },
  app: { cdhash: 'd'.repeat(40), teamIdentifier: '33R6USA42W', submittedZipSha256: submittedSha } });

test('follow-up names are exactly the four macOS release assets', () => {
  const names = macosAssets(plan);
  assert.deepEqual(names.uploads, ['Strata.Manager_0.2.12_aarch64.app.tar.gz', 'Strata.Manager_0.2.12_aarch64.app.tar.gz.sig', 'Strata.Manager_0.2.12_aarch64.dmg', 'Strata.Manager_0.2.12_aarch64.dmg.sig']);
  assert.throws(() => macosAssets(createPlan({ tag: 'v0.2.12', version: '0.2.12', sourceSha: 'b'.repeat(40), productName: 'Strata Manager', macos: 'defer' })));
});
test('only published deferred releases without a DMG are pending', () => {
  const body = releaseBody('notes', { macos: 'defer' });
  const releases = [
    { tag_name: 'v0.2.12', draft: false, body, assets: [{ name: 'latest.json' }] },
    { tag_name: 'v0.2.13', draft: true, body, assets: [] },
    { tag_name: 'v0.2.11', draft: false, body: 'notes', assets: [] },
    { tag_name: 'v0.2.10', draft: false, body, assets: [{ name: 'Strata.Manager_0.2.10_aarch64.dmg' }] },
    { tag_name: 'bad tag', draft: false, body, assets: [] },
  ];
  assert.deepEqual(pendingReleases(releases), ['v0.2.12']);
  assert.throws(() => pendingReleases(null));
});
test('the CI record must match the bound run, version and exact DMG bytes', () => {
  assert.ok(validateRecord(record(), plan, dmgSha));
  for (const change of [r => { r.runId = 78; }, r => { r.runAttempt = 2; }, r => { r.sourceSha = 'e'.repeat(40); }, r => { r.version = '0.2.11'; },
    r => { r.protocol = 'x'; }, r => { r.submissionId = 'nope'; }, r => { r.dmg.name = 'Other_0.2.12_aarch64.dmg'; }, r => { r.mode = 'later'; },
    r => { r.app.cdhash = 'xyz'; }, r => { r.app.teamIdentifier = ''; }, r => { delete r.app.submittedZipSha256; }, r => { r.protocol = 'strata-macos-notarization/v1'; }]) {
    const r = record(); change(r); assert.throws(() => validateRecord(r, plan, dmgSha), /record/);
  }
  assert.throws(() => validateRecord(record(), plan, 'f'.repeat(64)), /not the one recorded/);
  assert.throws(() => validateRecord(record(), plan, submittedSha), /not the one recorded/);
});
test('Apple log must accept the submitted app zip and cover the app code directory', () => {
  const r = record();
  const log = { jobId: r.submissionId.toUpperCase(), status: 'Accepted', sha256: submittedSha, ticketContents: [{ path: 'Strata Manager.zip/Strata Manager.app/Contents/MacOS/strata-supervisor', cdhash: 'E'.repeat(40) }, { path: 'Strata Manager.zip/Strata Manager.app', cdhash: 'D'.repeat(40) }] };
  assert.ok(validateNotaryLog(log, r));
  assert.throws(() => validateNotaryLog({ ...log, status: 'Invalid' }, r), /accept/);
  assert.throws(() => validateNotaryLog({ ...log, sha256: 'f'.repeat(64) }, r), /accept/);
  assert.throws(() => validateNotaryLog({ ...log, sha256: dmgSha }, r), /accept/);
  assert.throws(() => validateNotaryLog({ ...log, jobId: '00000000-0000-0000-0000-000000000000' }, r), /accept/);
  assert.throws(() => validateNotaryLog({ ...log, ticketContents: [] }, r), /code directory/);
});
test('latest.json only gains darwin-aarch64; every other entry is kept', () => {
  const manifest = { version: '0.2.12', notes: 'n', pub_date: '2026-10-21T00:00:00Z', platforms: { 'windows-x86_64': { url: 'w', signature: 's' } } };
  const next = completedManifest(manifest, { plan, tarball: 'Strata.Manager_0.2.12_aarch64.app.tar.gz', signature: 'sig' });
  assert.deepEqual(next.platforms['windows-x86_64'], manifest.platforms['windows-x86_64']);
  assert.equal(next.platforms['darwin-aarch64'].url, 'https://github.com/hongfaqiu/strata-manager/releases/download/v0.2.12/Strata.Manager_0.2.12_aarch64.app.tar.gz');
  assert.equal(next.pub_date, manifest.pub_date);
  assert.throws(() => completedManifest(next, { plan, tarball: 'x', signature: 'sig' }), /already/);
  assert.throws(() => completedManifest({ ...manifest, version: '0.2.11' }, { plan, tarball: 'x', signature: 'sig' }), /belong/);
  assert.throws(() => completedManifest(manifest, { plan, tarball: 'x', signature: 'sig\n' }), /trimmed/);
});
test('release notes switch from the deferred to the completed note', () => {
  const body = releaseBody('notes', { macos: 'defer' });
  const done = completedBody(body);
  assert.ok(done.includes(MACOS_COMPLETED_NOTE));
  assert.ok(!done.includes(MACOS_DEFERRED_MARKER));
  assert.throws(() => completedBody('notes'), /deferred/);
  assert.ok(MACOS_DEFERRED_NOTE.startsWith(MACOS_DEFERRED_MARKER));
});
test('app archive entries must stay inside Strata Manager.app', () => {
  assert.ok(validateTarEntries(['Strata Manager.app/', 'Strata Manager.app/Contents/Info.plist']));
  for (const bad of [['Strata Manager.app/', '../evil'], ['Strata Manager.app/', '/etc/passwd'], ['Strata Manager.app/', 'Other.app/x'], ['Strata Manager.app/'], ['Strata Manager.app/', 'Strata Manager.app/../../x']]) {
    assert.throws(() => validateTarEntries(bad));
  }
});
test('the follow-up workflow is scheduled, serialized with publishing and never uploads before Apple accepts', async () => {
  const workflow = (await readFile(new URL('../.github/workflows/macos-notarize-followup.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  assert.match(workflow, /schedule:\n {4}- cron: /);
  assert.match(workflow, /group: release-publish-\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /MACOS_RELEASE_MODE: followup/);
  for (const step of ['Sign the stapled macOS files for the updater', 'Add the macOS assets, then darwin-aarch64 to latest.json']) {
    assert.match(workflow, new RegExp('- name: ' + step + "\\n {8}if: steps\\.staple\\.outputs\\.status == 'accepted'"));
  }
  assert.ok(workflow.indexOf('node scripts/release-from-ci.mjs prepare') < workflow.indexOf('macos-notarize-followup.mjs staple'));
  // Only the app is notarized; the DMG is rebuilt around it and re-signed, so the certificate is needed.
  assert.ok(workflow.indexOf('- name: Import the Developer ID certificate') < workflow.indexOf('macos-notarize-followup.mjs staple'));
  assert.match(workflow, /security delete-keychain "\$STRATA_SIGNING_KEYCHAIN"/);
  const script = await readFile(new URL('./macos-notarize-followup.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /stapler', 'staple', dmg|notarytool', 'submit|primary-signature/);
  assert.match(script, /notary\(\['staple-app', app\]\)/);
  assert.match(script, /notary\(\['restage-dmg', dmg, app, identity, s\.record\.app\.teamIdentifier\]\)/);
});

// The helper only ever runs on macOS runners; it needs a POSIX bash.
test('macos-notary.sh retries network errors 3 times, then only warns (75); other errors fail at once', { skip: process.platform === 'win32' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtemp, writeFile: write } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'notary-'));
  const fake = join(dir, 'fake.sh');
  await write(fake, '#!/bin/bash\necho x >> "$0.count"\ncase $1 in net) echo "Error Domain=NSURLErrorDomain Code=-1009 offline"; exit 1;; bad) echo "Invalid identity"; exit 3;; esac\n', { mode: 0o755 });
  const script = new URL('./macos-notary.sh', import.meta.url).pathname;
  const call = mode => spawnSync('bash', [script, 'retry', 'check', fake, mode], { encoding: 'utf8', env: { ...process.env, STRATA_NET_RETRY_DELAY: '0' } });
  const count = async () => (await readFile(fake + '.count', 'utf8')).trim().split('\n').length;
  let r = call('net');
  assert.equal(r.status, 75); assert.match(r.stderr, /::warning title=check::/); assert.equal(await count(), 3);
  await write(fake + '.count', '');
  r = call('bad');
  assert.equal(r.status, 3); assert.match(r.stderr, /::error title=check::/); assert.equal((await readFile(fake + '.count', 'utf8')).trim().split('\n').length, 1);
  assert.equal(call('ok').status, 0);
  const helper = await readFile(script, 'utf8');
  assert.doesNotMatch(helper, /^set -e/m);
  assert.match(helper, /RETRY_DELAY="\$\{STRATA_NET_RETRY_DELAY:-30\}"/);
  assert.match(helper, /for i in 1 2 3; do/);
  assert.doesNotMatch(helper, /stapler (staple|validate) "\$dmg"|notarytool submit/);
});
