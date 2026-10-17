/** Run every default Cargo test with serial libtest groups on independent native runners. */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, lstat, realpath, access, readdir } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
const fail = message => { throw new Error(message); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = values => [...values].sort(compare);
function workflowBinding() {
  if (process.env.GITHUB_ACTIONS !== 'true') return {repository: 'local', runId: 'local', attempt: 'local'};
  const {GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt} = process.env;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^[1-9]\d*$/.test(runId ?? '') || !/^[1-9]\d*$/.test(attempt ?? '')) fail('The actual workflow run and attempt are required.');
  return {repository, runId, attempt};
}
export const IGNORED_POLICY = Object.freeze({
  'strata-manager:configuration_details::tests::live_configuration_match_preserves_the_existing_owned_model': 'Explicit read-only acceptance against the user running supervisor.',
  'strata-runtime-core:discovery::tests::live_installation_discovery_is_read_only': 'Explicit live read-only installation verification.',
  'strata-runtime-core:installation::tests::official_archive_prepares_without_git_and_returns_only_a_setup_profile': 'Separately verified official source archive and real private venv; no model download.',
  'strata-runtime-core:model_inspect::tests::isolated_inspect_task_reports_output_and_cancels_without_model_start': 'Explicit isolated Python process fixture requiring an absolute interpreter.',
  'strata-runtime-core:runtime_upgrade::release_zip::download_check::tests::live_official_download_source_probe_readonly': 'Explicit live official/proxy source acceptance; current network metadata and at most 64 KiB per source, without runtime mutation.',
  'strata-runtime-core:runtime_upgrade::release_zip::tests::official_source_zip_fixture_from_environment': 'Separately downloaded official source ZIP fixture.',
  'strata-runtime-core:tuning::workloads::tests::check_explicit_agent_patch_fixture': 'Explicit saved Agent patch source supplied through STRATA_TUNING_AGENT_SOURCE_FILE; bounded static validation without model or source execution.',
});

export const WINDOWS_IGNORED_POLICY = Object.freeze({
  ...IGNORED_POLICY,
  'strata-manager:running_service_connection::tests::explicit_read_only_running_owner': 'Explicit read-only acceptance of the explicitly identified live service.',
  'strata-manager:runtime_update_queue::tests::live_running_model_refuses_unconfirmed_update_without_changing_service_or_intent': 'Explicit live refusal check without stop confirmation or update mutation.',
  'strata-manager:runtime_updates::tests::live_legacy_update_metadata_and_runtime_detection_keep_service_identity': 'Explicit live legacy metadata verification; writes only the release-info cache.',
  'strata-runtime-core:discovery::tests::live_running_service_reports_exact_config_without_changing_process_or_files': 'Explicit live running-service read-only verification.',
  'strata-runtime-core:installation::tests::installer_owned_directory_rejects_linked_database': 'Requires Windows symbolic-link privilege; link policy is covered without elevation.',
  'strata-runtime-core:installation::tests::installer_owned_root_live_readonly_verifies_existing_msix_mapping': 'Explicit read-only verification of the current packaged process data path.',
  'strata-runtime-core:runtime_upgrade::release_zip::tests::zip_update_listener_fixture': 'Child-only TCP listener started explicitly by ownership regression tests.',
  'strata-runtime-core:runtime_upgrade::tests::real_fixed_engine_download_redirect_hash_and_extraction_without_execution': 'Separately downloaded official source/engine and private Python dependencies; no engine or GPU execution.',
});
export function targetPolicy(target) {
  if (target === 'x86_64-pc-windows-msvc') return {target, platform: 'win32', ignoredPolicy: WINDOWS_IGNORED_POLICY, maxArgvBytes: 24 * 1024};
  if (/^[a-z0-9_-]+-unknown-linux-gnu$/.test(target ?? '')) return {target, platform: 'linux', ignoredPolicy: IGNORED_POLICY, maxArgvBytes: 100 * 1024};
  fail('Only reviewed Linux GNU and Windows MSVC native targets are allowed.');
}
function validateTargetBinding(binding) {
  const policy = targetPolicy(binding?.target);
  if (binding.platform !== policy.platform) fail('Native platform differs from the reviewed target.');
  return policy;
}
export function validateIgnoredPolicy(binaries, target = 'x86_64-unknown-linux-gnu') {
  const policy = targetPolicy(target);
  const ignored = binaries.flatMap(b => b.cases.filter(c => c.ignored).map(c => `${b.package}:${c.name}`));
  if (!same(sorted(ignored), sorted(Object.keys(policy.ignoredPolicy)))) fail(`The reviewed ${policy.platform} default ignored policy changed.`);
  return true;
}

