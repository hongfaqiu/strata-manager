import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  IGNORED_POLICY, parseListing, parseCargoArtifacts, attachInventory, makePlan,
  validatePlan, selectionArgs, parseResults, validateCoverage, validateIgnoredPolicy, validateShardEvidence, parseOptions, workspaceDocTargets,
} from './ci-linux-native-tests.mjs';

const clone = value => structuredClone(value);
const c = (name, ignored = false) => ({name, kind: 'test', ignored});
const fixtureBinding = {sourceSha: 'a'.repeat(40), lockSha256: 'b'.repeat(64), target: 'x86_64-unknown-linux-gnu',
  groups: 3, rustc: 'rustc fixture', docTargets: ['fixture_lib'], workflow: {repository: 'hongfaqiu/strata-manager', runId: '123', attempt: '1'},
  profile: {devDebug: '0', testDebug: '0', incremental: '0'}};
function fixturePlan() {
  return makePlan([
    {id: 'core:lib:core', package: 'fixture-core', packagePath: 'core', cases: [c('slow::a'), c('slow::ab'), c('fast::a'), c('fast::ignored', true)]},
    {id: 'app:test:integration', package: 'fixture-app', packagePath: 'app', cases: [c('integration::one')]},
    {id: 'empty:bin:empty', package: 'fixture-empty', packagePath: 'empty', cases: []},
  ], 3, fixtureBinding);
}
function fixtureReports(plan) {
  return plan.groups.map(g => ({index: g.index, success: true, inventoryHash: plan.inventoryHash,
    binaries: g.binaries.map(b => {
      const full = plan.binaries.find(expected => expected.id === b.id);
      const cases = b.names.map(name => ({name, status: full.cases.find(c => c.name === name).ignored ? 'ignored' : 'ok'}));
      return {id: b.id, cases, passed: cases.filter(c => c.status === 'ok').length,
        ignored: cases.filter(c => c.status === 'ignored').length};
    })}));
}
function fixtureDocs(plan) {
  return {success: true, sourceSha: plan.binding.sourceSha, inventoryHash: plan.inventoryHash,
    targets: ['fixture_lib'], summaries: [[2, 0, 1, 0, 0, 0.2]], passed: 2, ignored: 1};
}

test('inventory includes ignored and benchmark cases, with a checked complete summary', () => {
  assert.deepEqual(parseListing('a: test\nb: benchmark\n\n1 test, 1 benchmark\n'), [{name: 'a', kind: 'test'}, {name: 'b', kind: 'benchmark'}]);
  assert.deepEqual(parseListing('0 tests, 0 benchmarks\n'), []);
  for (const invalid of ['a: test\n', 'a: test\na: test\n2 tests, 0 benchmarks\n', 'a: test\n0 tests, 0 benchmarks\n', 'unknown: fixture\n0 tests, 0 benchmarks\n']) assert.throws(() => parseListing(invalid));
});

test('Cargo artifacts retain all workspace unit and integration executables, excluding normal bins', () => {
  const workspace = resolve('fixture-workspace');
  const metadata = {workspace_members: ['core', 'app'], packages: [
    {id: 'core', name: 'core', manifest_path: join(workspace, 'core/Cargo.toml')},
    {id: 'app', name: 'app', manifest_path: join(workspace, 'app/Cargo.toml')},
  ]};
  const artifact = (id, targetName, kind, isTest = true) => ({reason: 'compiler-artifact', package_id: id,
    target: {name: targetName, kind: [kind]}, profile: {test: isTest}, executable: join(workspace, `target/${targetName}`)});
  const records = [artifact('core', 'core', 'lib'), artifact('app', 'integration', 'test'), artifact('app', 'normal', 'bin', false), {reason: 'build-finished', success: true}];
  const parse = values => parseCargoArtifacts(values.map(value => JSON.stringify(value)).join('\n'), metadata, workspace);
  assert.equal(parse(records).length, 2);
  assert.equal(parse(records)[0].cwd, join(workspace, 'app'));
  assert.throws(() => parse(records.slice(0, -1)));
  assert.throws(() => parse([...records, records[0]]));
  assert.throws(() => parse([{...records[0], package_id: 'foreign'}, ...records.slice(1)]));
  assert.throws(() => parse([...records.slice(0, -1), {reason: 'build-finished', success: false}]));
});

test('ignored status is learned independently without executing ignored cases', () => {
  const full = parseListing('a: test\nb: test\n2 tests, 0 benchmarks\n');
  const ignored = parseListing('b: test\n1 test, 0 benchmarks\n');
  assert.deepEqual(attachInventory({id: 'fixture'}, full, ignored).cases, [c('a'), c('b', true)]);
  assert.throws(() => attachInventory({}, full, [{name: 'missing', kind: 'test'}]));
});

