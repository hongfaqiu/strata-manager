import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  IGNORED_POLICY, WINDOWS_IGNORED_POLICY, targetPolicy, parseListing, parseCargoArtifacts, attachInventory, makePlan,
  validatePlan, selectionArgs, selectionBatches, argvBytes, windowsCommandUnits,
  MAX_FILTER_NAMES, MAX_ARGV_BYTES, MAX_WINDOWS_ARGV_BYTES, MAX_WINDOWS_COMMAND_UNITS, mergeBinaryReports,
  failedTestNames, mergeRetriedBatch, MAX_RETRIED_TESTS,
  parseResults, parseDocResults, validateCoverage, validateIgnoredPolicy, validateShardEvidence, parseOptions, workspaceDocTargets,
} from './ci-linux-native-tests.mjs';

const clone = value => structuredClone(value);
const c = (name, ignored = false) => ({name, kind: 'test', ignored});
const fixtureBinding = {sourceSha: 'a'.repeat(40), lockSha256: 'b'.repeat(64), target: 'x86_64-unknown-linux-gnu', platform: 'linux',
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
      return mergeBinaryReports(full, b.names, selectionBatches(full, b.names).map(names => reportFor(full, names)));
    })}));
}
function reportFor(binary, names) {
  const ignored = names.filter(name => binary.cases.find(c => c.name === name).ignored).length;
  const lines = names.map(name => `test ${name} ... ${binary.cases.find(c => c.name === name).ignored ? 'ignored, explicit fixture' : 'ok'}`).join('\n');
  return parseResults(`running ${names.length} tests\n${lines}\ntest result: ok. ${names.length - ignored} passed; 0 failed; ${ignored} ignored; 0 measured; ${binary.cases.length - names.length} filtered out; finished in 0.10s\n`, binary, names);
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

test('workspace doctest headers and full summaries survive xvfb merged streams without weakening counts', () => {
  const targets = ['strata_local_ipc', 'strata_manager_lib', 'strata_runtime_core', 'strata_update_verifier'];
  const header = target => `   Doc-tests ${target}\n`;
  const result = 'running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n';
  const merged = targets.map(target => header(target) + result).join('\n');
  const split = {stdout: result.repeat(4), stderr: targets.map(header).join('')};
  const expected = parseDocResults(split, targets);
  assert.deepEqual(parseDocResults({stdout: merged, stderr: 'Secret Service daemon exit status: 0\n'}, targets), expected);
  assert.equal(expected.targets.length, 4); assert.equal(expected.summaries.length, 4);
  for (const invalid of [
    merged.replace(header(targets[0]), ''),
    merged.replace(header(targets[0]), header(targets[1])),
    merged.replace(header(targets[0]), header('unknown_crate')),
    merged + header(targets[0]) + result,
    merged.replace('0 failed;', '1 failed;'),
    merged.replace('0 filtered out;', '1 filtered out;'),
    merged.replace('running 0 tests', 'running 1 test'),
    merged.replace('test result: ok.', 'test result: FAILED.'),
    merged.replace('finished in 0.00s', 'finished in broken'),
  ]) assert.throws(() => parseDocResults({stdout: invalid, stderr: ''}, targets));
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

test('selection uses exact positive OR filters without dropping a longer substring sibling', () => {
  const binary = {id: 'fixture', cases: [c('m::a'), c('m::ab'), c('other::ignored', true)]};
  assert.deepEqual(selectionArgs(binary, ['m::ab']), ['--exact', '--test-threads=1', '--color', 'never', '--format', 'pretty', 'm::ab']);
  assert.deepEqual(selectionArgs(binary, ['m::a', 'm::ab', 'other::ignored']), ['--exact', '--test-threads=1', '--color', 'never', '--format', 'pretty']);
  assert.throws(() => selectionArgs(binary, ['missing']));
  assert.throws(() => selectionArgs(binary, ['m::a', 'm::a']));
  assert.throws(() => selectionArgs(binary, []));
});

test('positive filters are batched below both name and UTF-8 argv limits without omissions', () => {
  const binary = {id: 'bounded', executable: '/fixture/libtest', cases: Array.from({length: 300}, (_, index) => c(`m::case_${String(index).padStart(3, '0')}`, index === 259))};
  const selected = binary.cases.slice(0, 260).map(c => c.name);
  const batches = selectionBatches(binary, selected);
  assert.deepEqual(batches.map(b => b.length), [128, 128, 4]);
  assert.deepEqual(batches.flat(), selected);
  assert.throws(() => selectionArgs(binary, selected));
  for (const batch of batches) {
    assert.ok(batch.length <= MAX_FILTER_NAMES);
    assert.ok(argvBytes(binary, [...selectionArgs(binary, batch), '--list']) < MAX_ARGV_BYTES);
  }
  const reports = batches.map(names => reportFor(binary, names));
  const merged = mergeBinaryReports(binary, selected, reports);
  assert.equal(merged.passed, 259); assert.equal(merged.ignored, 1); assert.equal(merged.filtered, 40);
  assert.throws(() => mergeBinaryReports(binary, selected, reports.slice(1)));
  assert.throws(() => mergeBinaryReports(binary, selected, [reports[0], reports[0], reports[2]]));
  const filtered = clone(reports); filtered[0].filtered++; assert.throws(() => mergeBinaryReports(binary, selected, filtered));
  const ignored = clone(reports); ignored[2].cases.at(-1).status = 'ok'; assert.throws(() => mergeBinaryReports(binary, selected, ignored));
  const utf8 = {id: 'utf8', cases: [...Array.from({length: 100}, (_, index) => c(`unicode::${'界'.repeat(400)}_${String(index).padStart(3, '0')}`)), c('outside')]};
  const byteBatches = selectionBatches(utf8, utf8.cases.slice(0, 100).map(c => c.name));
  assert.ok(byteBatches.length > 1);
  for (const batch of byteBatches) assert.ok(argvBytes(utf8, [...selectionArgs(utf8, batch), '--list']) < MAX_ARGV_BYTES);
  const oversized = {id: 'oversized', cases: [c('界'.repeat(40000)), c('outside')]};
  assert.throws(() => selectionBatches(oversized, [oversized.cases[0].name]));
  const full = selectionBatches(binary, binary.cases.map(c => c.name));
  assert.equal(full.length, 1); assert.equal(selectionArgs(binary, full[0]).length, 6);
});

test('a truly empty executable runs once while empty partial selections are rejected', () => {
  const empty = {id: 'empty', cases: []};
  assert.deepEqual(selectionBatches(empty, []), [[]]);
  const result = reportFor(empty, []);
  assert.equal(mergeBinaryReports(empty, [], [result]).passed, 0);
  assert.throws(() => mergeBinaryReports(empty, [], []));
  assert.throws(() => mergeBinaryReports(empty, [], [result, result]));
  assert.throws(() => selectionBatches({id: 'nonempty', cases: [c('a')]}, []));
  assert.throws(() => selectionBatches({id: 'nonempty', cases: [c('a')]}, ['a', 'a']));
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
  assert.equal(Object.keys(IGNORED_POLICY).length, 7);
  assert.equal(validateIgnoredPolicy(binaries), true);
  assert.throws(() => validateIgnoredPolicy(binaries.slice(1)));
  assert.throws(() => validateIgnoredPolicy([...binaries, {package: 'strata-runtime-core', cases: [c('new::hidden', true)]}]));
  assert.throws(() => validateIgnoredPolicy([...binaries, clone(binaries[0])]));
});

test('external acceptance fixtures require exact reviewed names on both platforms and cannot hide offline contracts', () => {
  const externalNames = [
    'runtime_upgrade::release_zip::download_check::tests::live_official_download_source_probe_readonly',
    'tuning::workloads::tests::check_explicit_agent_patch_fixture',
  ];
  const offlineNames = [
    'runtime_upgrade::release_zip::download_check::tests::network_download_check_validates_range_and_never_claims_full_sha',
    'tuning::workloads::tests::patch_failures_report_static_categories_without_leaking_or_continuing',
  ];
  for (const target of ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc']) {
    const policy = targetPolicy(target).ignoredPolicy;
    const binaries = Object.keys(policy).map(key => {
      const separator = key.indexOf(':');
      return {package: key.slice(0, separator), cases: [c(key.slice(separator + 1), true)]};
    });
    for (const name of externalNames) {
      const key = `strata-runtime-core:${name}`;
      assert.equal(Object.hasOwn(policy, key), true);
      assert.match(policy[key], /^Explicit /);
      const without = binaries.filter(binary => !(binary.package === 'strata-runtime-core' && binary.cases[0].name === name));
      assert.throws(() => validateIgnoredPolicy(without, target));
      for (const substitute of [name + '_unreviewed', name.replace('::tests::', '::other_tests::')]) {
        assert.throws(() => validateIgnoredPolicy([...without, {package: 'strata-runtime-core', cases: [c(substitute, true)]}], target));
      }
      assert.throws(() => validateIgnoredPolicy([...binaries, {package: 'strata-runtime-core', cases: [c(name, true)]}], target));
    }
    for (const name of offlineNames) {
      assert.equal(Object.hasOwn(policy, `strata-runtime-core:${name}`), false);
      assert.equal(validateIgnoredPolicy([...binaries, {package: 'strata-runtime-core', cases: [c(name)]}], target), true);
      assert.throws(() => validateIgnoredPolicy([...binaries, {package: 'strata-runtime-core', cases: [c(name, true)]}], target));
    }
  }
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
  assert.equal(parseOptions(['--target', 'x86_64-pc-windows-msvc', '--shard', '1/3']).target, 'x86_64-pc-windows-msvc');
  for (const args of [['--shard', '3/3'], ['--shard', '1/2'], ['--groups', '8'], ['--ignored', 'true'], ['--target', 'aarch64-pc-windows-msvc'], ['--target', 'x86_64-apple-darwin'], ['--shard', '0/3', '--aggregate', 'proof']]) assert.throws(() => parseOptions(args));
});

test('Windows exact selections bound both UTF-8 argv and the quoted UTF-16 CreateProcess command line', () => {
  const binary = {id: 'windows', executable: 'C:\\private runner\\fixture.exe', platform: 'win32', target: 'x86_64-pc-windows-msvc',
    cases: [...Array.from({length: 100}, (_, index) => c(`unicode::${'界'.repeat(150)}_${String(index).padStart(3, '0')}`)), c('outside')]};
  const selected = binary.cases.slice(0, 100).map(c => c.name);
  const batches = selectionBatches(binary, selected);
  assert.ok(batches.length > 1); assert.deepEqual(batches.flat(), selected);
  for (const names of batches) {
    const args = [...selectionArgs(binary, names), '--list'];
    assert.ok(argvBytes(binary, args) < MAX_WINDOWS_ARGV_BYTES);
    assert.ok(windowsCommandUnits(binary, args) < MAX_WINDOWS_COMMAND_UNITS);
  }
  assert.equal(windowsCommandUnits({executable: 'C:\\test fixture\\file.exe'}, ['a"b', 'path with space\\']),
    '"C:\\test fixture\\file.exe" "a\\"b" "path with space\\\\"'.length + 1);
  const escaped = {id: 'escaped', platform: 'win32', target: binary.target,
    cases: [c(('\\"').repeat(8000)), c('outside')]};
  // Escaping can exceed the UTF-16 budget despite an otherwise safe raw argv.
  assert.ok(argvBytes(escaped, [escaped.cases[0].name]) < MAX_WINDOWS_ARGV_BYTES);
  assert.throws(() => selectionBatches(escaped, [escaped.cases[0].name]));
  const largeExecutable = {...binary, executable: 'C:/'+ 'a'.repeat(25000) + '.exe'};
  assert.throws(() => selectionArgs(largeExecutable, binary.cases.map(c => c.name)));
  assert.throws(() => selectionBatches({...binary, platform: 'linux'}, selected));
});

test('Windows inventory has exactly the fifteen reviewed ignored names and cannot substitute Linux policy', () => {
  const binaries = Object.keys(WINDOWS_IGNORED_POLICY).map((key, index) => {
    const separator = key.indexOf(':'); return {id: `windows-${index}`, package: key.slice(0, separator), packagePath: '.',
      cases: [c(key.slice(separator + 1), true)]};
  });
  const target = 'x86_64-pc-windows-msvc';
  assert.equal(Object.keys(WINDOWS_IGNORED_POLICY).length, 15);
  assert.equal(WINDOWS_IGNORED_POLICY['strata-manager:running_service_connection::tests::explicit_read_only_running_owner'],
    'Explicit read-only acceptance of the explicitly identified live service.');
  assert.equal(IGNORED_POLICY['strata-manager:running_service_connection::tests::explicit_read_only_running_owner'], undefined);
  assert.equal(validateIgnoredPolicy(binaries, target), true);
  assert.throws(() => validateIgnoredPolicy(binaries));
  assert.throws(() => validateIgnoredPolicy(binaries.slice(1), target));
  assert.throws(() => validateIgnoredPolicy([...binaries, {package: 'strata-runtime-core', cases: [c('unreviewed::hidden', true)]}], target));
  const binding = {...fixtureBinding, target, platform: 'win32', ignoredPolicy: WINDOWS_IGNORED_POLICY};
  const plan = makePlan([...binaries, {id: 'active', package: 'fixture', packagePath: '.', cases: [c('a'), c('b'), c('c')]}], 3, binding);
  const reports = fixtureReports(plan); const docs = fixtureDocs(plan);
  const shards = reports.map((report, index) => ({schema: 1, binding: plan.binding, plan, shard: index, reports: [report], docs: index === 0 ? docs : null}));
  assert.equal(validateShardEvidence(shards).summary.ignored, 15);
  for (const mutate of [
    s => { s[1].binding.platform = 'linux'; },
    s => { s[1].binding.target = 'x86_64-unknown-linux-gnu'; },
    s => { s[1].binding.ignoredPolicy = clone(IGNORED_POLICY); },
    s => { s[1].plan.binaries[0].target = 'x86_64-unknown-linux-gnu'; },
    s => { s[1].plan.binaries[0].platform = 'linux'; },
    s => { s[1].binding.lockSha256 = 'c'.repeat(64); },
    s => { s[1].binding.sourceSha = 'd'.repeat(40); },
    s => { s[1].binding.workflow.attempt = '2'; },
    s => { s[1].binding.profile.testDebug = '2'; },
    s => { s[0].docs = null; },
    s => { s[1].docs = clone(s[0].docs); },
    s => { s[0].reports[0].binaries.pop(); },
    s => { s[1].shard = 0; },
  ]) { const invalid = shards.map(value => clone(value)); mutate(invalid); assert.throws(() => validateShardEvidence(invalid)); }
  assert.throws(() => makePlan(binaries, 3, {...binding, platform: 'linux'}));
  assert.equal(targetPolicy(target).platform, 'win32');
});

test('real stable libtest confirms exact OR filters, bounded batches and substring coverage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-libtest-contract-'));
  try {
    const source = join(directory, 'fixture.rs'); const executable = join(directory, process.platform === 'win32' ? 'fixture.exe' : 'fixture');
    const batchNames = Array.from({length: 130}, (_, index) => `batch_${String(index).padStart(3, '0')}`);
    await writeFile(source, '#[test] fn a() {}\n#[test] fn ab() {}\n#[test] fn b() {}\n#[test] #[ignore = "explicit fixture"] fn ignored_fixture() { panic!("must stay ignored") }\n' + batchNames.map(name => `#[test] fn ${name}() { assert!(std::env::args().count() <= 256); }`).join('\n'));
    execFileSync('rustc', ['--test', source, '-o', executable], {encoding: 'utf8', timeout: 60000});
    const all = parseListing(execFileSync(executable, ['--list'], {encoding: 'utf8', timeout: 30000}));
    const ignored = parseListing(execFileSync(executable, ['--list', '--ignored'], {encoding: 'utf8', timeout: 30000}));
    const binary = attachInventory({id: 'real-libtest', executable, platform: process.platform,
      target: process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu'}, all, ignored);
    const names = ['ab', 'b', 'ignored_fixture']; const args = selectionArgs(binary, names);
    assert.deepEqual(parseListing(execFileSync(executable, [...args, '--list'], {encoding: 'utf8', timeout: 30000})).map(c => c.name), names);
    const result = parseResults(execFileSync(executable, args, {encoding: 'utf8', timeout: 30000}), binary, names);
    assert.equal(result.passed, 2); assert.equal(result.ignored, 1); assert.equal(result.filtered, binary.cases.length - names.length);
    assert.deepEqual(parseListing(execFileSync(executable, [...selectionArgs(binary, ['a']), '--list'], {encoding: 'utf8', timeout: 30000})).map(c => c.name), ['a']);
    const selected = [...batchNames, 'ignored_fixture'];
    const batches = selectionBatches(binary, selected);
    assert.deepEqual(batches.map(b => b.length), [128, 3]);
    const reports = batches.map(batch => {
      const args = selectionArgs(binary, batch);
      assert.deepEqual(parseListing(execFileSync(executable, [...args, '--list'], {encoding: 'utf8', timeout: 30000})).map(c => c.name), batch);
      return parseResults(execFileSync(executable, args, {encoding: 'utf8', timeout: 30000}), binary, batch);
    });
    const merged = mergeBinaryReports(binary, selected, reports);
    assert.equal(merged.passed, 130); assert.equal(merged.ignored, 1); assert.equal(merged.filtered, 3);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('a failed batch retries only its failed tests once and keeps complete evidence', () => {
  const binary = {id: 'retry', cases: [c('m::a'), c('m::b'), c('m::ignored', true), c('outside::x')]};
  const names = ['m::a', 'm::b', 'm::ignored'];
  const first = 'running 3 tests\ntest m::a ... ok\ntest m::b ... FAILED\ntest m::ignored ... ignored\n\nfailures:\n\n---- m::b stdout ----\npanicked\n\nfailures:\n    m::b\n\ntest result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 1 filtered out; finished in 4.00s\n';
  const failed = failedTestNames(first, binary, names);
  assert.deepEqual(failed, ['m::b']);
  const retry = parseResults('running 1 test\ntest m::b ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 1.00s\n', binary, failed);
  const merged = mergeRetriedBatch(binary, names, first, failed, retry);
  assert.deepEqual(merged.retried, ['m::b']);
  assert.equal(merged.passed, 2); assert.equal(merged.ignored, 1); assert.equal(merged.filtered, 1); assert.equal(merged.libtestSeconds, 5);
  assert.deepEqual(mergeBinaryReports(binary, names, [merged]).cases.map(x => x.name), names);
  assert.equal(failedTestNames('error: crashed\n', binary, names), null);
  const many = names.map(n => `test ${n} ... FAILED`).join('\n');
  assert.equal(failedTestNames(Array.from({length: MAX_RETRIED_TESTS + 1}, (_, i) => `test m::z${i} ... FAILED`).join('\n'), binary, names), null);
  assert.equal(failedTestNames(many, binary, ['m::a', 'm::b']), null);
  assert.throws(() => mergeRetriedBatch(binary, names, first.replace('test m::a ... ok\n', ''), failed, retry));
});
