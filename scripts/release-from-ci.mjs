/** Promote complete same-source CI bytes; signing and writes stay in Actions. */
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile, appendFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve as pathResolve, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';

export const CI_PROTOCOL = 'strata-release-ci/v3';
export const REPOSITORY = 'hongfaqiu/strata-manager';
const workflowPath = '.github/workflows/ci.yml';
const maxBytes = 512 * 1024 * 1024;
const sha = /^[0-9a-f]{64}$/;
const sourceSha = /^[0-9a-f]{40}$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const fail = message => { throw new Error(message); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const base = '/repos/' + REPOSITORY;
export const COMMON_GATES = Object.freeze([
  'Reusable release CI protocol', 'Verify the API metadata observer without model weights',
  'Read the checked application version', 'Build the fixture update verifier for this platform',
  'Version and release guard tests', 'Frontend types, core and HTTP fixture tests, build',
  'Prepare independent background binary', 'Rust formatting', 'Rust checks',
  'Prepare packaged background binary', 'Build test installers',
]);
export const PLATFORM_GATES = Object.freeze({
  windows: Object.freeze(['Verify installed Windows package and background IPC']),
  linux: Object.freeze(['Linux Secret Service wrapper contracts', 'Build the pinned private Linux test keyring',
    'Linux Secret Service fresh-connection regression',
    'Verify Linux AppImage and DEB startup under Xvfb']),
  macos: Object.freeze(['Use ad-hoc macOS signing without an Apple certificate',
    'Package the macOS app archive for the updater', 'Upload the macOS updater archive']),
});
/** Separate job that aggregates all six shard proofs after all desktop jobs succeeded. */
export const COVERAGE_JOB = 'Native coverage verification';
export const COVERAGE_GATES = Object.freeze([
  "Download this attempt's Windows native coverage proofs",
  "Download this attempt's Linux native coverage proofs",
  'Native tests (Windows)', 'Native tests (Linux)',
]);
export const SHARD_GATES = Object.freeze([
  'Linux Secret Service wrapper contracts', 'Build the pinned private Linux test keyring',
  'Prepare independent background binary', 'Run every assigned native test with the private Linux keyring',
  'Upload the complete native coverage proof',
]);
export const WINDOWS_SHARD_GATES = Object.freeze([
  'Prepare independent background binary',
  'Run every assigned native test on the independent Windows runner',
  'Upload the complete native coverage proof',
]);
export const OBSERVER_GATES = Object.freeze([
  'Preserve the verified upstream source bytes',
  'Check out the reviewed Strata 0.1.43.1 API fixture',
  'Install MockEngine test dependencies only',
  'Verify the reviewed source and observer compatibility',
  'Verify all Strata 0.1.43.1 observer HTTP contracts without skips',
]);
export const OBSERVER_JOBS = Object.freeze([
  'Strata 0.1.43.1 observer (windows-latest)',
  'Strata 0.1.43.1 observer (ubuntu-22.04)',
]);
const jobsByPlatform = {
  windows: 'desktop (windows-latest, x86_64-pc-windows-msvc, nsis)',
  linux: 'desktop (ubuntu-22.04, x86_64-unknown-linux-gnu, appimage,deb)',
  macos: 'desktop (macos-15, aarch64-apple-darwin, app,dmg)',
};

export function createPlan({ repository = REPOSITORY, tag, version, sourceSha: commit, runId, productName }) {
  const match = typeof version === 'string' && semver.exec(version);
  if (repository !== REPOSITORY || !match || tag !== 'v' + version || !sourceSha.test(commit ?? '')
      || runId !== undefined && !positive(runId) || typeof productName !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9 .-]{0,79}$/.test(productName) || productName.endsWith('.')
      || productName.endsWith(' ') || productName.includes('..')) fail('Explicit repository, source SHA, SemVer tag and safe product name are required.');
  const product = productName.replaceAll(' ', '.');
  return { protocol: CI_PROTOCOL, repository, tag, version, sourceSha: commit, runId, productName,
    prerelease: Boolean(match[4]), workflowPath, artifacts: [
      { name: 'ci-windows-x64-nsis', kind: 'windows', installer: product + '_' + version + '_x64-setup.exe' },
      { name: 'ci-linux-amd64-appimage', kind: 'appimage', installer: product + '_' + version + '_amd64.AppImage' },
      { name: 'ci-linux-amd64-deb', kind: 'deb', installer: product + '_' + version + '_amd64.deb' },
      // Updater archive first (latest.json darwin-aarch64); DMG is the manual download.
      { name: 'ci-darwin-aarch64-app-tarball', kind: 'macos', installer: product + '_' + version + '_aarch64.app.tar.gz' },
      { name: 'ci-darwin-aarch64-dmg', kind: 'macos', installer: product + '_' + version + '_aarch64.dmg' },
    ] };
}
export const assetNames = plan => ['latest.json', 'SHA256SUMS', ...plan.artifacts.flatMap(a => [a.installer, a.installer + '.sig'])];
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : fail('Valid CI timestamps are required.');
function validateRun(run, plan, requireSuccess = true) {
  if (!positive(run?.id) || plan.runId !== undefined && run.id !== plan.runId
      || run.repository?.full_name !== plan.repository || run.head_repository?.full_name !== plan.repository
      || run.head_sha !== plan.sourceSha || run.path !== plan.workflowPath
      || !['push', 'workflow_dispatch'].includes(run.event) || !positive(run.run_attempt)
      || requireSuccess && (run.status !== 'completed' || run.conclusion !== 'success')) fail('Complete successful same-repository, same-source CI is required.');
}
function successfulJob(jobs, name, run) {
  const matches = jobs.filter(j => j.name === name); const job = matches[0];
  if (matches.length !== 1 || !positive(job.id) || job.run_id !== run.id
      || job.run_attempt !== undefined && job.run_attempt !== run.run_attempt
      || job.head_sha !== undefined && job.head_sha !== run.head_sha
      || job.status !== 'completed' || job.conclusion !== 'success'
      || date(job.completed_at) < date(job.started_at)) fail('Required CI job failed or missing: ' + name);
  return job;
}
const CHANGES_JOB = 'Detect app code changes';
export function validateCiEvidence(run, jobs, artifacts, plan, { nowMs = Date.now() } = {}) {
  if (plan?.protocol !== CI_PROTOCOL) fail('The current complete native CI protocol is required.');
  validateRun(run, plan);
  if (!Array.isArray(jobs) || !Array.isArray(artifacts)) fail('Complete jobs and artifact inventories are required.');
  // CI's 'Detect app code changes' gate decides whether app jobs run; it must succeed when present.
  const gateJobs = jobs.filter(j => j?.name === CHANGES_JOB);
  if (gateJobs.length > 1) fail('Duplicate CI job: ' + CHANGES_JOB);
  if (gateJobs.length) successfulJob(jobs, CHANGES_JOB, run);
  jobs = jobs.filter(j => j?.name !== CHANGES_JOB);
  if (jobs.length !== 12) fail('Exactly the three desktop jobs, six native shards, two observer compatibility jobs and the coverage verification job are required.');
  const coverage = successfulJob(jobs, COVERAGE_JOB, run);
  if (coverage.run_attempt !== undefined && coverage.run_attempt !== run.run_attempt) fail('Coverage verification lacks current-attempt evidence.');
  for (const gate of COVERAGE_GATES) {
    const steps = coverage.steps?.filter(step => step.name === gate) ?? [];
    if (steps.length !== 1 || steps[0].status !== 'completed' || steps[0].conclusion !== 'success') fail('Required coverage gate failed or missing: ' + gate);
  }
  for (const name of OBSERVER_JOBS) {
    const job = successfulJob(jobs, name, run);
    if (job.run_attempt !== run.run_attempt) fail('Required observer job lacks current-attempt evidence: ' + name);
    for (const gate of OBSERVER_GATES) {
      const steps = job.steps?.filter(step => step.name === gate) ?? [];
      if (steps.length !== 1 || steps[0].status !== 'completed' || steps[0].conclusion !== 'success') fail('Required observer gate failed or missing: ' + gate);
    }
  }
  for (const [platform, gates] of [['Linux', SHARD_GATES], ['Windows', WINDOWS_SHARD_GATES]]) {
    for (let shard = 0; shard < 3; shard++) {
      const job = successfulJob(jobs, platform + ' native shard (' + shard + '/3)', run);
      for (const name of gates) {
        const steps = job.steps?.filter(s => s.name === name) ?? [];
        if (steps.length !== 1 || steps[0].status !== 'completed' || steps[0].conclusion !== 'success') fail('Required native shard gate failed or missing: ' + name);
      }
    }
  }
  const platformJobs = {};
  for (const [platform, name] of Object.entries(jobsByPlatform)) {
    const job = successfulJob(jobs, name, run);
    const gates = [...COMMON_GATES, ...PLATFORM_GATES[platform]];
    if (platform === 'windows' && plan.version === '0.1.2') gates.push(
      'Verify the signed beta.2 installer for the first stable upgrade',
      'Verify beta.2 to first stable upgrade and retained application data');
    for (const name of gates) {
      const steps = job.steps?.filter(s => s.name === name) ?? [];
      if (steps.length !== 1 || steps[0].status !== 'completed' || steps[0].conclusion !== 'success') fail('Required CI gate failed or missing: ' + name);
    }
    platformJobs[platform] = job;
  }
  const ids = new Set();
  const bound = plan.artifacts.map(expected => {
    const matches = artifacts.filter(a => a.name === expected.name); const a = matches[0];
    const job = platformJobs[expected.kind === 'windows' ? 'windows' : expected.kind === 'macos' ? 'macos' : 'linux'];
    if (matches.length !== 1 || !positive(a.id) || ids.has(a.id) || a.expired !== false
        || !positive(a.size_in_bytes) || a.size_in_bytes > maxBytes
        || !/^sha256:[0-9a-f]{64}$/.test(a.digest ?? '') || a.workflow_run?.id !== run.id
        || a.workflow_run?.head_sha !== plan.sourceSha || date(a.expires_at) <= nowMs
        || date(a.created_at) < date(job.started_at) || date(a.created_at) > date(job.completed_at)) fail('A unique current-attempt immutable artifact is required: ' + expected.name);
    ids.add(a.id);
    return { ...expected, id: a.id, sha256: a.digest.slice(7), zipSize: a.size_in_bytes };
  });
  return { ...plan, runId: run.id, runAttempt: run.run_attempt, artifacts: bound };
}
export function validateSourceProtocol(helper, workflow) {
  if (!helper.includes("export const CI_PROTOCOL = '" + CI_PROTOCOL + "';")
      || !workflow.includes('name: Reusable release CI protocol')
      || !workflow.includes('node scripts/release-from-ci.mjs protocol')) fail('Source CI does not implement the reusable release CI protocol; use a compatible new-source CI.');
  return true;
}
export function validateInstallerEntries(entries, artifact) {
  if (!Array.isArray(entries) || entries.length !== 1) fail('Exactly one root regular installer is required in each ZIP.');
  const e = entries[0];
  if (typeof e.name !== 'string' || !e.name || e.name.length > 240 || /[\\/\x00-\x1f\x7f:]/.test(e.name)
      || e.name.replaceAll(' ', '.') !== artifact.installer || e.isDirectory !== false || e.encrypted !== false
      || !positive(e.size) || e.size > maxBytes || !positive(e.compressedSize) || e.compressedSize > maxBytes
      || !Number.isSafeInteger(e.mode) || e.mode < 0
      || (e.mode & 0xf000) && (e.mode & 0xf000) !== 0x8000) fail('Unsafe or wrong product/version/architecture ZIP entry.');
  return e;
}
export const WRITER_JOBS = Object.freeze({
  resolver: 'Resolve same-source CI', publisher: 'Publish verified CI installers',
  validation: 'Validate CI installers (read only)',
});
const activeStatuses = new Set(['queued', 'waiting', 'pending', 'requested', 'in_progress']);
export function validateWriterProtocol(workflow) {
  return typeof workflow === 'string' && workflow.includes('name: ' + WRITER_JOBS.resolver)
    && workflow.includes(WRITER_JOBS.publisher) && workflow.includes(WRITER_JOBS.validation)
    && workflow.includes("format('release-publish-{0}', github.repository)");
}
export function validateLiveWriters(runs, plan, ownRunId) {
  if (!Array.isArray(runs)) fail('A complete writer inventory is required.');
  for (const run of runs) {
    if (!positive(run.id) || typeof run.status !== 'string' || typeof run.path !== 'string') fail('Invalid writer metadata.');
    if (run.id === ownRunId || run.status === 'completed') continue;
    if (!['.github/workflows/release-from-ci.yml', '.github/workflows/release.yml'].includes(run.path)) continue;
    if (!positive(run.run_attempt) || !activeStatuses.has(run.status) || !Array.isArray(run.writerJobs)) fail('Unknown active release writer metadata: ' + run.id);
    if (run.writerJobs.length === 0) {
      // A whole caller can be queued before any job exists. Only the pinned new lock protocol proves it safe.
      if (run.status !== 'in_progress' && run.writerProtocolVerified === true) continue;
      fail('An unidentifiable release writer must finish: ' + run.id);
    }
    const roles = new Set();
    for (const job of run.writerJobs) {
      const role = Object.entries(WRITER_JOBS).find(([, name]) => job.name === name || job.name?.endsWith(' / ' + name))?.[0];
      if (!role || roles.has(role) || !positive(job.id) || job.run_id !== run.id
          || job.run_attempt !== undefined && job.run_attempt !== run.run_attempt
          || !['completed', ...activeStatuses].includes(job.status)) fail('Unknown active release job; refusing concurrent writes: ' + run.id);
      roles.add(role);
      if (role === 'publisher' && job.status === 'in_progress') fail('An active release writer must finish or be cancelled by the operator: ' + run.id);
    }
  }
  return true;
}
export function validateReleaseInventory(release, plan, { allowPartial = false } = {}) {
  if (release?.tag_name !== plan.tag || release.draft !== true || release.prerelease !== plan.prerelease
      || !positive(release.id) || !Array.isArray(release.assets)) fail('The actual matching unpublished draft is required.');
  const expected = assetNames(plan).sort(); const actual = release.assets.map(a => a.name).sort();
  if (allowPartial ? actual.some(n => !expected.includes(n)) : JSON.stringify(actual) !== JSON.stringify(expected)) fail('Exactly the expected release assets are required.');
  const ids = new Set(); const names = new Set();
  for (const a of release.assets) {
    if (!positive(a.id) || ids.has(a.id) || names.has(a.name) || !positive(a.size)) fail('Nonempty distinct release assets are required.');
    ids.add(a.id); names.add(a.name);
  }
  return true;
}
export function draftMetadataPayload(plan, body) {
  return { tag_name: plan.tag, name: plan.productName + ' ' + plan.tag, body, draft: true, prerelease: plan.prerelease };
}
export function validateReleaseMetadata(release, plan, body) {
  if (Object.entries(draftMetadataPayload(plan, body)).some(([key, value]) => release?.[key] !== value)) fail('Draft metadata does not match the explicit source release.');
  return true;
}
export async function requireSourceRelease(plan, { validateOnly = false, requireTag, requireWritable }) {
  if (validateOnly) return;
  await requireTag(plan.repository, plan.tag, plan.sourceSha);
  await requireWritable({ repository: plan.repository, tag: plan.tag, expectedSha: plan.sourceSha,
    requireDraft: false, logger: () => {} });
}
export function creationBranch(repository) {
  const branch = repository?.default_branch;
  if (repository?.full_name !== REPOSITORY || typeof branch !== 'string' || !branch || branch.length > 255 || /[\x00-\x20\x7f]/.test(branch)) fail('The repository default branch is required only as a draft creation hint.');
  return branch;
}
export function validateLatestManifest(manifest, assets, plan) {
  const index = new Map(assets.map(a => [a.name, a]));
  const mapping = { 'windows-x86_64': 0, 'windows-x86_64-nsis': 0, 'linux-x86_64': 1, 'linux-x86_64-appimage': 1, 'linux-x86_64-deb': 2, 'darwin-aarch64': 3 };
  if (manifest?.version !== plan.version || !manifest.platforms
      || JSON.stringify(Object.keys(manifest.platforms).sort()) !== JSON.stringify(Object.keys(mapping).sort())) fail('Canonical updater platforms and bundle aliases are required.');
  for (const [platform, i] of Object.entries(mapping)) {
    const name = plan.artifacts[i].installer; const update = manifest.platforms[platform];
    const signature = index.get(name + '.sig')?.signatureText;
    if (!index.has(name) || !signature || update?.signature !== signature
        || update.url !== 'https://github.com/' + plan.repository + '/releases/download/' + encodeURIComponent(plan.tag) + '/' + encodeURIComponent(name)) fail('Manifest URL/signature mismatch: ' + platform);
  }
  return true;
}