test('workspace doctests include mixed desktop crate types and every Cargo library kind', () => {
  const metadata = {workspace_members: ['desktop', 'ipc', 'runtime', 'verifier'], packages: [
    {id: 'desktop', targets: [{name: 'strata_manager_lib', kind: ['staticlib', 'cdylib', 'rlib'], doctest: true}, {name: 'strata-manager', kind: ['bin'], doctest: true}]},
    {id: 'ipc', targets: [{name: 'strata_local_ipc', kind: ['lib'], doctest: true}]},
    {id: 'runtime', targets: [{name: 'strata_runtime_core', kind: ['lib'], doctest: true}]},
    {id: 'verifier', targets: [{name: 'strata_update_verifier', kind: ['lib'], doctest: true}, {name: 'disabled_lib', kind: ['lib'], doctest: false}]},
    {id: 'dependency', targets: [{name: 'foreign_library', kind: ['lib'], doctest: true}]},
  ]};
  assert.deepEqual(workspaceDocTargets(metadata), ['strata_local_ipc', 'strata_manager_lib', 'strata_runtime_core', 'strata_update_verifier']);
  for (const kind of ['lib', 'rlib', 'dylib', 'staticlib', 'cdylib', 'proc-macro']) {
    assert.deepEqual(workspaceDocTargets({workspace_members: ['fixture'], packages: [{id: 'fixture', targets: [{name: 'fixture-library', kind: [kind], doctest: true}]}]}), ['fixture_library']);
  }
  const missing = clone(metadata); missing.packages.shift(); assert.throws(() => workspaceDocTargets(missing));
  const ambiguous = clone(metadata); delete ambiguous.packages[0].targets[0].doctest; assert.throws(() => workspaceDocTargets(ambiguous));
});

test('module scheduling is deterministic and preserves every test and empty executable once', () => {
  const plan = fixturePlan();
  assert.equal(validatePlan(plan), true);
  assert.equal(plan.inventoryHash, fixturePlan().inventoryHash);
  const owner = name => plan.groups.find(g => g.binaries.some(b => b.names.includes(name))).index;
  assert.equal(owner('slow::a'), owner('slow::ab'));
  const broken = clone(plan); broken.groups[0].binaries.push(clone(broken.groups[1].binaries[0]));
  assert.throws(() => validatePlan(broken));
  const omitted = clone(plan); omitted.groups.pop(); assert.throws(() => validatePlan(omitted));
  const altered = clone(plan); altered.binding.sourceSha = 'c'.repeat(40); assert.throws(() => validatePlan(altered));
});

test('selection skips exact whole names without dropping a longer substring sibling', () => {
  const binary = {id: 'fixture', cases: [c('m::a'), c('m::ab'), c('other::ignored', true)]};
  assert.deepEqual(selectionArgs(binary, ['m::ab']), ['--exact', '--test-threads=1', '--color', 'never', '--format', 'pretty', '--skip', 'm::a', '--skip', 'other::ignored']);
  assert.throws(() => selectionArgs(binary, ['missing']));
  assert.throws(() => selectionArgs(binary, ['m::a', 'm::a']));
});

test('actual output must match selected names, default ignored status and all summary counters', () => {
  const binary = {id: 'fixture', cases: [c('m::a'), c('m::ignored', true), c('outside::a')]};
  const valid = 'running 2 tests\ntest m::a ... ok\ntest m::ignored ... ignored, explicit fixture\ntest result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 1 filtered out; finished in 0.10s\n';
  const result = parseResults(valid, binary, ['m::a', 'm::ignored']);
  assert.equal(result.cases[1].reason, 'explicit fixture');
  for (const invalid of [valid.replace('m::a ...', 'unexpected ...'), valid.replace('1 ignored;', '0 ignored;'), valid.replace('1 filtered out;', '2 filtered out;'), valid.replace('m::a ... ok', 'm::a ... FAILED'), valid.replace('m::ignored ... ignored, explicit fixture', 'm::ignored ... ok'), valid.replace('running 2', 'running 3')]) assert.throws(() => parseResults(invalid, binary, ['m::a', 'm::ignored']));
});

test('aggregate requires complete single coverage and bound full workspace doc evidence', () => {
  const plan = fixturePlan(); const reports = fixtureReports(plan); const docs = fixtureDocs(plan);
  assert.deepEqual(validateCoverage(plan, reports, docs), {success: true, tests: 5, passed: 4, ignored: 1,
    binaries: 3, groups: 3, inventoryHash: plan.inventoryHash, docs});
  assert.throws(() => validateCoverage(plan, reports.slice(1), docs));
  assert.throws(() => validateCoverage(plan, [reports[0], reports[0], reports[2]], docs));
  assert.throws(() => validateCoverage(plan, reports, null));
  assert.throws(() => validateCoverage(plan, reports, {...docs, inventoryHash: 'wrong'}));
  assert.throws(() => validateCoverage(plan, reports, {...docs, targets: []}));
  assert.throws(() => validateCoverage(plan, reports, {...docs, summaries: [[2, 1, 1, 0, 0, 0.2]]}));
  const omitted = clone(reports); const selected = omitted.find(g => g.binaries.some(b => b.cases.length)); selected.binaries.find(b => b.cases.length).cases.pop();
  assert.throws(() => validateCoverage(plan, omitted, docs));
  const wrongStatus = clone(reports); wrongStatus.flatMap(g => g.binaries).flatMap(b => b.cases).find(c => c.status === 'ignored').status = 'ok';
  assert.throws(() => validateCoverage(plan, wrongStatus, docs));
});