const inventoryForHash = binaries => binaries.map(({id, package: packageName, packagePath, platform, target, cases}) => ({id, package: packageName, packagePath, platform, target, cases}));
const planHash = plan => hash(JSON.stringify({binding: plan.binding, inventory: inventoryForHash(plan.binaries), groups: plan.groups}));
// Scheduling hints only: no test deadline, selection or assertion depends on them.
// Mean serial per-module seconds from the successful PR CI runs 38953779378 and
// 39016411239 (timestamps between libtest result lines). Integration-test binaries
// have only a root module, so their hints are bound to the binary as 'kind:name (root)'.
const knownSeconds = Object.freeze({
  'tuning::restart::tests': 207, 'runtime_upgrade::tests': 53, 'test:lifecycle (root)': 52,
  'idle_model::tests': 44, 'tuning::workloads::tests': 33, 'installation::download::tests': 31,
  'startup::tests': 24, 'setup_handoff::tests': 21, 'health_watch::tests': 20,
  'tuning::tests': 16, 'native_probe_tests': 13, 'request_capture::tests': 12,
  'runtime_upgrade::release_zip::tests': 11, 'runtime_upgrade::release_zip::download_check::tests': 10,
  'installation::tests': 9, 'test:manager_mcp (root)': 7, 'test:mcp_stdio (root)': 7,
  'external_management::tests': 7, 'tuning::status_tests': 7, 'diagnostics::tests': 6,
  'tuning_service_operation_tests': 6, 'registry_handoff::tests': 6, 'analytics::tests': 6,
  'chat_runtime::tests': 5, 'window_close_tests': 5, 'tuning_contract_tests': 5,
  'policy::tests': 4, 'service_sharing::tests': 3, 'disk::tests': 3,
  'runtime_upgrade::release_zip::download_source::tests': 3, 'manager_mcp::tests': 3,
});
const windowsKnownSeconds = Object.freeze({
  'tuning::restart::tests': 169, 'test:lifecycle (root)': 58, 'runtime_upgrade::tests': 37,
  'idle_model::tests': 25, 'tuning::workloads::tests': 19, 'setup_handoff::tests': 16,
  'startup::tests': 16, 'installation::download::tests': 15, 'runtime_upgrade::release_zip::tests': 14,
  'network_runtime_tests': 14, 'native_probe_tests': 12, 'tuning::tests': 12,
  'health_watch::tests': 11, 'request_capture::tests': 10, 'test:manager_mcp (root)': 10,
  'supervisor_client::tests': 8, 'tuning_service_operation_tests': 7, 'runtime_update_queue::tests': 6,
  'runtime_upgrade::release_zip::download_check::tests': 6, 'legacy::tests': 6, 'processes::tests': 6,
  'diagnostics::tests': 5, 'installation::tests': 4, 'tuning::status_tests': 4,
  'external_management::tests': 4, 'registry_handoff::tests': 4, 'discovery::tests': 3,
});
// Unmeasured modules: measured small modules average under 0.1 s per case, while
// integration-test binaries start real processes, so their roots stay heavier.
export function moduleWeight(binary, module, active, platform) {
  if (!active) return 0;
  const hints = platform === 'win32' ? windowsKnownSeconds : knownSeconds;
  const kindName = binary.id.slice(binary.id.indexOf(':') + 1);
  const hint = module === '(root)' ? hints[`${kindName} (root)`] : hints[module];
  if (hint !== undefined) return hint;
  return module === '(root)' && kindName.startsWith('test:') ? active * 10 : active * 0.5;
}

export function parseListing(text) {
  const cases = []; let summary;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const item = /^(\S+): (test|benchmark)$/.exec(line);
    const total = /^(\d+) tests?, (\d+) benchmarks?$/.exec(line);
    if (item) cases.push({name: item[1], kind: item[2]});
    else if (total && !summary) summary = [Number(total[1]), Number(total[2])];
    else fail(`Unexpected libtest inventory line: ${line}`);
  }
  if (!summary || new Set(cases.map(c => c.name)).size !== cases.length
      || cases.filter(c => c.kind === 'test').length !== summary[0]
      || cases.filter(c => c.kind === 'benchmark').length !== summary[1]) fail('Incomplete or duplicate libtest inventory.');
  return cases.sort((a, b) => compare(a.name, b.name));
}

export function parseCargoArtifacts(text, metadata, workspace, target = 'x86_64-unknown-linux-gnu') {
  const policy = targetPolicy(target);
  if (!Array.isArray(metadata?.packages) || !Array.isArray(metadata.workspace_members)) fail('Cargo workspace metadata is required.');
  const members = new Set(metadata.workspace_members);
  const packages = new Map(metadata.packages.map(p => [p.id, p]));
  const binaries = []; const ids = new Set(); const paths = new Set(); let finished = 0;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    let message; try { message = JSON.parse(line); } catch { fail('Cargo emitted invalid JSON.'); }
    if (message.reason === 'build-finished') {
      if (message.success !== true) fail('Cargo test build failed.');
      finished++;
    }
    if (message.reason !== 'compiler-artifact' || message.profile?.test !== true || !message.executable) continue;
    const p = packages.get(message.package_id);
    if (!p || !members.has(p.id) || !isAbsolute(message.executable) || !Array.isArray(message.target?.kind)
        || typeof message.target.name !== 'string' || !isAbsolute(p.manifest_path)) fail('Unbound workspace test executable.');
    const cwd = dirname(p.manifest_path); const packagePath = relative(workspace, cwd).replaceAll('\\', '/');
    if (packagePath === '..' || packagePath.startsWith('../') || isAbsolute(packagePath)) fail('Test package is outside this workspace.');
    const id = `${packagePath || '.'}:${message.target.kind.join(',')}:${message.target.name}`;
    if (ids.has(id) || paths.has(message.executable)) fail('Duplicate Cargo test executable.');
    ids.add(id); paths.add(message.executable);
    binaries.push({id, package: p.name, packagePath, platform: policy.platform, target, executable: message.executable, cwd});
  }
  if (finished !== 1 || !binaries.length || [...members].some(id => !packages.has(id))) fail('Incomplete successful Cargo workspace test build.');
  return binaries.sort((a, b) => compare(a.id, b.id));
}

export function attachInventory(binary, all, ignored) {
  const ignoredNames = new Set(ignored.map(c => c.name));
  if (ignored.some(c => !all.some(a => a.name === c.name && a.kind === c.kind))) fail('Ignored tests are absent from full inventory.');
  return {...binary, cases: all.map(c => ({...c, ignored: ignoredNames.has(c.name)}))};
}

