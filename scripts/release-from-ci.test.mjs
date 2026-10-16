import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  CI_PROTOCOL, REPOSITORY, COMMON_GATES, PLATFORM_GATES, SHARD_GATES, WINDOWS_SHARD_GATES, createPlan, assetNames,
  validateSourceProtocol, validateCiEvidence, validateInstallerEntries, validateLiveWriters,
  validateLatestManifest, validateReleaseInventory, validateReleaseMetadata, draftMetadataPayload, creationBranch,
  requireSourceRelease, validatePreparedRecord, readPrepared,
  findReusableCi, hasIncompleteStepInventory, inventory, WRITER_JOBS, validateWriterProtocol, command,
} from './release-from-ci.mjs';

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const makePlan = (version = '0.2.0') => createPlan({
  tag: 'v' + version, version, sourceSha: 'a'.repeat(40), productName: 'Strata Manager',
});
const plan = makePlan();
// Independent expectations from the reviewed observer-compatibility matrix in ci.yml.
const observerJobs = ['Strata 0.1.43.1 observer (windows-latest)', 'Strata 0.1.43.1 observer (ubuntu-22.04)'];
const observerGates = [
  'Preserve the verified upstream source bytes', 'Check out the reviewed Strata 0.1.43.1 API fixture',
  'Install MockEngine test dependencies only', 'Verify the reviewed source and observer compatibility',
  'Verify all Strata 0.1.43.1 observer HTTP contracts without skips',
];
test('observer compatibility expectations match the two-platform reviewed workflow and its named gates', async () => {
  const workflow = (await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const observer = workflow.slice(workflow.indexOf('\n  observer-compatibility:')).split('\n  native-windows:')[0];
  assert.ok(observer.includes('name: Strata 0.1.43.1 observer (${{ matrix.runner }})'));
  assert.match(observer, /runner: \[windows-latest,\s*ubuntu-22\.04\]/);
  for (const gate of observerGates) assert.ok(observer.includes('- name: ' + gate), gate);
});
test('the macOS desktop job stays behind the docs-only skip and publishes ad-hoc Apple Silicon artifacts', async () => {
  const workflow = (await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const changes = workflow.slice(workflow.indexOf('\n  changes:'), workflow.indexOf('\n  observer-compatibility:'));
  assert.match(changes, /dorny\/paths-filter@v3/);
  assert.doesNotMatch(changes, /website\/\*\*/);
  assert.doesNotMatch(changes, /docs\/\*\*/);
  const desktop = workflow.slice(workflow.indexOf('\n  desktop:'));
  assert.match(desktop, /needs: changes\n {4}if: needs\.changes\.outputs\.code == 'true'/);
  assert.match(desktop, /runner: macos-15\n {12}target: aarch64-apple-darwin\n {12}bundles: app,dmg/);
  assert.match(desktop, /runner\.os != 'macOS' && 'scripts\/ci-linux-native-tests\.test\.mjs'/);
  assert.doesNotMatch(desktop, /runner: macos-14/);
  for (const step of ['Use ad-hoc macOS signing without an Apple certificate', 'Package the macOS app archive for the updater', 'Upload the macOS updater archive']) {
    assert.ok(desktop.includes('- name: ' + step), step);
  }
  assert.match(desktop, /APPLE_SIGNING_IDENTITY=-/);
  assert.match(desktop, /name: ci-darwin-aarch64-app-tarball/);
  assert.match(desktop, /if: runner\.os == 'macOS'/);
  assert.doesNotMatch(desktop, /x86_64-apple-darwin/);
});
for (const method of ['POST', 'PATCH']) {
  test(`real ${method} subprocess receives the complete Unicode JSON request through stdin`, () => {
    const endpoint = '/repos/hongfaqiu/strata-manager/releases' + (method === 'PATCH' ? '/123' : '');
    const args = ['api', '--method', method, endpoint, '--input', '-'];
    const probe = [
      'const fs = require("node:fs");',
      'const input = fs.readFileSync(0);',
      'process.stdout.write(JSON.stringify({args: process.argv.slice(1), hex: input.toString("hex"), body: JSON.parse(input.toString("utf8"))}));',
    ].join('\n');
    for (const p of [makePlan('0.1.4'), makePlan('1.0.0-rc.1')]) {
      const notes = '中文更新 🌱\n第二行含 "引号" 与 \\ 路径';
      const input = JSON.stringify(draftMetadataPayload(p, notes), null, 2) + '\n';
      const received = JSON.parse(command(process.execPath, ['-e', probe, '--', ...args], { input, timeout: 5000 }));
      assert.deepEqual(received.args, args);
      assert.equal(received.hex, Buffer.from(input, 'utf8').toString('hex'));
      assert.deepEqual(received.body, { tag_name: p.tag, name: p.productName + ' ' + p.tag, body: notes, draft: true, prerelease: p.prerelease });
      assert.equal(validateReleaseMetadata(received.body, p, notes), true);
    }
  });
}
test('a real subprocess without input receives immediate EOF and completes within its deadline', () => {
  const probe = 'const fs = require("node:fs"); process.stdout.write(String(fs.readFileSync(0).length));';
  assert.equal(command(process.execPath, ['-e', probe], { timeout: 5000 }), '0');
});
test('real subprocess failure never exposes its input, stdout or sensitive stderr', () => {
  const input = JSON.stringify({ body: 'synthetic-private-input 中文\n"quoted"' });
  const probe = [
    'const input = require("node:fs").readFileSync(0, "utf8");',
    'process.stdout.write("synthetic-private-stdout:" + input);',
    'process.stderr.write("synthetic-sensitive-stderr:" + input);',
    'process.exitCode = 42;',
  ].join('\n');
  assert.throws(() => command(process.execPath, ['-e', probe], { input, timeout: 5000 }), error => {
    assert.equal(error.message, 'Command failed: Node tool');
    for (const value of [input, 'synthetic-private-input', 'synthetic-private-stdout', 'synthetic-sensitive-stderr']) {
      assert.equal(String(error.stack).includes(value), false);
    }
    for (const field of ['input', 'stdout', 'stderr', 'cause']) assert.equal(Object.hasOwn(error, field), false);
    return true;
  });
});
function ciFixture(p = plan, runId = 123) {
  const run = { id: runId, path: p.workflowPath, event: 'workflow_dispatch', status: 'completed',
    conclusion: 'success', head_sha: p.sourceSha, run_attempt: 2, created_at: '2026-01-01T00:00:00Z',
    repository: { full_name: p.repository }, head_repository: { full_name: p.repository } };
  const job = (name, gates, id) => ({ id, run_id: runId, run_attempt: 2, head_sha: p.sourceSha, name, status: 'completed',
    conclusion: 'success', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:10:00Z',
    steps: gates.map(name => ({ name, status: 'completed', conclusion: 'success' })) });
  const jobs = [
    job('desktop (windows-latest, x86_64-pc-windows-msvc, nsis)', [...COMMON_GATES, ...PLATFORM_GATES.windows], 10),
    job('desktop (ubuntu-22.04, x86_64-unknown-linux-gnu, appimage,deb)', [...COMMON_GATES, ...PLATFORM_GATES.linux], 11),
    job('desktop (macos-15, aarch64-apple-darwin, app,dmg)', [...COMMON_GATES, ...PLATFORM_GATES.macos], 12),
    ...[0, 1, 2].map(i => job('Linux native shard (' + i + '/3)', SHARD_GATES, 20 + i)),
    ...[0, 1, 2].map(i => job('Windows native shard (' + i + '/3)', WINDOWS_SHARD_GATES, 30 + i)),
    ...observerJobs.map((name, i) => job(name, observerGates, 40 + i)),
  ];
  if (p.version === '0.1.2') jobs[0].steps.push(...[
    'Verify the signed beta.2 installer for the first stable upgrade',
    'Verify beta.2 to first stable upgrade and retained application data',
  ].map(name => ({ name, status: 'completed', conclusion: 'success' })));
  const artifacts = p.artifacts.map((a, i) => ({ id: 100 + i, name: a.name,
    size_in_bytes: 10, digest: 'sha256:' + String(i + 1).repeat(64), expired: false,
    created_at: '2026-01-01T00:05:00Z', expires_at: '2099-01-01T00:00:00Z',
    workflow_run: { id: runId, head_sha: p.sourceSha } }));
  return { run, jobs, artifacts };
}
const boundPlan = p => { const f = ciFixture(p); return validateCiEvidence(f.run, f.jobs, f.artifacts, p); };

test('plan derives current version, product, architecture and prerelease without fixed run or hashes', () => {
  for (const version of ['0.1.3', '0.2.0', '1.4.3-rc.1', '1.4.3+build.2']) {
    const p = makePlan(version);
    assert.equal(p.tag, 'v' + version);
    assert.equal(p.prerelease, version.includes('-rc.'));
    assert.equal(p.artifacts[0].installer, 'Strata.Manager_' + version + '_x64-setup.exe');
    assert.equal(p.artifacts[1].id, undefined);
  }
});
test('unsafe source, version, tag and product inputs are rejected', () => {
  for (const override of [
    { version: '01.2.0' }, { tag: 'v0.1.3' }, { sourceSha: 'abc' },
    { repository: 'fork/repo' }, { runId: -1 }, { productName: '../bad' },
    { productName: 'Strata:Manager' }, { productName: 'bad..name' },
  ]) assert.throws(() => createPlan({ ...plan, ...override }));
});
test('source protocol explicitly rejects old fixed release and missing CI marker', () => {
  const helper = "export const CI_PROTOCOL = '" + CI_PROTOCOL + "';";
  const ci = 'name: Reusable release CI protocol\nrun: node scripts/release-from-ci.mjs protocol';
  assert.equal(validateSourceProtocol(helper, ci), true);
  assert.equal(CI_PROTOCOL, 'strata-release-ci/v3');
  assert.throws(() => validateSourceProtocol("export const CI_PROTOCOL = 'strata-release-ci/v2';", ci), /protocol/);
  assert.throws(() => validateSourceProtocol('export const PLAN = {}', ci), /protocol/);
  assert.throws(() => validateSourceProtocol(helper, 'node scripts/release-check.mjs'), /protocol/);
});
test('normal preflight silently binds actual tag and refuses public/moved tags before resolving or downloading CI', async () => {
  const calls = [];
  await requireSourceRelease(plan, {
    requireTag: async (...args) => { calls.push(['tag', ...args]); },
    requireWritable: async options => {
      calls.push(['writable', options.repository, options.tag, options.expectedSha, options.requireDraft]);
      assert.equal(options.logger('must stay silent'), undefined);
    },
  });
  assert.deepEqual(calls, [['tag', REPOSITORY, plan.tag, plan.sourceSha],
    ['writable', REPOSITORY, plan.tag, plan.sourceSha, false]]);
  await assert.rejects(requireSourceRelease(plan, {
    requireTag: async () => { throw new Error('moved tag'); },
    requireWritable: async () => assert.fail('tag failure must stop preflight'),
  }), /moved tag/);
  await assert.rejects(requireSourceRelease(plan, {
    requireTag: async () => {}, requireWritable: async () => { throw new Error('public release'); },
  }), /public release/);
});
test('validation-only source rehearsal never consults a historical tag or release', async () => {
  await requireSourceRelease(plan, { validateOnly: true,
    requireTag: async () => assert.fail('no tag binding in rehearsal'),
    requireWritable: async () => assert.fail('no release write guard in rehearsal'),
  });
});
test('new draft uses the verified repository default branch only as its creation hint', () => {
  assert.equal(creationBranch({ full_name: REPOSITORY, default_branch: 'main' }), 'main');
  assert.equal(creationBranch({ full_name: REPOSITORY, default_branch: 'release/next' }), 'release/next');
  assert.throws(() => creationBranch({ full_name: 'fork/repo', default_branch: 'main' }));
  assert.throws(() => creationBranch({ full_name: REPOSITORY, default_branch: '' }));
  assert.throws(() => creationBranch({ full_name: REPOSITORY, default_branch: 'main\n' }));
});
test('complete trusted push or dispatch binds dynamically discovered IDs, digest and current attempt', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    const f = ciFixture(); f.run.event = event;
    const p = validateCiEvidence(f.run, f.jobs, f.artifacts, plan);
    assert.equal(p.runId, 123); assert.equal(p.runAttempt, 2);
    assert.deepEqual(p.artifacts.map(a => a.id), [100, 101, 102, 103, 104]);
    assert.equal(p.artifacts[0].sha256, '1'.repeat(64));
  }
});
const invalidCi = [
  ['wrong source', f => { f.run.head_sha = 'b'.repeat(40); }],
  ['fork', f => { f.run.head_repository.full_name = 'fork/repo'; }],
  ['pull request', f => { f.run.event = 'pull_request'; }],
  ['wrong workflow', f => { f.run.path = '.github/workflows/release.yml'; }],
  ['pending whole CI', f => { f.run.status = 'in_progress'; }],
  ['failed whole CI', f => { f.run.conclusion = 'failure'; }],
  ['extra unknown job', f => { f.jobs.push({ ...f.jobs[0], id: 99, name: 'Unidentified validation' }); }],
  ['missing desktop', f => { f.jobs.shift(); }],
  ['duplicate desktop', f => { f.jobs.push(clone(f.jobs[0])); }],
  ['missing shard', f => { f.jobs.splice(4, 1); }],
  ['skipped shard', f => { f.jobs[3].conclusion = 'skipped'; }],
  ['old job attempt', f => { f.jobs[0].run_attempt = 1; }],
  ['wrong job run', f => { f.jobs[0].run_id = 124; }],
  ['missing fixture guard', f => { f.jobs[0].steps = f.jobs[0].steps.filter(s => s.name !== COMMON_GATES[1]); }],
  ['skipped clippy', f => { f.jobs[1].steps.find(s => s.name === 'Rust checks').conclusion = 'skipped'; }],
  ['failed smoke', f => { f.jobs[0].steps.at(-1).conclusion = 'failure'; }],
  ['missing provider test', f => { f.jobs[1].steps = f.jobs[1].steps.filter(s => s.name !== PLATFORM_GATES.linux[2]); }],
  ['missing artifact', f => { f.artifacts.pop(); }],
  ['duplicate artifact', f => { f.artifacts.push(clone(f.artifacts[0])); }],
  ['duplicate ID', f => { f.artifacts[1].id = f.artifacts[0].id; }],
  ['wrong artifact run', f => { f.artifacts[0].workflow_run.id = 124; }],
  ['wrong artifact source', f => { f.artifacts[0].workflow_run.head_sha = 'c'.repeat(40); }],
  ['absent hard digest', f => { f.artifacts[0].digest = null; }],
  ['expired flag', f => { f.artifacts[0].expired = true; }],
  ['expired timestamp', f => { f.artifacts[0].expires_at = '2000-01-01T00:00:00Z'; }],
  ['old attempt artifact', f => { f.artifacts[0].created_at = '2025-12-31T23:00:00Z'; }],
  ['future artifact', f => { f.artifacts[0].created_at = '2026-01-01T00:11:00Z'; }],
  ['unbounded ZIP', f => { f.artifacts[0].size_in_bytes = 1024 ** 3; }],
];
for (const [label, change] of invalidCi) test('CI refuses ' + label, () => {
  const f = ciFixture(); change(f);
  assert.throws(() => validateCiEvidence(f.run, f.jobs, f.artifacts, plan));
});
test('every required shared and platform gate fails closed independently', () => {
  for (const [position, gates] of [[0, [...COMMON_GATES, ...PLATFORM_GATES.windows]], [1, [...COMMON_GATES, ...PLATFORM_GATES.linux]], [2, [...COMMON_GATES, ...PLATFORM_GATES.macos]]]) {
    for (const name of gates) {
      const f = ciFixture(); f.jobs[position].steps.find(s => s.name === name).conclusion = 'skipped';
      assert.throws(() => validateCiEvidence(f.run, f.jobs, f.artifacts, plan), new RegExp(name.replace(/[()[\]]/g, '\\$&')));
    }
  }
});
test('first stable 0.1.2 still requires both real upgrade gates', () => {
  const p = makePlan('0.1.2'); const f = ciFixture(p);
  assert.equal(validateCiEvidence(f.run, f.jobs, f.artifacts, p).version, '0.1.2');
  f.jobs[0].steps.pop(); assert.throws(() => validateCiEvidence(f.run, f.jobs, f.artifacts, p));
});
test('each native shard requires every real test, private keyring and coverage upload step', () => {
  for (let index = 3; index < 6; index++) for (const name of SHARD_GATES) {
    const f = ciFixture();
    f.jobs[index].steps.find(s => s.name === name).conclusion = 'skipped';
    assert.throws(() => validateCiEvidence(f.run, f.jobs, f.artifacts, plan), /shard gate/);
  }
});
test('v1 plans cannot accept v2 native evidence or reuse the old five-job CI', () => {
  const f = ciFixture(); const oldPlan = { ...plan, protocol: 'strata-release-ci/v1' };
  assert.throws(() => validateCiEvidence(f.run, f.jobs, f.artifacts, oldPlan), /protocol/);
  assert.throws(() => validateCiEvidence(f.run, f.jobs.slice(0, 5), f.artifacts, plan), /six native shards/);
});
for (const shard of [0, 1, 2]) {
  const position = 6 + shard;
  for (const [label, mutate] of [
    ['missing', (f, index) => { f.jobs.splice(index, 1); }],
    ['duplicate', (f, index) => { f.jobs.push(clone(f.jobs[index])); }],
    ['unknown replacement', (f, index) => { f.jobs[index].name = 'Unidentified Windows shard'; }],
    ['failed', (f, index) => { f.jobs[index].conclusion = 'failure'; }],
    ['cancelled', (f, index) => { f.jobs[index].conclusion = 'cancelled'; }],
    ['skipped', (f, index) => { f.jobs[index].conclusion = 'skipped'; }],
    ['queued', (f, index) => { f.jobs[index].status = 'queued'; f.jobs[index].conclusion = null; }],
    ['old attempt', (f, index) => { f.jobs[index].run_attempt--; }],
    ['wrong run', (f, index) => { f.jobs[index].run_id++; }],
    ['wrong source', (f, index) => { f.jobs[index].head_sha = 'b'.repeat(40); }],
  ]) test(`CI refuses Windows native shard ${shard} ${label} even with complete early installer artifacts`, () => {
    const f = ciFixture(); mutate(f, position);
    assert.throws(() => validateCiEvidence(f.run, f.jobs, f.artifacts, plan));
  });
  test(`Windows native shard ${shard} requires build, assigned test execution and coverage upload`, () => {
    for (const name of WINDOWS_SHARD_GATES) for (const state of ['missing', 'duplicate', 'skipped', 'failure']) {
      const f = ciFixture(); const steps = f.jobs[position].steps;
      const index = steps.findIndex(step => step.name === name);
      if (state === 'missing') steps.splice(index, 1);
      else if (state === 'duplicate') steps.push(clone(steps[index]));
      else steps[index].conclusion = state;
      assert.throws(() => validateCiEvidence(f.run, f.jobs, f.artifacts, plan), /shard gate/);
    }
  });
}
test('Windows wait, current-attempt download and aggregate cannot be skipped after installers exist', () => {
  for (const name of PLATFORM_GATES.windows.slice(0, 3)) for (const state of ['missing', 'duplicate', 'skipped', 'failure']) {
    const f = ciFixture(); const steps = f.jobs[0].steps;
    const index = steps.findIndex(step => step.name === name);
    if (state === 'missing') steps.splice(index, 1);
    else if (state === 'duplicate') steps.push(clone(steps[index]));
    else steps[index].conclusion = state;
    assert.throws(() => validateCiEvidence(f.run, f.jobs, f.artifacts, plan), /CI gate/);
  }
});
test('old eight-job CI without observer compatibility evidence is never reusable', () => {
  const f = ciFixture();
  assert.throws(() => validateCiEvidence(f.run, f.jobs.slice(0, 8), f.artifacts, plan), /desktop jobs/);
});
for (const name of observerJobs) {
  for (const [label, mutate] of [
    ['missing', (f, index) => { f.jobs.splice(index, 1); }],
    ['duplicate', (f, index) => { f.jobs.push(clone(f.jobs[index])); }],
    ['unknown replacement', (f, index) => { f.jobs[index].name = 'Unreviewed observer'; }],
    ['failed', (f, index) => { f.jobs[index].conclusion = 'failure'; }],
    ['cancelled', (f, index) => { f.jobs[index].conclusion = 'cancelled'; }],
    ['skipped', (f, index) => { f.jobs[index].conclusion = 'skipped'; }],
    ['queued', (f, index) => { f.jobs[index].status = 'queued'; f.jobs[index].conclusion = null; }],
    ['old attempt', (f, index) => { f.jobs[index].run_attempt--; }],
    ['missing attempt', (f, index) => { delete f.jobs[index].run_attempt; }],
    ['wrong run', (f, index) => { f.jobs[index].run_id++; }],
    ['wrong source', (f, index) => { f.jobs[index].head_sha = 'b'.repeat(40); }],
  ]) test(`observer compatibility gate refuses ${name} ${label}`, () => {
    const f = ciFixture(); mutate(f, f.jobs.findIndex(job => job.name === name));
    assert.throws(() => validateCiEvidence(f.run, f.jobs, f.artifacts, plan));
  });
  test(`observer compatibility ${name} requires every reviewed-source and HTTP-contract step`, () => {
    for (const gate of observerGates) for (const state of ['missing', 'duplicate', 'skipped', 'failure', 'cancelled', 'queued']) {
      const f = ciFixture(), steps = f.jobs.find(job => job.name === name).steps;
      const index = steps.findIndex(step => step.name === gate);
      if (state === 'missing') steps.splice(index, 1);
      else if (state === 'duplicate') steps.push(clone(steps[index]));
      else if (state === 'queued') { steps[index].status = 'queued'; steps[index].conclusion = null; }
      else steps[index].conclusion = state;
      assert.throws(() => validateCiEvidence(f.run, f.jobs, f.artifacts, plan), /observer gate/);
    }
  });
}
function zipEntry(a = plan.artifacts[0]) {
  return { name: a.installer,
    size: 10, compressedSize: 8, mode: 0o100644, isDirectory: false, encrypted: false };
}
test('ZIP accepts precisely one current product/version/arch regular installer with product spaces', () => {
  for (const a of plan.artifacts) {
    const e = { ...zipEntry(a), name: a.installer.replace('Strata.Manager', 'Strata Manager') };
    assert.equal(validateInstallerEntries([e], a), e);
  }
});
for (const [label, change] of [
  ['parent path', e => { e.name = '../' + e.name; }],
  ['absolute path', e => { e.name = '/' + e.name; }],
  ['Windows traversal', e => { e.name = '..\\' + e.name; }],
  ['symlink', e => { e.mode = 0o120777; }],
  ['directory', e => { e.isDirectory = true; }],
  ['encrypted', e => { e.encrypted = true; }],
  ['empty', e => { e.size = 0; }],
  ['oversize', e => { e.size = 1024 ** 3; }],
  ['wrong version', e => { e.name = e.name.replace('0.2.0', '0.1.3'); }],
  ['wrong arch', e => { e.name = e.name.replace('x64', 'arm64'); }],
  ['wrong product', e => { e.name = e.name.replace('Strata', 'Other'); }],
]) test('ZIP refuses ' + label, () => {
  const e = { ...zipEntry(), name: plan.artifacts[0].installer }; change(e);
  assert.throws(() => validateInstallerEntries([e], plan.artifacts[0]));
});
test('ZIP refuses extras and duplicate installers', () => {
  const e = { ...zipEntry(), name: plan.artifacts[0].installer };
  assert.throws(() => validateInstallerEntries([e, e], plan.artifacts[0]));
  assert.throws(() => validateInstallerEntries([e, { ...e, name: 'unrelated.exe' }], plan.artifacts[0]));
});
test('writer checks exclude own run and completed releases but fail closed for unknown current jobs', () => {
  const old = { id: 1, path: '.github/workflows/release.yml', head_branch: plan.tag, status: 'completed' };
  const own = { id: 2, path: '.github/workflows/release-from-ci.yml', status: 'in_progress' };
  assert.equal(validateLiveWriters([old, own], plan, 2), true);
  assert.throws(() => validateLiveWriters([{ ...old, status: 'queued' }], plan, 2));
  assert.throws(() => validateLiveWriters([{ ...own, id: 4 }], plan, 2));
});
function writerRun({ caller = false, tag = plan.tag, state = 'queued', role = 'publisher' } = {}) {
  const id = 5;
  return { id, run_attempt: 2, path: '.github/workflows/' + (caller ? 'release.yml' : 'release-from-ci.yml'),
    head_branch: tag, status: 'in_progress', writerJobs: [{
      id: 50, run_id: id, run_attempt: 2, name: (caller ? 'release / ' : '') + WRITER_JOBS[role], status: state,
    }] };
}
test('same/different tag publisher queues and caller prefixes permit the actual global lock owner', () => {
  for (const caller of [false, true]) for (const tag of [plan.tag, 'v0.1.3']) {
    for (const state of ['queued', 'waiting', 'pending', 'requested', 'completed']) {
      assert.equal(validateLiveWriters([writerRun({ caller, tag, state })], plan, 2), true);
    }
  }
});
test('resolvers awaiting CI and read-only validations do not write release assets', () => {
  for (const caller of [false, true]) for (const role of ['resolver', 'validation']) {
    assert.equal(validateLiveWriters([writerRun({ caller, role, state: 'in_progress' })], plan, 2), true);
  }
});
test('an actual in-progress publisher or old active build blocks writes regardless of run-level queue status', () => {
  for (const caller of [false, true]) {
    const run = writerRun({ caller, state: 'in_progress' });
    assert.throws(() => validateLiveWriters([run], plan, 2), /active release writer/);
    run.status = 'waiting';
    assert.throws(() => validateLiveWriters([run], plan, 2), /active release writer/);
    run.writerJobs[0].name = 'build';
    assert.throws(() => validateLiveWriters([run], plan, 2), /Unknown active release job/);
  }
});
test('empty whole-run queues need the pinned new lock protocol, never a guessed run status', () => {
  const run = { ...writerRun(), status: 'queued', writerJobs: [] };
  assert.throws(() => validateLiveWriters([run], plan, 2), /unidentifiable/);
  assert.equal(validateLiveWriters([{ ...run, writerProtocolVerified: true }], plan, 2), true);
  assert.throws(() => validateLiveWriters([{ ...run, status: 'in_progress', writerProtocolVerified: true }], plan, 2), /unidentifiable/);
  const workflow = 'name: ' + WRITER_JOBS.resolver + '\n' + WRITER_JOBS.publisher + '\n' + WRITER_JOBS.validation
    + "\nformat('release-publish-{0}', github.repository)";
  assert.equal(validateWriterProtocol(workflow), true);
  assert.equal(validateWriterProtocol(workflow.replace('release-publish-{0}', 'legacy-tag-only')), false);
  assert.equal(validateWriterProtocol('jobs:\n build:'), false);
});
test('malformed attempt, unknown/duplicate jobs or invalid job states fail closed', () => {
  for (const change of [
    r => { r.run_attempt = null; }, r => { r.writerJobs[0].run_id++; },
    r => { r.writerJobs[0].run_attempt--; }, r => { r.writerJobs[0].name = 'old publish'; },
    r => { r.writerJobs[0].status = 'unknown'; }, r => { r.writerJobs.push(clone(r.writerJobs[0])); },
  ]) { const run = writerRun(); change(run); assert.throws(() => validateLiveWriters([run], plan, 2)); }
});
function releaseFixture(p = plan) {
  let id = 1;
  const assets = p.artifacts.flatMap(a => [{ id: id++, name: a.installer, size: 10 },
    { id: id++, name: a.installer + '.sig', size: 10, signatureText: 'fixture-' + a.kind }]);
  assets.push({ id: id++, name: 'latest.json', size: 10 }, { id: id++, name: 'SHA256SUMS', size: 10 });
  const entry = i => ({ signature: 'fixture-' + p.artifacts[i].kind, url: 'https://github.com/' + REPOSITORY + '/releases/download/' + encodeURIComponent(p.tag) + '/' + encodeURIComponent(p.artifacts[i].installer) });
  return { release: { id: 4, tag_name: p.tag, draft: true, prerelease: p.prerelease, assets },
    manifest: { version: p.version, platforms: {
      'windows-x86_64': entry(0), 'windows-x86_64-nsis': entry(0), 'linux-x86_64': entry(1),
      'linux-x86_64-appimage': entry(1), 'linux-x86_64-deb': entry(2), 'darwin-aarch64': entry(3),
    } } };
}
test('exact stable/prerelease draft and six updater entries are version-specific', () => {
  for (const p of [plan, makePlan('1.0.0-rc.1'), makePlan('1.0.0+build.3')]) {
    const f = releaseFixture(p);
    assert.equal(validateReleaseInventory(f.release, p), true);
    assert.equal(validateLatestManifest(f.manifest, f.release.assets, p), true);
  }
});
test('an actual new empty draft can start from zero; public releases cannot be overwritten', () => {
  const f = releaseFixture(); f.release.assets = [];
  assert.equal(validateReleaseInventory(f.release, plan, { allowPartial: true }), true);
  assert.throws(() => validateReleaseInventory(f.release, plan));
  f.release.draft = false;
  assert.throws(() => validateReleaseInventory(f.release, plan, { allowPartial: true }));
});
test('refreshed draft preserves its exact source tag, notes, name and stable/prerelease state', () => {
  for (const p of [plan, makePlan('1.0.0-rc.1')]) {
    const release = draftMetadataPayload(p, 'Current source notes');
    assert.equal(validateReleaseMetadata(release, p, release.body), true);
    for (const changed of [
      { body: 'Legacy notes' }, { name: 'Legacy release' }, { tag_name: 'untagged-fixture' },
      { draft: false }, { prerelease: !p.prerelease },
    ]) assert.throws(() => validateReleaseMetadata({ ...release, ...changed }, p, release.body));
    for (const key of Object.keys(release)) {
      const omitted = { ...release }; delete omitted[key];
      assert.throws(() => validateReleaseMetadata(omitted, p, release.body));
    }
  }
});
test('release refuses wrong version/prerelease, extra, duplicate, empty, and reused asset IDs', () => {
  for (const change of [
    r => { r.tag_name = 'v0.1.3'; }, r => { r.prerelease = true; }, r => { r.assets.pop(); },
    r => { r.assets.push({ id: 99, name: 'extra', size: 1 }); }, r => { r.assets[1].name = r.assets[0].name; },
    r => { r.assets[1].id = r.assets[0].id; }, r => { r.assets[0].size = 0; },
  ]) { const f = releaseFixture(); change(f.release); assert.throws(() => validateReleaseInventory(f.release, plan)); }
});
test('updater refuses substituted signature, URL, version and missing canonical platform', () => {
  for (const change of [
    m => { m.version = '0.1.3'; }, m => { m.platforms['linux-x86_64-deb'].url = 'https://example.com'; },
    m => { m.platforms['windows-x86_64'].signature = 'other'; }, m => { delete m.platforms['linux-x86_64']; },
  ]) { const f = releaseFixture(); change(f.manifest); assert.throws(() => validateLatestManifest(f.manifest, f.release.assets, plan)); }
});
function fakeApi(fixtures, runs) {
  return async path => {
    if (path.includes('/workflows/ci.yml/runs')) return { workflow_runs: runs ?? fixtures.map(f => f.run) };
    const f = fixtures.find(f => path.includes('/runs/' + f.run.id));
    assert.ok(f, 'unexpected endpoint: ' + path);
    if (path.includes('/jobs?')) return { jobs: f.jobs };
    if (path.includes('/artifacts?')) return { artifacts: f.artifacts };
    return f.run;
  };
}
test('resolver reuses a successful CI, reports same-source pending and refuses explicit wrong/failed CI', async () => {
  const f = ciFixture();
  assert.equal((await findReusableCi(plan, { fetchJson: fakeApi([f]) })).plan.runId, 123);
  f.run.status = 'in_progress'; f.run.conclusion = null;
  assert.deepEqual(await findReusableCi(plan, { fetchJson: fakeApi([f]) }), { status: 'pending', runId: 123 });
  assert.deepEqual(await findReusableCi(plan, { runId: 123, fetchJson: fakeApi([f]) }), { status: 'pending', runId: 123 });
  f.run.status = 'completed'; f.run.conclusion = 'failure';
  assert.deepEqual(await findReusableCi(plan, { fetchJson: fakeApi([f]) }), { status: 'missing' });
  await assert.rejects(findReusableCi(plan, { runId: 123, fetchJson: fakeApi([f]) }));
  f.run.head_sha = 'b'.repeat(40);
  await assert.rejects(findReusableCi(plan, { runId: 123, fetchJson: fakeApi([f]) }));
});
test('resolver can reuse an older complete same-source CI instead of an incomplete new attempt', async () => {
  const good = ciFixture(plan, 123), bad = ciFixture(plan, 124);
  bad.run.created_at = '2026-01-02T00:00:00Z'; bad.jobs.pop();
  const result = await findReusableCi(plan, { fetchJson: fakeApi([bad, good]) });
  assert.equal(result.runId, 123);
});
test('resolver waits when successful CI job steps are briefly empty instead of failing the release', async () => {
  const f = ciFixture();
  for (const job of f.jobs) job.steps = [];
  assert.equal(hasIncompleteStepInventory(f.jobs), true);
  assert.deepEqual(await findReusableCi(plan, { fetchJson: fakeApi([f]) }), { status: 'pending', runId: 123 });
  assert.deepEqual(await findReusableCi(plan, { runId: 123, fetchJson: fakeApi([f]) }), { status: 'pending', runId: 123 });
});
test('resolver surfaces non-reusable successful CI instead of a false missing status', async () => {
  const f = ciFixture();
  f.jobs.pop();
  await assert.rejects(findReusableCi(plan, { fetchJson: fakeApi([f]) }), /not reusable/);
  await assert.rejects(findReusableCi(plan, { runId: 123, fetchJson: fakeApi([f]) }), /not reusable/);
});
test('bounded inventory refuses incomplete and malformed pagination', async () => {
  await assert.rejects(inventory('/inventory', 'items', async () => ({ items: Array(100).fill({}) })), /incomplete/);
  await assert.rejects(inventory('/inventory', 'items', async () => ({ items: {} })));
});
test('prepared evidence binds run, attempt, artifact hash, installer hash and validation mode', () => {
  const p = boundPlan(plan);
  const meta = { protocol: CI_PROTOCOL, validateOnly: false, plan: p, installers: p.artifacts.map(a => ({
    name: a.installer, artifactId: a.id, zipSha256: a.sha256, size: 10, sha256: 'a'.repeat(64),
  })) };
  assert.equal(validatePreparedRecord(meta, p), true);
  for (const change of [
    m => { m.plan.runId++; }, m => { m.plan.runAttempt--; },
    m => { m.installers[0].artifactId++; }, m => { m.installers[0].zipSha256 = 'b'.repeat(64); },
    m => { m.installers[0].sha256 = null; }, m => { m.validateOnly = true; },
  ]) { const m = clone(meta); change(m); assert.throws(() => validatePreparedRecord(m, p)); }
  meta.validateOnly = true;
  assert.equal(validatePreparedRecord(meta, p, { allowValidateOnly: true }), true);
});
test('real full-byte prepared reader catches installer and ZIP tampering and prohibits signing rehearsal bytes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'strata-promotion-test-'));
  try {
    const p = boundPlan(plan); const installer = Buffer.from('installer fixture');
    for (const a of p.artifacts) {
      execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c',
        "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr(sys.argv[2],b'installer fixture'); z.close()",
        join(temp, a.id + '.zip'), a.installer]);
      const zip = await readFile(join(temp, a.id + '.zip'));
      a.zipSize = zip.length; a.sha256 = hash(zip);
    }
    const meta = { protocol: CI_PROTOCOL, validateOnly: true, plan: p, installers: [] };
    for (const a of p.artifacts) {
      await writeFile(join(temp, a.installer), installer);
      meta.installers.push({ name: a.installer, artifactId: a.id, zipSha256: a.sha256, size: installer.length, sha256: hash(installer) });
    }
    await writeFile(join(temp, 'prepared.json'), JSON.stringify(meta));
    await readPrepared({ temp, plan: p, validateOnly: true });
    await assert.rejects(readPrepared({ temp, plan: p, validateOnly: false }), /validate-only/);
    await writeFile(join(temp, p.artifacts[0].installer), Buffer.from('Installer fixture'));
    await assert.rejects(readPrepared({ temp, plan: p, validateOnly: true }), /bytes changed/);
    const altered = clone(meta); altered.installers[0].sha256 = hash(Buffer.from('Installer fixture'));
    await writeFile(join(temp, 'prepared.json'), JSON.stringify(altered));
    await assert.rejects(readPrepared({ temp, plan: p, validateOnly: true }), /CI ZIP bytes/);
    await writeFile(join(temp, 'prepared.json'), JSON.stringify(meta));
    await writeFile(join(temp, p.artifacts[0].installer), installer);
    await writeFile(join(temp, p.artifacts[0].id + '.zip'), Buffer.from('zip fixture'));
    await assert.rejects(readPrepared({ temp, plan: p, validateOnly: true }), /bytes changed/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('the inventory is always five installers, five signatures and two metadata files', () => {
  assert.equal(assetNames(plan).length, 12);
  assert.equal(new Set(assetNames(plan)).size, 12);
  assert.equal(plan.artifacts[3].name, 'ci-darwin-aarch64-app-tarball');
  assert.equal(plan.artifacts[3].installer, 'Strata.Manager_' + plan.version + '_aarch64.app.tar.gz');
  assert.equal(plan.artifacts[4].name, 'ci-darwin-aarch64-dmg');
  assert.equal(plan.artifacts[4].installer, 'Strata.Manager_' + plan.version + '_aarch64.dmg');
});
