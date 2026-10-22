/** Keep CI caches bounded to dependencies, with the same test and release profiles. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'hongfaqiu/strata-manager';
const targetDir = '${{ github.workspace }}/apps/desktop/src-tauri/target';
const scalar = value => value.trim().replace(/^(['"])(.*)\1$/, '$2');

// This deliberately accepts only the mappings used by these workflow files.
// Unsupported YAML indirection fails rather than concealing a cache path or env override.
function mapping(lines, name, indent) {
  const start = lines.findIndex(line => line === `${' '.repeat(indent)}${name}:`);
  const values = new Map();
  if (start < 0) return values;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.search(/\S/) <= indent) break;
    const match = new RegExp(`^ {${indent + 2}}([A-Za-z0-9_-]+):\\s*(.*?)\\s*$`).exec(line);
    assert.ok(match, `Unsupported ${name} mapping: ${line}`);
    assert.ok(!values.has(match[1]), `Duplicate ${name} key: ${match[1]}`);
    values.set(match[1], scalar(match[2]));
  }
  return values;
}

function saveExpression(value) {
  const source = value.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const tokens = []; let offset = 0;
  const token = /\s*(&&|\|\||==|!=|\(|\)|'[^']*'|[A-Za-z_][A-Za-z0-9_.]*)/y;
  while (offset < source.length) {
    if (!source.slice(offset).trim()) break;
    token.lastIndex = offset;
    const match = token.exec(source);
    assert.ok(match, 'Unsupported cache save expression.');
    tokens.push(match[1]); offset = token.lastIndex;
  }
  let cursor = 0;
  function atom() {
    const value = tokens[cursor++];
    if (value === '(') { const result = or(); assert.equal(tokens[cursor++], ')'); return result; }
    if (value?.startsWith("'")) return () => value.slice(1, -1);
    if (value === 'true' || value === 'false') return () => value === 'true';
    assert.ok(['github.repository', 'github.ref', 'github.event_name'].includes(value), 'Cache save expression must use explicit repository, ref and event.');
    return context => context[value];
  }
  function comparison() {
    const left = atom(); const operator = tokens[cursor];
    if (!['==', '!='].includes(operator)) return left;
    cursor++; const right = atom();
    return context => operator === '==' ? left(context) === right(context) : left(context) !== right(context);
  }
  function and() {
    let result = comparison();
    while (tokens[cursor] === '&&') { cursor++; const left = result; const right = comparison(); result = context => left(context) && right(context); }
    return result;
  }
  function or() {
    let result = and();
    while (tokens[cursor] === '||') { cursor++; const left = result; const right = and(); result = context => left(context) || right(context); }
    return result;
  }
  const evaluate = or(); assert.equal(cursor, tokens.length, 'Incomplete cache save expression.');
  return evaluate;
}

function validateSave(value, restoreOnlyAllowed) {
  assert.ok(value, 'An explicit trusted cache save condition is required.');
  if (restoreOnlyAllowed && value === 'false') return;
  const evaluate = saveExpression(value);
  for (const repo of [repository, 'fork/strata-manager']) {
    for (const ref of ['refs/heads/main', 'refs/heads/codex/release', 'refs/tags/v0.1.3', 'refs/pull/1/merge']) {
      for (const event of ['push', 'workflow_dispatch', 'pull_request', 'pull_request_target', 'workflow_call', 'schedule']) {
        const expected = repo === repository && ref === 'refs/heads/main' && ['push', 'workflow_dispatch'].includes(event);
        assert.equal(evaluate({'github.repository': repo, 'github.ref': ref, 'github.event_name': event}), expected, `Untrusted cache save: ${repo} ${ref} ${event}`);
      }
    }
  }
}

function validateWorkflow(source, {restoreOnlyJobs = [], testCacheJobs = [], forbidRustCache = false, requiredCacheJobs} = {}) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const global = mapping(lines, 'env', 0); let caches = 0; const cacheJobs = [];
  const jobs = lines.flatMap((line, index) => /^ {2}[A-Za-z0-9_-]+:$/.test(line) && index > lines.indexOf('jobs:') ? [index] : []);
  for (let i = 0; i < jobs.length; i++) {
    const jobName = lines[jobs[i]].trim().slice(0, -1);
    const job = lines.slice(jobs[i] + 1, jobs[i + 1] ?? lines.length);
    const env = new Map([...global, ...mapping(job, 'env', 4)]);
    for (let j = 0; j < job.length; j++) {
      if (!/^ {8}uses: Swatinem\/rust-cache@|^ {6}- uses: Swatinem\/rust-cache@/.test(job[j])) continue;
      caches++;
      cacheJobs.push(jobName);
      const next = job.findIndex((line, index) => index > j && /^ {6}- /.test(line));
      const step = job.slice(j, next < 0 ? job.length : next);
      const inputs = mapping(step, 'with', 8);
      assert.equal(inputs.get('workspaces'), '. -> apps/desktop/src-tauri/target', 'Only the explicit native target may be cached.');
      assert.ok(!inputs.has('cache-directories'), 'Private fixtures, outputs, signing files and SOURCE_ROOT must not be added to caches.');
      for (const name of ['cache-bin', 'cache-workspace-crates', 'cache-all-crates']) assert.equal(inputs.get(name), 'false', `${name} must remain dependency-only.`);
      assert.notEqual(inputs.get('cache-on-failure'), 'true');
      assert.notEqual(inputs.get('add-rust-environment-hash-key'), 'false', 'Profile and Rust environment must remain part of the key.');
      assert.ok(/\$\{\{\s*matrix\.target\s*\}\}|x86_64-(?:pc-windows-msvc|unknown-linux-gnu)/.test(inputs.get('shared-key') ?? ''), 'Cache keys must distinguish Rust targets.');
      if (restoreOnlyJobs.includes(jobName)) assert.equal(inputs.get('save-if'), 'false', 'Native shards must not compete to save the shared cache.');
      // Shards build the test profile, so they own a separate key and never overwrite the desktop dev/release cache.
      const testKey = /^strata-native-test-/.test(inputs.get('shared-key') ?? '');
      assert.equal(testKey, testCacheJobs.includes(jobName), 'Only native shards may use (and must use) the separate test-profile cache key.');
      validateSave(inputs.get('save-if'), restoreOnlyJobs.includes(jobName));
      assert.equal(env.get('CARGO_TARGET_DIR'), targetDir, 'Compile and cache target paths must agree.');
      for (const profile of ['DEV', 'TEST']) assert.equal(env.get(`CARGO_PROFILE_${profile}_DEBUG`), '0', 'Native debug info policy must be explicit.');
      assert.equal(env.get('CARGO_INCREMENTAL'), '0', 'Record the existing action incremental policy explicitly.');
    }
  }
  if (forbidRustCache) assert.equal(caches, 0, 'Signing-only releases must not cache SOURCE_ROOT, secrets or prepared assets.');
  else assert.ok(caches > 0, 'The workflow must retain its native dependency cache.');
  if (requiredCacheJobs) assert.deepEqual(cacheJobs.toSorted(), requiredCacheJobs.toSorted(), 'Each required CI job definition must have exactly one native cache; only the desktop job may save.');
  assert.ok(!/CARGO_PROFILE_(?:DEV|TEST)_(?:DEBUG_ASSERTIONS|OVERFLOW_CHECKS):\s*['"]?(?:false|0)\b/.test(source), 'Debug assertions and overflow checks must remain enabled.');
  assert.ok(!/CARGO_PROFILE_RELEASE_[A-Z_]+:/.test(source), 'CI must retain the checked production release profile.');
  assert.ok(!/RUSTFLAGS:.*(?:lto|codegen-units|debug-assertions|overflow-checks|opt-level)/.test(source), 'Flags must not bypass the checked profiles.');
}

const trusted = "${{ github.repository == 'hongfaqiu/strata-manager' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') }}";
const fixture = `jobs:
  desktop:
    env:
      CARGO_TARGET_DIR: ${targetDir}
      CARGO_PROFILE_DEV_DEBUG: '0'
      CARGO_PROFILE_TEST_DEBUG: '0'
      CARGO_INCREMENTAL: '0'
    steps:
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: '. -> apps/desktop/src-tauri/target'
          shared-key: strata-native-\${{ matrix.target }}
          cache-bin: false
          cache-workspace-crates: false
          cache-all-crates: false
          save-if: ${trusted}
`;

test('native shards save only a separate trusted test-profile key', () => {
  const shard = fixture.replace('  desktop:', '  native-linux:').replace('strata-native-${{', 'strata-native-test-${{');
  validateWorkflow(shard, {testCacheJobs: ['native-linux']});
  assert.throws(() => validateWorkflow(shard.replace(trusted, 'true'), {testCacheJobs: ['native-linux']}));
  assert.throws(() => validateWorkflow(fixture.replace('  desktop:', '  native-linux:'), {testCacheJobs: ['native-linux']}), /test-profile cache key/);
  assert.throws(() => validateWorkflow(shard.replace('  native-linux:', '  desktop:')), /test-profile cache key/);
});

test('cache-policy validator accepts trusted dependency caches and restore-only native shards', () => {
  validateWorkflow(fixture);
  for (const platform of ['linux', 'windows']) validateWorkflow(fixture.replace('  desktop:', `  native-${platform}:`).replace(trusted, 'false'), {restoreOnlyJobs: [`native-${platform}`]});
  validateWorkflow('jobs:\n  sign:\n    steps:\n      - run: node scripts/release-from-ci.mjs sign\n', {forbidRustCache: true});
});

test('cache-policy validator rejects a native shard writer and a signing cache', () => {
  for (const platform of ['linux', 'windows']) assert.throws(() => validateWorkflow(fixture.replace('  desktop:', `  native-${platform}:`), {restoreOnlyJobs: [`native-${platform}`]}));
  assert.throws(() => validateWorkflow(fixture, {forbidRustCache: true}));
});

for (const [name, mutate] of [
  ['fork writes', text => text.replace("github.repository == 'hongfaqiu/strata-manager' && ", '')],
  ['tag writes', text => text.replace("github.ref == 'refs/heads/main'", "github.ref != 'refs/pull/1/merge'")],
  ['pull-request writes', text => text.replace("(github.event_name == 'push' || github.event_name == 'workflow_dispatch')", 'true')],
  ['unconditional writes', text => text.replace(trusted, 'true')],
  ['missing save guard', text => text.replace(`          save-if: ${trusted}\n`, '')],
  ['private output cache', text => text + '          cache-directories: output/signing\n'],
  ['broader workspace cache', text => text.replace('. -> apps/desktop/src-tauri/target', '. -> .')],
  ['Cargo binaries cache', text => text.replace('cache-bin: false', 'cache-bin: true')],
  ['workspace artifacts cache', text => text.replace('cache-workspace-crates: false', 'cache-workspace-crates: true')],
  ['all registry crates cache', text => text.replace('cache-all-crates: false', 'cache-all-crates: true')],
  ['profile key disabled', text => text + '          add-rust-environment-hash-key: false\n'],
  ['target key omitted', text => text.replace('strata-native-${{ matrix.target }}', 'strata-native')],
  ['target directory mismatch', text => text.replace(`CARGO_TARGET_DIR: ${targetDir}`, 'CARGO_TARGET_DIR: output/native')],
  ['unrecorded test profile', text => text.replace("CARGO_PROFILE_TEST_DEBUG: '0'", "CARGO_PROFILE_TEST_DEBUG: '2'")],
  ['incremental policy changed', text => text.replace("CARGO_INCREMENTAL: '0'", "CARGO_INCREMENTAL: '1'")],
  ['disabled debug assertions', text => text.replace("CARGO_INCREMENTAL: '0'", "CARGO_INCREMENTAL: '0'\n      CARGO_PROFILE_TEST_DEBUG_ASSERTIONS: false")],
  ['disabled overflow checks', text => text.replace("CARGO_INCREMENTAL: '0'", "CARGO_INCREMENTAL: '0'\n      CARGO_PROFILE_DEV_OVERFLOW_CHECKS: false")],
  ['release LTO override', text => text.replace("CARGO_INCREMENTAL: '0'", "CARGO_INCREMENTAL: '0'\n      CARGO_PROFILE_RELEASE_LTO: off")],
]) test(`cache-policy validator rejects ${name}`, () => assert.throws(() => validateWorkflow(mutate(fixture))));

test('CI workflow preserves the native cache policy', async () => {
  validateWorkflow(await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8'), {
    testCacheJobs: ['native-linux', 'native-windows'], requiredCacheJobs: ['desktop', 'native-linux', 'native-windows'],
  });
});
test('cache job inventory refuses missing, duplicate and additional cache writers', () => {
  const options = {requiredCacheJobs: ['desktop', 'native-linux', 'native-windows'], restoreOnlyJobs: ['native-linux', 'native-windows']};
  const job = fixture.slice(fixture.indexOf('  desktop:'));
  const linux = job.replace('  desktop:', '  native-linux:').replace(trusted, 'false');
  const windows = job.replace('  desktop:', '  native-windows:').replace(trusted, 'false');
  const complete = 'jobs:\n' + job + linux + windows;
  validateWorkflow(complete, options);
  for (const source of ['jobs:\n' + job + linux, complete + windows, complete + job.replace('  desktop:', '  untrusted-extra:')]) {
    assert.throws(() => validateWorkflow(source, options), /exactly one native cache/);
  }
});

test('tag release workflow does not cache signing inputs or source outputs', async () => {
  validateWorkflow(await readFile(resolve(root, '.github/workflows/release.yml'), 'utf8'), {forbidRustCache: true});
});

test('reusable promotion workflow does not cache signing inputs or source outputs', async () => {
  validateWorkflow(await readFile(resolve(root, '.github/workflows/release-from-ci.yml'), 'utf8'), {forbidRustCache: true});
});

test('release LTO and code generation remain unchanged', async () => {
  const manifest = await readFile(resolve(root, 'Cargo.toml'), 'utf8');
  const profile = /\[profile\.release\]\s*([^]*?)(?=\n\[|$)/.exec(manifest)?.[1];
  assert.match(profile ?? '', /^lto\s*=\s*"thin"\s*$/m);
  assert.match(profile ?? '', /^codegen-units\s*=\s*1\s*$/m);
});

// Linux apt archives: restore everywhere, save only from trusted main pushes, never in release workflows.
function validateAptCaches(source, {requiredJobs = [], forbid = false} = {}) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  assert.ok(!lines.some(line => /uses:\s*actions\/cache@/.test(line)), 'Use split actions/cache/restore and actions/cache/save so saves stay explicitly guarded.');
  const jobs = lines.flatMap((line, index) => /^ {2}[A-Za-z0-9_-]+:$/.test(line) && index > lines.indexOf('jobs:') ? [index] : []);
  const saveJobs = [];
  for (let i = 0; i < jobs.length; i++) {
    const jobName = lines[jobs[i]].trim().slice(0, -1);
    const job = lines.slice(jobs[i] + 1, jobs[i + 1] ?? lines.length);
    const steps = job.flatMap((line, index) => /^ {6}- /.test(line) ? [index] : []).map((start, k, all) => job.slice(start, all[k + 1] ?? job.length));
    const restores = steps.filter(step => step.some(line => /uses:\s*actions\/cache\/restore@/.test(line)));
    const saves = steps.filter(step => step.some(line => /uses:\s*actions\/cache\/save@/.test(line)));
    if (forbid) { assert.equal(restores.length + saves.length, 0, 'Release workflows must not use caches.'); continue; }
    for (const step of [...restores, ...saves]) {
      const inputs = mapping(step, 'with', 8);
      assert.equal(inputs.get('path'), '${{ runner.temp }}/apt-archives', 'Only downloaded apt archives may be cached.');
      assert.equal(inputs.get('key'), '${{ steps.apt-key.outputs.key }}', 'The apt key must come from scripts/ci-linux-apt-deps.sh.');
    }
    assert.equal(restores.length, saves.length, `${jobName}: every apt restore needs exactly one guarded save.`);
    for (const step of saves) {
      const condition = step.map(line => /^ {8}if:\s*(.*)$/.exec(line)?.[1]).find(Boolean);
      assert.ok(condition, 'An explicit trusted apt cache save condition is required.');
      const inner = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
        .replace(/^runner\.os == 'Linux' && /, '')
        .replace(/^steps\.apt-cache\.outputs\.cache-hit != 'true' && /, '');
      validateSave(`\${{ ${inner} }}`, false);
      saveJobs.push(jobName);
    }
  }
  assert.deepEqual(saveJobs.toSorted(), requiredJobs.toSorted(), 'Each Linux apt install job must restore and guard-save exactly one apt archive cache.');
}

const aptJob = `jobs:
  native-linux:
    steps:
      - name: Restore cached Linux apt archives
        id: apt-cache
        uses: actions/cache/restore@v4
        with:
          path: \${{ runner.temp }}/apt-archives
          key: \${{ steps.apt-key.outputs.key }}
      - name: Save Linux apt archives
        if: \${{ steps.apt-cache.outputs.cache-hit != 'true' && ${trusted.slice(4, -3)} }}
        uses: actions/cache/save@v4
        with:
          path: \${{ runner.temp }}/apt-archives
          key: \${{ steps.apt-key.outputs.key }}
`;

test('apt cache validator accepts a trusted save and rejects untrusted ones', () => {
  validateAptCaches(aptJob, {requiredJobs: ['native-linux']});
  for (const mutate of [
    text => text.replace("github.ref == 'refs/heads/main'", "github.ref != ''"),
    text => text.replace("(github.event_name == 'push' || github.event_name == 'workflow_dispatch')", 'true'),
    text => text.replace(/ {8}if: .*\n/, ''),
    text => text.replace(/key: .*\n$/, 'key: apt-static\n'),
    text => text.replace(/path: .*apt-archives/, 'path: output/signing'),
    text => text.replace('actions/cache/restore@v4', 'actions/cache@v4'),
  ]) assert.throws(() => validateAptCaches(mutate(aptJob), {requiredJobs: ['native-linux']}));
  assert.throws(() => validateAptCaches(aptJob, {requiredJobs: []}));
  assert.throws(() => validateAptCaches(aptJob, {forbid: true}));
});

test('CI workflow caches Linux apt archives only through trusted saves', async () => {
  const source = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  validateAptCaches(source, {requiredJobs: ['desktop', 'native-linux']});
  const installs = source.split('\n').filter(line => /ci-linux-apt-deps\.sh install/.test(line)).length;
  assert.equal(installs, 2, 'Both Linux dependency installs must use the cached installer.');
  assert.ok(!/apt-get install/.test(source), 'Linux packages must be installed through scripts/ci-linux-apt-deps.sh so the cache key covers them.');
});

test('release workflows do not use apt caches', async () => {
  for (const name of ['release.yml', 'release-from-ci.yml']) validateAptCaches(await readFile(resolve(root, '.github/workflows', name), 'utf8'), {forbid: true});
});