export function workspaceDocTargets(metadata) {
  if (!Array.isArray(metadata?.packages) || !Array.isArray(metadata.workspace_members)) fail('Cargo workspace metadata is required for doc tests.');
  const libraries = new Set(['lib', 'rlib', 'dylib', 'staticlib', 'cdylib', 'proc-macro']);
  const packages = new Map(metadata.packages.map(p => [p.id, p]));
  const targets = [];
  for (const id of metadata.workspace_members) {
    const p = packages.get(id);
    if (!p || !Array.isArray(p.targets)) fail('Incomplete workspace doc-target metadata.');
    for (const target of p.targets) {
      if (!Array.isArray(target.kind)) fail('Invalid Cargo target kind.');
      if (!target.kind.some(kind => libraries.has(kind))) continue;
      if (typeof target.doctest !== 'boolean' || typeof target.name !== 'string' || !/^\S+$/.test(target.name)) fail('Invalid Cargo library doctest metadata.');
      if (target.doctest) targets.push(target.name.replaceAll('-', '_'));
    }
  }
  return targets.sort(compare);
}

export function parseDocResults(run, targets) {
  // xvfb-run redirects the wrapped command's stderr to stdout. Cargo's
  // Doc-tests headers therefore may arrive in either captured stream.
  const text = `${run.stdout}\n${run.stderr}`.replaceAll('\r\n', '\n');
  const observed = [...text.matchAll(/^[ \t]*Doc-tests (\S+)[ \t]*$/gm)].map(match => match[1]).sort(compare);
  const lines = [...text.matchAll(/^test result: (.*)$/gm)].map(match => match[1]);
  const summaries = lines.map(line => {
    const match = /^ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in ([\d.]+)s$/.exec(line);
    if (!match) fail('Unexpected or failed workspace doc-test summary.');
    return match.slice(1).map(Number);
  });
  const running = [...text.matchAll(/^running (\d+) tests?$/gm)].map(match => Number(match[1]));
  if (!same(observed, sorted(targets)) || summaries.length !== targets.length || running.length !== targets.length
      || summaries.some((s, index) => s.slice(0, 5).some(n => !Number.isSafeInteger(n) || n < 0)
        || s[1] || s[3] || s[4] || !Number.isFinite(s[5]) || s[5] < 0 || running[index] !== s[0] + s[2])) fail('Workspace doc-test summaries are incomplete or failed.');
  return {targets: observed, summaries, passed: summaries.reduce((sum, s) => sum + s[0], 0),
    ignored: summaries.reduce((sum, s) => sum + s[2], 0)};
}

export function makePlan(binaries, count, binding) {
  const policy = targetPolicy(binding?.target);
  binding = {...binding, platform: binding.platform ?? policy.platform};
  validateTargetBinding(binding);
  binaries = binaries.map(b => ({...b, target: b.target ?? binding.target, platform: b.platform ?? binding.platform}));
  if (!Number.isSafeInteger(count) || count < 1 || count > 4 || !binaries.length
      || new Set(binaries.map(b => b.id)).size !== binaries.length) fail('Invalid bounded group plan.');
  const groups = Array.from({length: count}, (_, index) => ({index, estimatedSeconds: 0, binaries: []}));
  const modules = [];
  for (const binary of binaries) {
    if (!Array.isArray(binary.cases) || new Set(binary.cases.map(c => c.name)).size !== binary.cases.length) fail('Invalid binary case inventory.');
    const entries = new Map();
    for (const c of binary.cases) {
      if (typeof c.name !== 'string' || !/^\S+$/.test(c.name) || !['test', 'benchmark'].includes(c.kind) || typeof c.ignored !== 'boolean') fail('Invalid case identity.');
      const module = c.name.includes('::') ? c.name.slice(0, c.name.lastIndexOf('::')) : '(root)';
      if (!entries.has(module)) entries.set(module, []);
      entries.get(module).push(c.name);
    }
    if (!entries.size) entries.set('(empty)', []);
    for (const [module, names] of entries) {
      const active = names.filter(name => !binary.cases.find(c => c.name === name).ignored).length;
      modules.push({binaryId: binary.id, module, names: sorted(names),
        weight: moduleWeight(binary, module, active, policy.platform)});
    }
  }
  modules.sort((a, b) => b.weight - a.weight || compare(`${a.binaryId}:${a.module}`, `${b.binaryId}:${b.module}`));
  for (const module of modules) {
    const group = [...groups].sort((a, b) => a.estimatedSeconds - b.estimatedSeconds || a.index - b.index)[0];
    let entry = group.binaries.find(b => b.id === module.binaryId);
    if (!entry) { entry = {id: module.binaryId, names: [], modules: []}; group.binaries.push(entry); }
    entry.names.push(...module.names); entry.modules.push(module.module); group.estimatedSeconds += module.weight;
  }
  for (const group of groups) {
    group.binaries.sort((a, b) => compare(a.id, b.id));
    for (const b of group.binaries) { b.names.sort(compare); b.modules.sort(compare); }
  }
  const inventory = inventoryForHash(binaries);
  const inventoryHash = hash(JSON.stringify({binding, inventory, groups}));
  const plan = {schema: 1, binding, inventoryHash, binaries, groups};
  validatePlan(plan);
  return plan;
}

export function validatePlan(plan) {
  if (plan?.schema !== 1 || !Array.isArray(plan.binaries) || !Array.isArray(plan.groups)
      || !plan.binaries.length || !plan.groups.length || plan.groups.length > 4) fail('Invalid coverage plan.');
  validateTargetBinding(plan.binding);
  if (plan.inventoryHash !== planHash(plan) || new Set(plan.binaries.map(b => b.id)).size !== plan.binaries.length
      || plan.binaries.some(b => b.target !== plan.binding.target || b.platform !== plan.binding.platform)) fail('The source/platform/inventory/group binding changed.');
  const expected = new Set(); const actual = new Set(); const emptyExpected = new Set(); const emptyActual = new Set();
  for (const b of plan.binaries) {
    if (!b.cases.length) emptyExpected.add(b.id);
    for (const c of b.cases) {
      const key = `${b.id}\0${c.name}`;
      if (expected.has(key)) fail('Duplicate planned test.');
      expected.add(key);
    }
  }
  for (const [index, g] of plan.groups.entries()) {
    if (g.index !== index) fail('Group indexes are not complete.');
    for (const b of g.binaries) {
      if (!plan.binaries.some(expectedBinary => expectedBinary.id === b.id)) fail('Unknown planned binary.');
      if (!b.names.length) { if (emptyActual.has(b.id)) fail('Duplicate empty binary.'); emptyActual.add(b.id); }
      for (const name of b.names) {
        const key = `${b.id}\0${name}`;
        if (!expected.has(key) || actual.has(key)) fail('Unexpected or duplicate group test.');
        actual.add(key);
      }
    }
  }
  if (!same(sorted(expected), sorted(actual)) || !same(sorted(emptyExpected), sorted(emptyActual))) fail('Coverage plan omits tests or empty executables.');
  return true;
}