export function command(binary, args, options = {}) {
  try { return execFileSync(binary, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    ...options, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); }
  catch { fail('Command failed: ' + (binary === process.execPath ? 'Node tool' : binary)); }
}
const json = path => JSON.parse(command('gh', ['api', path]));
export async function inventory(path, key, fetchJson = json) {
  const values = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetchJson(path + (path.includes('?') ? '&' : '?') + 'per_page=100&page=' + page);
    const entries = key ? response[key] : response;
    if (!Array.isArray(entries) || entries.length > 100) fail('Invalid paginated inventory.');
    values.push(...entries);
    if (entries.length < 100) return values;
  }
  fail('Inventory pagination was incomplete.');
}
/** Freshly completed runs can briefly omit job.steps in the Actions API. */
export function hasIncompleteStepInventory(jobs) {
  return !Array.isArray(jobs) || jobs.length === 0
    || jobs.some(job => job?.status === 'completed' && job?.conclusion === 'success'
      && (!Array.isArray(job.steps) || job.steps.length === 0));
}
async function evidence(run, plan, fetchJson) {
  const jobs = await inventory(base + '/actions/runs/' + run.id + '/attempts/' + run.run_attempt + '/jobs', 'jobs', fetchJson);
  const artifacts = await inventory(base + '/actions/runs/' + run.id + '/artifacts', 'artifacts', fetchJson);
  if (hasIncompleteStepInventory(jobs)) {
    const error = new Error('CI job step inventory is incomplete');
    error.code = 'incomplete_steps';
    throw error;
  }
  return validateCiEvidence(run, jobs, artifacts, plan);
}
function evidenceErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function isIncompleteEvidence(error) {
  return error?.code === 'incomplete_steps'
    || evidenceErrorMessage(error) === 'CI job step inventory is incomplete';
}
export async function findReusableCi(plan, { runId = plan.runId, fetchJson = json } = {}) {
  if (runId !== undefined) {
    if (!positive(runId)) fail('CI_RUN_ID must be a positive safe integer.');
    const run = await fetchJson(base + '/actions/runs/' + runId);
    validateRun(run, { ...plan, runId }, false);
    if (run.status !== 'completed') return { status: 'pending', runId };
    // A failed or cancelled attempt can still be re-run under the same run id;
    // report it so the caller keeps waiting instead of failing the release.
    if (run.conclusion !== 'success') return { status: 'failed', runId, conclusion: run.conclusion, attempt: run.run_attempt };
    try {
      return { status: 'success', runId, plan: await evidence(run, { ...plan, runId }, fetchJson) };
    } catch (error) {
      // Prefer waiting over failing the release when Actions has not settled step metadata yet.
      if (run.conclusion === 'success' && isIncompleteEvidence(error)) return { status: 'pending', runId };
      if (run.conclusion === 'success') fail('Same-source CI exists but is not reusable: ' + evidenceErrorMessage(error));
      throw error;
    }
  }
  const runs = await inventory(base + '/actions/workflows/ci.yml/runs?head_sha=' + plan.sourceSha, 'workflow_runs', fetchJson);
  const candidates = runs.filter(r => r.head_sha === plan.sourceSha).sort((a, b) => date(b.created_at) - date(a.created_at));
  let pending;
  let failed;
  let lastEvidenceError;
  for (const run of candidates) {
    try { validateRun(run, plan, false); } catch { continue; }
    if (run.status !== 'completed') { pending ??= run.id; continue; }
    if (run.conclusion !== 'success') { failed ??= run.id; continue; }
    // Network/incomplete inventory failures are fatal, never an excuse to dispatch duplicates.
    const jobs = await inventory(base + '/actions/runs/' + run.id + '/attempts/' + run.run_attempt + '/jobs', 'jobs', fetchJson);
    const artifacts = await inventory(base + '/actions/runs/' + run.id + '/artifacts', 'artifacts', fetchJson);
    if (hasIncompleteStepInventory(jobs)) { pending ??= run.id; continue; }
    try { return { status: 'success', runId: run.id, plan: validateCiEvidence(run, jobs, artifacts, plan) }; }
    catch (error) {
      // Keep searching older same-source successes; surface why reuse was refused if none qualify.
      lastEvidenceError = evidenceErrorMessage(error);
    }
  }
  if (pending) return { status: 'pending', runId: pending };
  if (lastEvidenceError) fail('Same-source CI exists but is not reusable: ' + lastEvidenceError);
  // The newest same-source CI failed: wait for its re-run rather than dispatching a duplicate.
  if (failed) return { status: 'failed', runId: failed };
  return { status: 'missing' };
}
async function digest(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
async function regular(file, max = maxBytes) {
  const s = await lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size < 1 || s.size > max) fail('A bounded regular file is required.');
  return s.size;
}
async function download(path, file, expectedSize) {
  const child = spawn('gh', ['api', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const timeout = setTimeout(() => child.kill('SIGKILL'), 600000);
  const ended = new Promise((ok, bad) => {
    child.once('error', () => bad(new Error('Artifact download could not start.')));
    child.once('close', code => code === 0 ? ok() : bad(new Error('Artifact download failed.')));
  });
  try {
    const results = await Promise.allSettled([ended, pipeline(child.stdout, createWriteStream(file, { flags: 'wx', mode: 0o600 }))]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    if (await regular(file) !== expectedSize) fail('Downloaded ZIP size mismatch.');
  } finally { clearTimeout(timeout); }
}
const zipMetadata = [
  'import sys,json,zipfile', 'with zipfile.ZipFile(sys.argv[1]) as z:',
  ' print(json.dumps([dict(name=i.filename,size=i.file_size,compressedSize=i.compress_size,mode=i.external_attr>>16,isDirectory=i.is_dir(),encrypted=bool(i.flag_bits&1)) for i in z.infolist()]))',
].join('\n');
const zipExtract = [
  'import sys,zipfile,os', 'with zipfile.ZipFile(sys.argv[1]) as z:',
  " with z.open(sys.argv[2]) as source, open(sys.argv[3],'xb') as target:",
  '  total=0', '  while True:', '   data=source.read(1024*1024)', '   if not data: break',
  '   total+=len(data)', '   if total>int(sys.argv[4]): raise ValueError("Unbounded installer")', '   target.write(data)',
  'os.chmod(sys.argv[3],0o600)',
].join('\n');
const zipByteHash = [
  'import sys,zipfile,hashlib', 'h=hashlib.sha256(); total=0',
  'with zipfile.ZipFile(sys.argv[1]) as z:', ' with z.open(sys.argv[2]) as source:',
  '  while True:', '   data=source.read(1024*1024)', '   if not data: break', '   total+=len(data)',
  '   if total>int(sys.argv[3]): raise ValueError("Unbounded installer")', '   h.update(data)',
  'if total!=int(sys.argv[3]): raise ValueError("Installer size changed")', 'print(h.hexdigest())',
].join('\n');
const python = process.platform === 'win32' ? 'python' : 'python3';

async function context(phase, validateOnly = false) {
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY || !isAbsolute(process.env.SOURCE_ROOT ?? '')) fail('Explicit repository and absolute SOURCE_ROOT are required.');
  const root = await realpath(process.env.SOURCE_ROOT); const commit = process.env.EXPECTED_SOURCE_SHA;
  if (!sourceSha.test(commit ?? '') || command('git', ['-C', root, 'rev-parse', 'HEAD']).trim() !== commit
      || command('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no']).trim()) fail('SOURCE_ROOT must be the clean explicit source checkout.');
  validateSourceProtocol(await readFile(pathResolve(root, 'scripts/release-from-ci.mjs'), 'utf8'),
    await readFile(pathResolve(root, workflowPath), 'utf8'));
  const modules = {};
  for (const name of ['release-check', 'release-tag', 'release-assets', 'release-verify', 'release-publish', 'release-notes']) {
    modules[name] = await import(pathToFileURL(pathResolve(root, 'scripts/' + name + '.mjs')).href);
  }
  const { version } = await modules['release-check'].checkRelease({ root, tag: process.env.RELEASE_TAG, requireSigning: phase === 'sign' });
  const config = JSON.parse(await readFile(pathResolve(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  let runId = process.env.CI_RUN_ID ? Number(process.env.CI_RUN_ID) : undefined;
  let temp;
  if (phase !== 'resolve') {
    if (!isAbsolute(process.env.RELEASE_TEMP ?? '')) fail('An absolute RELEASE_TEMP is required.');
    temp = pathResolve(process.env.RELEASE_TEMP);
    if (process.env.GITHUB_ACTIONS === 'true' && dirname(temp) !== await realpath(process.env.RUNNER_TEMP)) fail('RELEASE_TEMP must be a private direct child of RUNNER_TEMP.');
    if (['sign', 'publish'].includes(phase) && runId === undefined) {
      await regular(pathResolve(temp, 'prepared.json'), 65536);
      runId = JSON.parse(await readFile(pathResolve(temp, 'prepared.json'), 'utf8')).plan?.runId;
    }
  }
  const plan = createPlan({ tag: process.env.RELEASE_TAG, sourceSha: commit, version, productName: config.productName, runId });
  if (['sign', 'publish'].includes(phase)) {
    if (validateOnly || process.env.GITHUB_ACTIONS !== 'true') fail('Signing and publishing require the isolated GitHub Actions runner.');
  }
  await requireSourceRelease(plan, { validateOnly,
    requireTag: modules['release-tag'].requireReleaseTagCommit,
    requireWritable: modules['release-assets'].requireReleaseAssetsWritable });
  return { root, temp, modules, plan, validateOnly };
}
async function bindCi(c) {
  const found = await findReusableCi(c.plan);
  if (found.status !== 'success') fail('No complete compatible CI exists for the explicit source.');
  c.plan = found.plan;
}
async function assertWriters(plan) {
  const runs = [];
  for (const workflow of ['release.yml', 'release-from-ci.yml']) runs.push(
    ...await inventory(base + '/actions/workflows/' + workflow + '/runs', 'workflow_runs'));
  for (const run of runs) {
    if (run.id === Number(process.env.GITHUB_RUN_ID) || run.status === 'completed') continue;
    if (!positive(run.run_attempt)) fail('The current attempt of an active writer is required.');
    run.writerJobs = await inventory(base + '/actions/runs/' + run.id + '/attempts/' + run.run_attempt + '/jobs', 'jobs');
    if (run.writerJobs.length === 0 && run.status !== 'in_progress') {
      if (!sourceSha.test(run.head_sha ?? '')) fail('A queued writer requires a pinned source commit.');
      const path = '.github/workflows/release-from-ci.yml';
      const file = json(base + '/contents/' + path + '?ref=' + run.head_sha);
      if (file?.type !== 'file' || file.path !== path || file.encoding !== 'base64'
          || !positive(file.size) || file.size > 65536 || typeof file.content !== 'string') fail('A queued writer requires complete pinned workflow metadata.');
      const bytes = Buffer.from(file.content, 'base64');
      if (bytes.length !== file.size) fail('Queued writer source metadata is incomplete.');
      run.writerProtocolVerified = validateWriterProtocol(bytes.toString('utf8'));
    }
  }
  validateLiveWriters(runs, plan, Number(process.env.GITHUB_RUN_ID));
}
export async function resolveCi({ validateOnly = false } = {}) {
  const c = await context('resolve', validateOnly); const found = await findReusableCi(c.plan);
  const result = { ci_found: found.status === 'success', ci_status: found.status, ci_run_id: found.runId ?? '',
    source_sha: c.plan.sourceSha, protocol: CI_PROTOCOL };
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    'ci_found=' + result.ci_found + '\nci_status=' + result.ci_status + '\nci_run_id=' + result.ci_run_id + '\nsource_sha=' + result.source_sha + '\n');
  console.log(JSON.stringify(result)); return result;
}
export async function prepare({ validateOnly = false } = {}) {
  const c = await context('prepare', validateOnly); await bindCi(c);
  await mkdir(c.temp, { mode: 0o700 });
  const installers = [];
  for (const a of c.plan.artifacts) {
    const zip = pathResolve(c.temp, a.id + '.zip');
    await download(base + '/actions/artifacts/' + a.id + '/zip', zip, a.zipSize);
    if (await digest(zip) !== a.sha256) fail('CI artifact ZIP SHA256 mismatch.');
    const entry = validateInstallerEntries(JSON.parse(command(python, ['-c', zipMetadata, zip])), a);
    const file = pathResolve(c.temp, a.installer);
    command(python, ['-c', zipExtract, zip, entry.name, file, String(entry.size)]);
    const size = await regular(file);
    if (size !== entry.size) fail('Extracted installer size mismatch.');
    installers.push({ name: a.installer, size, sha256: await digest(file), artifactId: a.id, zipSha256: a.sha256 });
  }
  const meta = { protocol: CI_PROTOCOL, validateOnly, plan: c.plan, installers };
  await writeFile(pathResolve(c.temp, 'prepared.json'), JSON.stringify(meta, null, 2), { flag: 'wx', mode: 0o600 });
  await readPrepared(c);
  await writeFile(pathResolve(c.temp, 'proof.json'), JSON.stringify(meta, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Prepared ' + c.plan.artifacts.length + ' full-byte verified same-source CI installers (' + c.plan.version + '); validate-only=' + validateOnly + '.');
  return meta;
}
export function validatePreparedRecord(meta, plan, { allowValidateOnly = false } = {}) {
  if (meta?.protocol !== CI_PROTOCOL || typeof meta.validateOnly !== 'boolean' || meta.validateOnly && !allowValidateOnly
      || JSON.stringify(meta.plan) !== JSON.stringify(plan) || meta.installers?.length !== plan.artifacts.length) fail('Prepared source/CI evidence mismatch or validate-only ledger cannot be signed.');
  for (const a of plan.artifacts) {
    const matches = meta.installers.filter(i => i.name === a.installer); const i = matches[0];
    if (matches.length !== 1 || i.artifactId !== a.id || i.zipSha256 !== a.sha256
        || !positive(i.size) || i.size > maxBytes || !sha.test(i.sha256 ?? '')) fail('Prepared installer evidence mismatch.');
  }
  return true;
}
export async function readPrepared(c) {
  await regular(pathResolve(c.temp, 'prepared.json'), 65536);
  const meta = JSON.parse(await readFile(pathResolve(c.temp, 'prepared.json'), 'utf8'));
  validatePreparedRecord(meta, c.plan, { allowValidateOnly: c.validateOnly });
  for (const a of c.plan.artifacts) {
    const i = meta.installers.find(i => i.name === a.installer);
    if (await regular(pathResolve(c.temp, a.installer)) !== i.size || await digest(pathResolve(c.temp, a.installer)) !== i.sha256
        || await regular(pathResolve(c.temp, a.id + '.zip')) !== a.zipSize
        || await digest(pathResolve(c.temp, a.id + '.zip')) !== a.sha256) fail('Prepared artifact bytes changed.');
    const zip = pathResolve(c.temp, a.id + '.zip');
    const entry = validateInstallerEntries(JSON.parse(command(python, ['-c', zipMetadata, zip])), a);
    if (entry.size !== i.size || command(python, ['-c', zipByteHash, zip, entry.name, String(entry.size)]).trim() !== i.sha256) fail('Prepared installer no longer matches the verified CI ZIP bytes.');
  }
  return meta;
}
async function verifyLocal(c) {
  const verifier = process.env.UPDATE_VERIFIER_BIN;
  if (!isAbsolute(verifier ?? '') || await realpath(verifier) !== pathResolve(c.root, 'target/release/strata-update-verifier')) fail('Build the real source Rust verifier in SOURCE_ROOT/target/release.');
  await regular(verifier);
  for (const a of c.plan.artifacts) {
    await regular(pathResolve(c.temp, a.installer + '.sig'), 16384);
    command(verifier, ['--config', pathResolve(c.root, 'apps/desktop/src-tauri/tauri.conf.json'),
      '--signature', pathResolve(c.temp, a.installer + '.sig'), '--artifact', pathResolve(c.temp, a.installer),
      '--version', c.plan.version, '--require-signed-version']);
  }
}
export async function sign() {
  const c = await context('sign'); await bindCi(c); await readPrepared(c);
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim() || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) fail('An in-memory signing key is required; key files are forbidden.');
  const cli = pathResolve(c.root, 'apps/desktop/node_modules/@tauri-apps/cli/tauri.js');
  for (const a of c.plan.artifacts) command(process.execPath,
    [cli, 'signer', 'sign', '--app-version', c.plan.version, pathResolve(c.temp, a.installer)],
    { cwd: pathResolve(c.root, 'apps/desktop') });
  await verifyLocal(c);
  await writeFile(pathResolve(c.temp, 'signed.json'), JSON.stringify({ protocol: CI_PROTOCOL, sourceSha: c.plan.sourceSha,
    runId: c.plan.runId, signatures: await Promise.all(c.plan.artifacts.map(async a => ({
      name: a.installer + '.sig', sha256: await digest(pathResolve(c.temp, a.installer + '.sig')),
    }))) }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log('All installers signed for ' + c.plan.version + ' and verified by the source Rust verifier.');
}
export async function publish() {
  const c = await context('publish'); await bindCi(c); await readPrepared(c); await verifyLocal(c);
  const p = c.plan;
  await regular(pathResolve(c.temp, 'signed.json'), 65536);
  const signed = JSON.parse(await readFile(pathResolve(c.temp, 'signed.json'), 'utf8'));
  if (signed.protocol !== CI_PROTOCOL || signed.sourceSha !== p.sourceSha || signed.runId !== p.runId || signed.signatures?.length !== p.artifacts.length) fail('Signed evidence mismatch.');
  for (const a of p.artifacts) {
    const entries = signed.signatures.filter(s => s.name === a.installer + '.sig');
    if (entries.length !== 1 || entries[0].sha256 !== await digest(pathResolve(c.temp, a.installer + '.sig'))) fail('Signed bytes changed.');
  }
  const notes = c.modules['release-notes'].releaseNotes(await readFile(pathResolve(c.root, 'CHANGELOG.md'), 'utf8'), p.version);
  const body = c.modules['release-notes'].githubReleaseNotes(notes, p.sourceSha);
  const signatures = await Promise.all(p.artifacts.map(async a => (await readFile(pathResolve(c.temp, a.installer + '.sig'), 'utf8')).replace(/[\r\n]+$/, '')));
  const entry = i => ({ signature: signatures[i], url: 'https://github.com/' + p.repository + '/releases/download/' + encodeURIComponent(p.tag) + '/' + encodeURIComponent(p.artifacts[i].installer) });
  const manifest = { version: p.version, notes, pub_date: new Date().toISOString(), platforms: {
    'windows-x86_64': entry(0), 'windows-x86_64-nsis': entry(0), 'linux-x86_64': entry(1),
    'linux-x86_64-appimage': entry(1), 'linux-x86_64-deb': entry(2), 'darwin-aarch64': entry(3),
  } };
  validateLatestManifest(manifest, p.artifacts.flatMap((a, i) => [{ name: a.installer }, { name: a.installer + '.sig', signatureText: signatures[i] }]), p);
  await writeFile(pathResolve(c.temp, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const sums = (await Promise.all(p.artifacts.map(async a => await digest(pathResolve(c.temp, a.installer)) + '  ' + a.installer + '\n'))).join('');
  await writeFile(pathResolve(c.temp, 'SHA256SUMS'), sums, { flag: 'wx', mode: 0o600 });
  const guard = requireDraft => c.modules['release-assets'].requireReleaseAssetsWritable({
    repository: p.repository, tag: p.tag, expectedSha: p.sourceSha, requireDraft,
  });
  await assertWriters(p); const writable = await guard(false);
  if (writable.releaseId === null) {
    // The existing tag is mandatory; never create or move refs to make publication pass.
    const target = creationBranch(json(base));
    await assertWriters(p); await guard(false);
    const created = JSON.parse(command('gh', ['api', '--method', 'POST', base + '/releases', '--input', '-'], {
      input: JSON.stringify({ ...draftMetadataPayload(p, body), target_commitish: target }),
    }));
    validateReleaseInventory(created, p, { allowPartial: true });
    validateReleaseMetadata(created, p, body);
  }
  await assertWriters(p); await guard(true);
  const draft = await c.modules['release-verify'].findDraftRelease(p.repository, p.tag);
  validateReleaseInventory(draft, p, { allowPartial: true });
  await assertWriters(p); await guard(true);
  const updated = JSON.parse(command('gh', ['api', '--method', 'PATCH', base + '/releases/' + draft.id, '--input', '-'], {
    input: JSON.stringify(draftMetadataPayload(p, body)),
  }));
  if (updated.id !== draft.id) fail('Draft identity changed during metadata refresh.');
  validateReleaseInventory(updated, p, { allowPartial: true });
  validateReleaseMetadata(updated, p, body);
  await assertWriters(p); await guard(true);
  command('gh', ['release', 'upload', p.tag, ...assetNames(p).map(n => pathResolve(c.temp, n)), '--repo', p.repository, '--clobber'], { timeout: 600000 });
  await assertWriters(p); await guard(true);
  const uploaded = await c.modules['release-verify'].findDraftRelease(p.repository, p.tag);
  validateReleaseInventory(uploaded, p);
  validateReleaseMetadata(uploaded, p, body);
  for (const asset of uploaded.assets) {
    if (asset.size !== await regular(pathResolve(c.temp, asset.name)) || asset.digest !== 'sha256:' + await digest(pathResolve(c.temp, asset.name))) fail('Uploaded SHA256/size differs from verified local assets.');
  }
  await c.modules['release-verify'].verifyRelease({ repository: p.repository, tag: p.tag, expectedSha: p.sourceSha, root: c.root, verifierPath: process.env.UPDATE_VERIFIER_BIN });
  await assertWriters(p); await guard(true);
  const finalDraft = await c.modules['release-verify'].findDraftRelease(p.repository, p.tag);
  validateReleaseInventory(finalDraft, p);
  validateReleaseMetadata(finalDraft, p, body);
  if (finalDraft.id !== uploaded.id) fail('The verified draft identity changed.');
  for (const asset of finalDraft.assets) {
    const verified = uploaded.assets.find(a => a.name === asset.name);
    if (!verified || asset.id !== verified.id || asset.size !== verified.size || asset.digest !== verified.digest
        || asset.size !== await regular(pathResolve(c.temp, asset.name)) || asset.digest !== 'sha256:' + await digest(pathResolve(c.temp, asset.name))) fail('Verified release assets changed before publication.');
  }
  await c.modules['release-publish'].publishRelease({ repository: p.repository, tag: p.tag, expectedSha: p.sourceSha, version: p.version });
}
if (process.argv[1] && import.meta.url === pathToFileURL(pathResolve(process.argv[1])).href) {
  const [phase, ...flags] = process.argv.slice(2);
  if (phase === 'protocol' && flags.length === 0) console.log(CI_PROTOCOL);
  else {
    if (!['resolve', 'prepare', 'sign', 'publish'].includes(phase) || flags.length > 1
        || flags.some(f => f !== '--validate-only') || flags.length && !['resolve', 'prepare'].includes(phase)) fail('Use protocol, resolve/prepare [--validate-only], sign or publish.');
    await ({ resolve: resolveCi, prepare, sign, publish })[phase]({ validateOnly: flags.includes('--validate-only') });
  }
}