test('only the explicit reviewed Linux ignored names are permitted', () => {
  const binaries = Object.entries(IGNORED_POLICY).map(([key]) => {
    const separator = key.indexOf(':'); return {package: key.slice(0, separator), cases: [c(key.slice(separator + 1), true)]};
  });
  assert.equal(validateIgnoredPolicy(binaries), true);
  assert.throws(() => validateIgnoredPolicy(binaries.slice(1)));
  assert.throws(() => validateIgnoredPolicy([...binaries, {package: 'strata-runtime-core', cases: [c('new::hidden', true)]}]));
  assert.throws(() => validateIgnoredPolicy([...binaries, clone(binaries[0])]));
});

test('independent runner evidence cannot mix profiles, toolchains, sources, ignored policies or doc owners', () => {
  const policyBinaries = Object.entries(IGNORED_POLICY).map(([key], index) => {
    const separator = key.indexOf(':'); return {id: `policy-${index}`, package: key.slice(0, separator), packagePath: `policy-${index}`, cases: [c(key.slice(separator + 1), true)]};
  });
  const plan = makePlan([...policyBinaries, {id: 'active', package: 'fixture', packagePath: '.', cases: [c('a'), c('b'), c('c')]}], 3, {...fixtureBinding, ignoredPolicy: IGNORED_POLICY});
  const reports = fixtureReports(plan); const docs = fixtureDocs(plan);
  const shards = reports.map((report, index) => ({schema: 1, binding: plan.binding, plan, shard: index, reports: [report], docs: index === 0 ? docs : null}));
  assert.equal(validateShardEvidence(shards).summary.passed, 3);
  for (const mutate of [
    s => { s[1].binding.sourceSha = 'd'.repeat(40); },
    s => { s[1].binding.rustc = 'another compiler'; },
    s => { s[1].binding.profile.testDebug = '2'; },
    s => { s[1].binding.workflow.attempt = '2'; },
    s => { s[1].binding.workflow.runId = '124'; },
    s => { s[1].binding.ignoredPolicy = {}; },
    s => { s[1].shard = 0; },
    s => { s[0].docs = null; },
    s => { s[1].docs = clone(s[0].docs); },
    s => { s[0].docs.sourceSha = 'e'.repeat(40); },
  ]) { const invalid = shards.map(value => clone(value)); mutate(invalid); assert.throws(() => validateShardEvidence(invalid)); }
});

test('CLI uses zero-based independent shards and refuses invalid or unbounded selection', () => {
  assert.deepEqual(parseOptions(['--shard', '0/3']).shard, {index: 0, count: 3});
  assert.deepEqual(parseOptions(['--groups', '4', '--shard', '3/4']).shard, {index: 3, count: 4});
  for (const args of [['--shard', '3/3'], ['--shard', '1/2'], ['--groups', '8'], ['--ignored', 'true'], ['--target', 'x86_64-pc-windows-msvc'], ['--shard', '0/3', '--aggregate', 'proof']]) assert.throws(() => parseOptions(args));
});

test('real stable libtest confirms exact skip semantics, ignored parsing and substring coverage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-libtest-contract-'));
  try {
    const source = join(directory, 'fixture.rs'); const executable = join(directory, process.platform === 'win32' ? 'fixture.exe' : 'fixture');
    await writeFile(source, '#[test] fn a() {}\n#[test] fn ab() {}\n#[test] #[ignore = "explicit fixture"] fn ignored_fixture() { panic!("must stay ignored") }\n');
    execFileSync('rustc', ['--test', source, '-o', executable], {encoding: 'utf8', timeout: 60000});
    const all = parseListing(execFileSync(executable, ['--list'], {encoding: 'utf8', timeout: 30000}));
    const ignored = parseListing(execFileSync(executable, ['--list', '--ignored'], {encoding: 'utf8', timeout: 30000}));
    const binary = attachInventory({id: 'real-libtest'}, all, ignored);
    const args = selectionArgs(binary, ['ab', 'ignored_fixture']);
    assert.deepEqual(parseListing(execFileSync(executable, [...args, '--list'], {encoding: 'utf8', timeout: 30000})).map(c => c.name), ['ab', 'ignored_fixture']);
    const result = parseResults(execFileSync(executable, args, {encoding: 'utf8', timeout: 30000}), binary, ['ab', 'ignored_fixture']);
    assert.equal(result.passed, 1); assert.equal(result.ignored, 1); assert.equal(result.filtered, 1);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