export const MAX_FILTER_NAMES = 128;
export const MAX_ARGV_BYTES = 100 * 1024;
export const MAX_WINDOWS_ARGV_BYTES = 24 * 1024;
export const MAX_WINDOWS_COMMAND_UNITS = 30000;
const libtestFlags = ['--exact', '--test-threads=1', '--color', 'never', '--format', 'pretty'];
function validateSelection(binary, names) {
  if (!Array.isArray(binary.cases) || !Array.isArray(names) || new Set(names).size !== names.length
      || names.some(name => typeof name !== 'string' || name.startsWith('-') || name.includes('\0') || !binary.cases.some(c => c.name === name))
      || !names.length && binary.cases.length) fail('Unknown, duplicate or empty partial test selection.');
}
export function argvBytes(binary, args) {
  // Include argv[0] and each terminating NUL, as /proc/PID/cmdline does.
  return [binary.executable ?? 'libtest', ...args].reduce((sum, arg) => sum + Buffer.byteLength(arg, 'utf8') + 1, 0);
}
function quoteWindowsArg(arg) {
  if (arg && !/[\s"]/u.test(arg)) return arg;
  // CreateProcess receives one UTF-16 command line. Account for the MSVC
  // escaping of backslashes before quotes and the final enclosing quote.
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
export function windowsCommandUnits(binary, args) {
  return [binary.executable ?? 'libtest', ...args].map(quoteWindowsArg).join(' ').length + 1;
}
function argvWithinBudget(binary, args) {
  const policy = targetPolicy(binary.target ?? 'x86_64-unknown-linux-gnu');
  if (binary.platform !== undefined && binary.platform !== policy.platform) fail('Binary platform differs from its target.');
  return argvBytes(binary, args) < policy.maxArgvBytes
    && (policy.platform !== 'win32' || windowsCommandUnits(binary, args) < MAX_WINDOWS_COMMAND_UNITS);
}
export function selectionArgs(binary, names) {
  validateSelection(binary, names);
  const full = names.length === binary.cases.length;
  // Exact positive filters are ORed by stable libtest. Full/zero-case suites
  // need no filters, and do not put their entire inventory in process argv.
  const args = [...libtestFlags, ...(full ? [] : names)];
  if (!full && names.length > MAX_FILTER_NAMES || !argvWithinBudget(binary, [...args, '--list'])) fail('Use bounded batches for this exact test selection.');
  return args;
}
export function selectionBatches(binary, names) {
  validateSelection(binary, names);
  if (names.length === binary.cases.length) { selectionArgs(binary, names); return [sorted(names)]; }
  const batches = []; let current = [];
  for (const name of sorted(names)) {
    const candidate = [...current, name];
    if (candidate.length > MAX_FILTER_NAMES || !argvWithinBudget(binary, [...libtestFlags, ...candidate, '--list'])) {
      if (!current.length) fail('One exact filter exceeds the safe process argv budget.');
      batches.push(current); current = [name];
      if (!argvWithinBudget(binary, [...libtestFlags, name, '--list'])) fail('One exact filter exceeds the safe process argv budget.');
    } else current = candidate;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function parseResults(text, binary, names) {
  const cases = []; const summaries = []; let running;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const begin = /^running (\d+) tests?$/.exec(line);
    const item = /^test (\S+)(?: - should panic)? \.\.\. (ok|ignored(?:, .*)?)$/.exec(line);
    const summary = /^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in ([\d.]+)s$/.exec(line);
    if (begin && running === undefined) running = Number(begin[1]);
    else if (item) cases.push({name: item[1], status: item[2].startsWith('ignored') ? 'ignored' : 'ok', ...(item[2].startsWith('ignored, ') ? {reason: item[2].slice(9)} : {})});
    else if (summary) summaries.push(summary.slice(1).map(Number));
    else fail(`Unexpected or failed libtest result: ${line}`);
  }
  if (summaries.length !== 1 || running !== names.length || new Set(cases.map(c => c.name)).size !== cases.length
      || !same(sorted(cases.map(c => c.name)), sorted(names))) fail('Observed case names differ from the selected inventory.');
  const [passed, failed, ignored, measured, filtered, seconds] = summaries[0];
  const expectedIgnored = names.filter(name => binary.cases.find(c => c.name === name)?.ignored).length;
  if (failed || measured || ignored !== expectedIgnored || passed !== names.length - expectedIgnored
      || filtered !== binary.cases.length - names.length || cases.some(c => (c.status === 'ignored') !== binary.cases.find(expected => expected.name === c.name).ignored)) fail('Libtest summary or ignored status violates the default test contract.');
  return {id: binary.id, passed, ignored, filtered, libtestSeconds: seconds, cases};
}

/** Names that libtest reported as FAILED in one batch; null when the output is not a plain test failure. */
export function failedTestNames(text, binary, names) {
  const failed = [];
  for (const line of text.split(/\r?\n/)) {
    const item = /^test (\S+)(?: - should panic)? \.\.\. FAILED$/.exec(line);
    if (item) failed.push(item[1]);
  }
  const unique = sorted(new Set(failed));
  if (!unique.length || unique.length !== failed.length || unique.some(name => !names.includes(name))
      || unique.length > MAX_RETRIED_TESTS) return null;
  validateSelection(binary, unique);
  return unique;
}
export const MAX_RETRIED_TESTS = 5;
/** Combine a failed batch with one exact rerun of only its failed tests. Every planned case still appears exactly once. */
export function mergeRetriedBatch(binary, names, firstText, failed, retryReport) {
  const first = [];
  for (const line of firstText.split(/\r?\n/)) {
    const item = /^test (\S+)(?: - should panic)? \.\.\. (ok|ignored(?:, .*)?)$/.exec(line);
    if (item) first.push({name: item[1], status: item[2].startsWith('ignored') ? 'ignored' : 'ok', ...(item[2].startsWith('ignored, ') ? {reason: item[2].slice(9)} : {})});
  }
  const seconds = [...firstText.matchAll(/^test result: FAILED\. .* finished in ([\d.]+)s$/gm)].map(m => Number(m[1]));
  if (seconds.length !== 1 || !same(sorted(retryReport.cases.map(c => c.name)), failed)) fail('Retried batch evidence is incomplete.');
  const cases = [...first, ...retryReport.cases];
  if (new Set(cases.map(c => c.name)).size !== cases.length || !same(sorted(cases.map(c => c.name)), sorted(names))) fail('A failed batch did not report every selected test before retry.');
  for (const c of cases) if (c.status !== (binary.cases.find(t => t.name === c.name).ignored ? 'ignored' : 'ok')) fail('A retried batch changed default ignored status.');
  return {id: binary.id, passed: cases.filter(c => c.status === 'ok').length, ignored: cases.filter(c => c.status === 'ignored').length,
    filtered: binary.cases.length - names.length, libtestSeconds: seconds[0] + retryReport.libtestSeconds,
    cases: cases.sort((a, b) => compare(a.name, b.name)), retried: failed};
}

export function mergeBinaryReports(binary, names, reports) {
  const expected = selectionBatches(binary, names);
  if (!Array.isArray(reports) || reports.length !== expected.length) fail('All bounded libtest batches are required.');
  const cases = []; let libtestSeconds = 0;
  for (const [index, report] of reports.entries()) {
    if (report.id !== binary.id || !Array.isArray(report.cases) || !same(sorted(report.cases.map(c => c.name)), expected[index])
        || report.passed !== report.cases.filter(c => c.status === 'ok').length
        || report.ignored !== report.cases.filter(c => c.status === 'ignored').length
        || report.filtered !== binary.cases.length - expected[index].length
        || !Number.isFinite(report.libtestSeconds) || report.libtestSeconds < 0) fail('Batch names or summary counters differ from their exact selection.');
    for (const c of report.cases) {
      const original = binary.cases.find(test => test.name === c.name);
      if (!original || c.status !== (original.ignored ? 'ignored' : 'ok')) fail('A batch changed default ignored status or failed a test.');
    }
    cases.push(...report.cases); libtestSeconds += report.libtestSeconds;
  }
  if (new Set(cases.map(c => c.name)).size !== cases.length || !same(sorted(cases.map(c => c.name)), sorted(names))) fail('Merged batches omit or duplicate selected tests.');
  return {id: binary.id, passed: cases.filter(c => c.status === 'ok').length,
    ignored: cases.filter(c => c.status === 'ignored').length, filtered: binary.cases.length - names.length,
    libtestSeconds, cases: cases.sort((a, b) => compare(a.name, b.name)), batches: reports};
}

export function validateCoverage(plan, reports, docs) {
  validatePlan(plan);
  if (reports.length !== plan.groups.length || !docs || docs.success !== true) fail('All native groups and complete workspace doc tests are required.');
  if (docs.sourceSha !== plan.binding.sourceSha || docs.inventoryHash !== plan.inventoryHash
      || !same(docs.targets, plan.binding.docTargets) || !Array.isArray(docs.summaries) || docs.summaries.length !== docs.targets.length
      || docs.summaries.some(s => !Array.isArray(s) || s.length !== 6 || s.slice(0, 5).some(n => !Number.isSafeInteger(n) || n < 0) || s[1] || s[3] || s[4] || !Number.isFinite(s[5]) || s[5] < 0)
      || docs.passed !== docs.summaries.reduce((sum, s) => sum + s[0], 0)
      || docs.ignored !== docs.summaries.reduce((sum, s) => sum + s[2], 0)) fail('Complete same-source doc-test provenance is required.');
  const indexes = new Set(); const observed = new Set(); let passed = 0; let ignored = 0;
  for (const report of reports) {
    if (report.inventoryHash !== plan.inventoryHash || report.success !== true || !Number.isSafeInteger(report.index) || indexes.has(report.index)) fail('Duplicate, failed or differently bound group evidence.');
    const group = plan.groups[report.index];
    if (!group || !Array.isArray(report.binaries) || !same(sorted(report.binaries.map(b => b.id)), sorted(group.binaries.map(b => b.id)))) fail('Group binary inventory differs.');
    indexes.add(report.index);
    for (const binary of report.binaries) {
      const expected = group.binaries.find(b => b.id === binary.id);
      const full = plan.binaries.find(b => b.id === binary.id);
      const merged = mergeBinaryReports(full, expected.names, binary.batches);
      if (!same(binary.cases, merged.cases) || ['passed', 'ignored', 'filtered', 'libtestSeconds'].some(field => binary[field] !== merged[field])) fail('Merged binary evidence differs from its verified batches.');
      if (!same(sorted(binary.cases.map(c => c.name)), expected.names) || new Set(binary.cases.map(c => c.name)).size !== binary.cases.length) fail('Observed coverage omitted or repeated tests.');
      for (const c of binary.cases) {
        const original = full.cases.find(test => test.name === c.name);
        if (c.status !== (original.ignored ? 'ignored' : 'ok')) fail('Observed test failed or changed default ignored status.');
        const key = `${binary.id}\0${c.name}`;
        if (observed.has(key)) fail('Test ran more than once.');
        observed.add(key);
        if (c.status === 'ok') passed++; else ignored++;
      }
      if (binary.passed !== binary.cases.filter(c => c.status === 'ok').length || binary.ignored !== binary.cases.filter(c => c.status === 'ignored').length) fail('Coverage counters disagree with case evidence.');
    }
  }
  const total = plan.binaries.reduce((sum, b) => sum + b.cases.length, 0);
  if (observed.size !== total) fail('Workspace case coverage is incomplete.');
  return {success: true, tests: total, passed, ignored, binaries: plan.binaries.length,
    groups: reports.length, inventoryHash: plan.inventoryHash, docs};
}

export function validateShardEvidence(shards) {
  if (!Array.isArray(shards) || !shards.length || shards.length > 4) fail('A bounded complete shard set is required.');
  const first = shards[0];
  const policy = validateTargetBinding(first.binding);
  if (!first.binding || first.binding.groups !== shards.length || !/^[a-f0-9]{40}$/.test(first.binding.sourceSha ?? '')
      || !/^[a-f0-9]{64}$/.test(first.binding.lockSha256 ?? '') || typeof first.binding.rustc !== 'string' || !first.binding.rustc.trim()
      || !same(first.binding.ignoredPolicy, policy.ignoredPolicy) || first.binding.profile?.devDebug !== '0'
      || first.binding.profile?.testDebug !== '0' || first.binding.profile?.incremental !== '0') fail('The reviewed source/toolchain/profile/ignored binding is required.');
  for (const s of shards) {
    if (s.schema !== 1 || !same(s.binding, first.binding) || s.plan?.inventoryHash !== first.plan?.inventoryHash) fail('Shard source/inventory bindings differ.');
    validatePlan(s.plan); validateIgnoredPolicy(s.plan.binaries, s.binding.target);
    if (!same(s.binding, s.plan.binding) || s.plan.groups.length !== s.binding.groups || !Number.isSafeInteger(s.shard) || s.shard < 0 || s.shard >= s.plan.groups.length
        || !Array.isArray(s.reports) || s.reports.length !== 1 || s.reports[0].index !== s.shard || s.docs !== null && s.shard !== 0) fail('Shard envelope/source/doc ownership binding differs.');
  }
  const owners = shards.filter(s => s.docs !== null);
  if (owners.length !== 1) fail('Exactly one complete workspace doc-test run is required.');
  const reports = shards.flatMap(s => s.reports); const docs = owners[0].docs;
  return {plan: first.plan, binding: first.binding, reports, docs, summary: validateCoverage(first.plan, reports, docs)};
}

async function run(command, args, {cwd = root, env = process.env, mirror = false, timeoutMs = 1800000, ownedGroup = false, allowExitFailure = false} = {}) {
  const child = spawn(command, args, {cwd, env, detached: ownedGroup && process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = ''; let stderr = ''; let expired = false; let overflow = false; let hardKill;
  const signal = value => {
    try {
      if (ownedGroup && child.pid && process.platform === 'win32') {
        // Kill only this owned PID tree on cancellation/deadline. A plain
        // child.kill() would leave Python/mock supervisor descendants alive.
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
        killer.once('error', () => { try { child.kill(value); } catch {} });
      } else if (ownedGroup && child.pid) process.kill(-child.pid, value);
      else child.kill(value);
    } catch {}
  };
  const terminate = () => { signal('SIGTERM'); hardKill ??= setTimeout(() => signal('SIGKILL'), 10000); };
  const interrupt = () => { expired = true; terminate(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const timer = setTimeout(interrupt, timeoutMs);
  child.stdout.on('data', chunk => { stdout += chunk; if (mirror) process.stdout.write(chunk); if (stdout.length > 32 * 1024 * 1024) { overflow = true; terminate(); } });
  child.stderr.on('data', chunk => { stderr += chunk; if (mirror) process.stderr.write(chunk); if (stderr.length > 32 * 1024 * 1024) { overflow = true; terminate(); } });
  try {
    const code = await new Promise((ok, bad) => { child.once('error', bad); child.once('close', ok); });
    if (allowExitFailure && !expired && !overflow && code !== 0) return {stdout, stderr, code};
    if (expired || overflow || code !== 0) { if (!mirror) process.stderr.write(stderr + stdout); fail(`${command} failed (${expired ? 'deadline/signal' : overflow ? 'output limit' : `exit ${code}`}).`); }
    return {stdout, stderr, code};
  } finally { clearTimeout(timer); clearTimeout(hardKill); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}

const jsonFile = async (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n', {flag: 'wx', mode: 0o600});
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function fileHash(file) { const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); }
// Line-ending independent: Windows checkouts may convert Cargo.lock to CRLF,
// while coverage is aggregated on Linux.
export const normalizedLockHash = text => hash(text.replaceAll('\r\n', '\n'));
const lockHash = async () => normalizedLockHash(await readFile(resolve(root, 'Cargo.lock'), 'utf8'));
async function daemonIdentity() {
  const file = process.env.STRATA_TEST_KEYRING_DAEMON;
  if (!isAbsolute(file ?? '')) fail('The pinned private test keyring daemon must be explicit.');
  const s = await lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || await realpath(file) !== file) fail('The pinned daemon must be a canonical regular executable.');
  await access(file, constants.X_OK);
  return {path: file, sha256: await fileHash(file)};
}
function testEnvironment(binary) {
  const env = {...process.env, CARGO_MANIFEST_DIR: binary.cwd, CARGO_PKG_NAME: binary.package};
  if (binary.platform === 'win32') env.PATH = [dirname(binary.executable), resolve(dirname(binary.executable), '..'), process.env.PATH].filter(Boolean).join(delimiter);
  else env.LD_LIBRARY_PATH = [dirname(binary.executable), resolve(dirname(binary.executable), '..'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter);
  return env;
}

async function worker(planFile, index, directory) {
  const plan = await readJson(planFile); validatePlan(plan);
  if (plan.binding.platform !== process.platform) fail('Native execution OS differs from its bound target.');
  if (plan.binding.platform === 'linux') {
    if (!/^:\d+\.\d+$/.test(process.env.STRATA_TEST_KEYRING_OWNER ?? '') || !/^[1-9]\d*$/.test(process.env.STRATA_TEST_KEYRING_PID ?? '') || !process.env.DBUS_SESSION_BUS_ADDRESS) fail('Group execution requires the wrapper-owned private Secret Service.');
  } else if (!isAbsolute(process.env.STRATA_TEST_PRIVATE_TEMP ?? '')
      || process.env.TEMP !== process.env.STRATA_TEST_PRIVATE_TEMP || process.env.TMP !== process.env.STRATA_TEST_PRIVATE_TEMP) fail('Windows group execution requires a runner-private temporary directory.');
  const group = plan.groups[index]; if (!group) fail('Unknown native group.');
  const started = Date.now(); const binaries = []; const retried = [];
  for (const selection of group.binaries) {
    const binary = plan.binaries.find(b => b.id === selection.id);
    const options = {cwd: binary.cwd, env: testEnvironment(binary), ownedGroup: plan.binding.platform === 'win32'};
    const batches = selectionBatches(binary, selection.names); const reports = [];
    for (const [batchIndex, names] of batches.entries()) {
      const args = selectionArgs(binary, names);
      const listed = parseListing((await run(binary.executable, [...args, '--list'], options)).stdout);
      if (!same(listed.map(c => c.name), names)) fail('Exact libtest selection differs from the planned batch.');
      console.log(`Native group ${index + 1}: ${binary.id}, batch ${batchIndex + 1}/${batches.length} (${names.length} default cases)`);
      const result = await run(binary.executable, args, {...options, mirror: true, allowExitFailure: true});
      if (result.code === 0) { reports.push(parseResults(result.stdout, binary, names)); continue; }
      // One targeted retry of only the failed tests; anything else stays fatal.
      const failed = failedTestNames(result.stdout, binary, names);
      if (!failed) { process.stderr.write(result.stderr); fail(`${binary.executable} failed (exit ${result.code}).`); }
      const notice = `Retrying ${failed.length} failed test(s) once in ${binary.id}: ${failed.join(', ')}`;
      console.log(process.env.GITHUB_ACTIONS === 'true' ? `::warning title=Native test retry::${notice}` : notice);
      const retry = await run(binary.executable, selectionArgs(binary, failed), {...options, mirror: true});
      const retryReport = parseResults(retry.stdout, binary, failed);
      retryReport.filtered = binary.cases.length - names.length;
      const merged = mergeRetriedBatch(binary, names, result.stdout, failed, retryReport);
      retried.push(...failed.map(name => `${binary.id}:${name}`));
      reports.push(merged);
    }
    binaries.push(mergeBinaryReports(binary, selection.names, reports));
  }
  await jsonFile(resolve(directory, `group-${index}.json`), {index, inventoryHash: plan.inventoryHash, success: true,
    elapsedSeconds: (Date.now() - started) / 1000, retried, owner: plan.binding.platform === 'linux' ? process.env.STRATA_TEST_KEYRING_OWNER : 'windows-private-runner', binaries});
}

export function parseOptions(args) {
  const options = {target: 'x86_64-unknown-linux-gnu', groups: 3, output: resolve(root, 'output/linux-native-coverage.json'), aggregate: []};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]; const value = args[++i];
    if (!value || !['--target', '--groups', '--output', '--shard', '--aggregate'].includes(flag)) fail('Use --target, --groups (1-4), --output, --shard (1/N), or repeated --aggregate files.');
    if (flag === '--aggregate') options.aggregate.push(resolve(value));
    else if (flag === '--groups') { if (!/^[1-4]$/.test(value)) fail('Native groups must be 1-4.'); options.groups = Number(value); }
    else if (flag === '--output') options.output = resolve(value);
    else if (flag === '--target') { targetPolicy(value); options.target = value; }
    else { const match = /^([0-3])\/([1-4])$/.exec(value); if (!match || Number(match[1]) >= Number(match[2])) fail('Invalid bounded zero-based shard.'); options.shard = {index: Number(match[1]), count: Number(match[2])}; }
  }
  if (options.shard && options.shard.count !== options.groups) fail('Shard count must equal the complete group plan.');
  if (options.aggregate.length && options.shard) fail('Aggregation cannot execute a shard.');
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.aggregate.length) {
    const files = [];
    for (const file of options.aggregate) {
      const s = await lstat(file);
      if (s.isSymbolicLink()) fail('Shard evidence must not be a symbolic link.');
      if (s.isDirectory()) {
        const entries = await readdir(file);
        if (!entries.length || entries.some(name => !/^native-shard-[0-3]\.json$/.test(name))) fail('The aggregate directory must contain only bounded native shard evidence.');
        files.push(...entries.sort(compare).map(name => resolve(file, name)));
      } else if (s.isFile()) files.push(file); else fail('Invalid shard evidence file.');
    }
    const shards = await Promise.all(files.map(readJson)); const first = shards[0];
    const evidence = validateShardEvidence(shards);
    const currentSha = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
    if (first.binding.sourceSha !== currentSha || process.env.GITHUB_ACTIONS === 'true' && currentSha !== process.env.GITHUB_SHA
        || first.binding.lockSha256 !== await lockHash()
        || !same(first.binding.workflow, workflowBinding()) || first.binding.target !== options.target || first.binding.groups !== options.groups) fail('Aggregate evidence differs from the checked source, workflow attempt or required test profile.');
    await mkdir(dirname(options.output), {recursive: true});
    await jsonFile(options.output, {schema: 1, ...evidence});
    console.log(JSON.stringify(evidence.summary)); return;
  }
  const policy = targetPolicy(options.target);
  if (process.platform !== policy.platform) fail('Native fixture execution OS must match the reviewed target; evidence validation is portable.');
  const sourceSha = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || process.env.GITHUB_ACTIONS === 'true' && sourceSha !== process.env.GITHUB_SHA) fail('The native test source must match this workflow commit.');
  const daemon = policy.platform === 'linux' ? await daemonIdentity() : null;
  const metadata = JSON.parse((await run('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'])).stdout);
  const cargo = ['test', '--workspace', '--locked', '--target', options.target];
  const build = await run('cargo', [...cargo, '--no-run', '--message-format=json']);
  const binaries = parseCargoArtifacts(build.stdout, metadata, root, options.target);
  for (let i = 0; i < binaries.length; i++) {
    const b = binaries[i]; const environment = testEnvironment(b);
    const all = parseListing((await run(b.executable, ['--list', '--color', 'never'], {cwd: b.cwd, env: environment})).stdout);
    const ignored = parseListing((await run(b.executable, ['--list', '--ignored', '--color', 'never'], {cwd: b.cwd, env: environment})).stdout);
    binaries[i] = attachInventory(b, all, ignored);
  }
  validateIgnoredPolicy(binaries, options.target);
  const docTargets = workspaceDocTargets(metadata);
  const binding = {sourceSha, lockSha256: await lockHash(), target: options.target, platform: policy.platform, groups: options.groups,
    rustc: (await run('rustc', ['-Vv'])).stdout.trim(), docTargets, workflow: workflowBinding(),
    profile: {devDebug: process.env.CARGO_PROFILE_DEV_DEBUG ?? 'default', testDebug: process.env.CARGO_PROFILE_TEST_DEBUG ?? 'default', incremental: process.env.CARGO_INCREMENTAL ?? 'default'},
    ignoredPolicy: policy.ignoredPolicy};
  if (process.env.GITHUB_ACTIONS === 'true' && Object.values(binding.profile).some(value => value !== '0')) fail('CI native fixtures require the reviewed debug=0, incremental=0 profile.');
  const plan = makePlan(binaries, options.groups, binding);
  const directory = await mkdtemp(resolve(process.env.RUNNER_TEMP || tmpdir(), 'strata-native-'));
  const planFile = resolve(directory, 'plan.json'); await jsonFile(planFile, plan);
  const selected = options.shard ? [options.shard.index] : plan.groups.map(g => g.index);
  const reports = [];
  // CI uses one group per independent runner. Local full execution stays serial:
  // temp/DBus isolation cannot isolate the host process or port inventory.
  for (const index of selected) {
    if (daemon && !same(await daemonIdentity(), daemon)) fail('The pinned daemon changed between groups.');
    const privateDir = resolve(directory, `isolation-${index}`);
    await mkdir(privateDir, {mode: 0o700}); await mkdir(resolve(privateDir, 'config'), {mode: 0o700});
    if (policy.platform === 'linux') {
      const env = {...process.env, TMPDIR: privateDir, XDG_CONFIG_HOME: resolve(privateDir, 'config')};
      await run('dbus-run-session', ['--', 'xvfb-run', '-a', 'bash', resolve(root, 'scripts/release-linux-tests.sh'),
        process.execPath, script, '--internal-group', planFile, String(index), directory], {env, mirror: true, ownedGroup: true});
    } else {
      const env = {...process.env, TEMP: privateDir, TMP: privateDir, STRATA_TEST_PRIVATE_TEMP: privateDir};
      await run(process.execPath, [script, '--internal-group', planFile, String(index), directory], {env, mirror: true, ownedGroup: true});
    }
    reports.push(await readJson(resolve(directory, `group-${index}.json`)));
  }
  if (daemon && !same(await daemonIdentity(), daemon)) fail('The pinned daemon changed during native tests.');
  let docs = null;
  if (!options.shard || options.shard.index === 0) {
    const docArgs = [...cargo, '--doc', '--', '--test-threads=1', '--color', 'never'];
    let docRun;
    if (policy.platform === 'linux') {
      docRun = await run('dbus-run-session', ['--', 'xvfb-run', '-a', 'bash', resolve(root, 'scripts/release-linux-tests.sh'),
        'cargo', ...docArgs], {mirror: true, ownedGroup: true, env: {...process.env, CARGO_TERM_COLOR: 'never'}});
    } else {
      const privateDir = resolve(directory, 'doc-isolation'); await mkdir(privateDir, {mode: 0o700});
      docRun = await run('cargo', docArgs, {mirror: true, ownedGroup: true,
        env: {...process.env, CARGO_TERM_COLOR: 'never', TEMP: privateDir, TMP: privateDir}});
    }
    docs = {success: true, sourceSha, inventoryHash: plan.inventoryHash, ...parseDocResults(docRun, docTargets)};
  }
  const summary = options.shard ? null : validateCoverage(plan, reports, docs);
  await mkdir(dirname(options.output), {recursive: true});
  await jsonFile(options.output, {schema: 1, binding, plan, shard: options.shard?.index ?? null, reports, docs, summary});
  console.log(JSON.stringify(summary ?? {success: true, shard: options.shard.index, inventoryHash: plan.inventoryHash, reports: reports.length}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--internal-group') {
    if (process.argv.length !== 6 || !/^[0-3]$/.test(process.argv[4])) fail('Invalid internal group command.');
    await worker(process.argv[3], Number(process.argv[4]), process.argv[5]);
  } else await main();
}
