/** Reuse only the exact, fully tested 0.1.3 CI bytes; signing stays in Actions. */
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';

export const PLAN = Object.freeze({
  repository: 'hongfaqiu/strata-manager', tag: 'v0.1.3', version: '0.1.3',
  sourceSha: 'ec0797dc06fc833cb5ebf433ecfb71b4c113767c', runId: 38159155279,
  workflowPath: '.github/workflows/ci.yml', formalRunId: 38161099807,
  artifacts: Object.freeze([
    Object.freeze({name: 'ci-windows-x64-nsis', id: 11709972517, sha256: '3150b9795da86427a49e0407141bf0b28ef71d212dc6ea155460bcea561bbc2e', installer: 'Strata.Manager_0.1.3_x64-setup.exe', installerSize: 7768537, installerSha256: '5e52180e6b3536ce201dd277411bbc190f1b683eb7dbab665610846a2554208a', kind: 'windows'}),
    Object.freeze({name: 'ci-linux-amd64-appimage', id: 11710157903, sha256: '85dd7aa50f8bd6a4029f6fb8f1186cd880f17213741c350d72129bfd11c300e7', installer: 'Strata.Manager_0.1.3_amd64.AppImage', installerSize: 90687992, installerSha256: '91b987bb15281eecbf26ef146016ba4ddca92fa0fa4ace0b9661808417ae1267', kind: 'appimage'}),
    Object.freeze({name: 'ci-linux-amd64-deb', id: 11710068043, sha256: 'd9f90edcadf588bf57edad7f6fc6df19af56b66896f40185f5f94a5c57203d52', installer: 'Strata.Manager_0.1.3_amd64.deb', installerSize: 13060438, installerSha256: '86627a23e9ff32c6a0b5060ba58aba38cdb9d5356e6a69398953abf075ff26bd', kind: 'deb'}),
  ]),
});
const names = () => ['latest.json', 'SHA256SUMS', ...PLAN.artifacts.flatMap(a => [a.installer, `${a.installer}.sig`])];
const fail = message => { throw new Error(message); };
const base = `/repos/${PLAN.repository}`;

export function validateCiEvidence(run, jobs, artifacts) {
  if (run?.id !== PLAN.runId || run.repository?.full_name !== PLAN.repository
      || run.head_repository?.full_name !== PLAN.repository || run.head_sha !== PLAN.sourceSha
      || run.path !== PLAN.workflowPath || run.event !== 'workflow_dispatch' || run.run_attempt !== 1
      || run.status !== 'completed' || run.conclusion !== 'success') fail('The exact complete successful CI source is required.');
  if (!Array.isArray(jobs) || !Array.isArray(artifacts)) fail('Complete jobs and artifact inventories are required.');
  for (const [name, native, smoke] of [
    ['desktop (windows-latest, x86_64-pc-windows-msvc, nsis)', 'Native tests (Windows)', 'Verify installed Windows package and background IPC'],
    ['desktop (ubuntu-22.04, x86_64-unknown-linux-gnu, appimage,deb)', 'Native tests under Xvfb (Linux)', 'Verify Linux AppImage and DEB startup under Xvfb'],
  ]) {
    const matched = jobs.filter(j => j.name === name);
    if (matched.length !== 1 || matched[0].status !== 'completed' || matched[0].conclusion !== 'success') fail(`Required CI job failed or missing: ${name}`);
    for (const step of [native, 'Rust checks', 'Build test installers', smoke]) {
      const matches = matched[0].steps?.filter(s => s.name === step) ?? [];
      if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') fail(`Required CI gate failed or missing: ${step}`);
    }
  }
  for (const expected of PLAN.artifacts) {
    const matched = artifacts.filter(a => a.id === expected.id || a.name === expected.name);
    const a = matched[0];
    if (matched.length !== 1 || a.id !== expected.id || a.name !== expected.name || a.expired !== false
        || !Number.isSafeInteger(a.size_in_bytes) || a.size_in_bytes < 1 || a.size_in_bytes > 512 * 1024 * 1024
        || a.digest !== `sha256:${expected.sha256}` || a.workflow_run?.id !== PLAN.runId
        || a.workflow_run?.head_sha !== PLAN.sourceSha) fail(`The exact immutable artifact is required: ${expected.name}`);
  }
  return true;
}

export function validateInstallerEntries(entries, artifact) {
  if (!PLAN.artifacts.some(a => a.id === artifact?.id) || !Array.isArray(entries) || entries.length !== 1) fail('Invalid bounded ZIP inventory.');
  const seen = new Set(); let selected; let total = 0;
  const normalized = value => value.replaceAll(' ', '.');
  const allowed = new Set([artifact.installer, `${artifact.installer}.sig`,
    ...(artifact.kind === 'appimage' ? [`${artifact.installer}.tar.gz`, `${artifact.installer}.tar.gz.sig`] : [])]);
  for (const entry of entries) {
    if (typeof entry.name !== 'string' || !entry.name || entry.name.length > 240
        || /[\\/\x00-\x1f:]/.test(entry.name) || entry.name === '.' || entry.name === '..'
        || seen.has(entry.name) || entry.isDirectory || entry.encrypted
        || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 512 * 1024 * 1024
        || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 1
        || (entry.mode & 0xf000) && (entry.mode & 0xf000) !== 0x8000
        || !allowed.has(normalized(entry.name))) fail('Unsafe or unexpected ZIP entry.');
    seen.add(entry.name); total += entry.size;
    if (normalized(entry.name) === artifact.installer) {
      if (selected) fail('Duplicate installer in ZIP.');
      selected = entry;
    }
  }
  if (!selected || total > 768 * 1024 * 1024 || selected.size !== artifact.installerSize) fail('One exact bounded regular installer is required per artifact.');
  return selected;
}

export function validateLiveWriters(runs, ownRunId) {
  if (!Array.isArray(runs)) fail('A complete writer inventory is required.');
  for (const run of runs) {
    if (!Number.isSafeInteger(run.id) || typeof run.status !== 'string' || typeof run.path !== 'string') fail('Invalid writer metadata.');
    if (run.id === ownRunId) continue;
    if (run.status !== 'completed' && (run.id === PLAN.formalRunId
        || run.path === '.github/workflows/release-from-ci.yml'
        || run.path === '.github/workflows/release.yml' && run.head_branch === PLAN.tag)) fail(`An active release writer must finish or be cancelled by the operator: ${run.id}`);
  }
  return true;
}

export function validateReleaseInventory(release) {
  if (release?.tag_name !== PLAN.tag || release.draft !== true || release.prerelease !== false
      || !Number.isSafeInteger(release.id) || release.id < 1 || !Array.isArray(release.assets)) fail('The actual stable draft release is required.');
  const expected = names().sort(); const actual = release.assets.map(a => a.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('Exactly the eight expected release assets are required.');
  const ids = new Set();
  for (const a of release.assets) {
    if (!Number.isSafeInteger(a.id) || a.id < 1 || ids.has(a.id) || !Number.isSafeInteger(a.size) || a.size < 1) fail('Nonempty distinct release assets are required.');
    ids.add(a.id);
  }
  return true;
}

export function validateLatestManifest(manifest, assets) {
  const index = new Map((assets instanceof Map ? [...assets.values()] : assets).map(a => [a.name, a]));
  const mapping = {'windows-x86_64': 0, 'windows-x86_64-nsis': 0, 'linux-x86_64': 1,
    'linux-x86_64-appimage': 1, 'linux-x86_64-deb': 2};
  if (manifest?.version !== PLAN.version || !manifest.platforms
      || JSON.stringify(Object.keys(manifest.platforms).sort()) !== JSON.stringify(Object.keys(mapping).sort())) fail('Canonical updater platforms and bundle aliases are required.');
  for (const [platform, position] of Object.entries(mapping)) {
    const name = PLAN.artifacts[position].installer; const update = manifest.platforms[platform];
    const signature = index.get(`${name}.sig`)?.signatureText;
    if (!index.has(name) || !signature || update?.signature !== signature
        || update.url !== `https://github.com/${PLAN.repository}/releases/download/${PLAN.tag}/${encodeURIComponent(name)}`) fail(`Manifest URL/signature mismatch: ${platform}`);
  }
  return true;
}

function command(binary, args, options = {}) {
  try { return execFileSync(binary, args, {encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], ...options}); }
  catch { fail(`Command failed: ${binary === process.execPath ? 'Node tool' : binary}`); }
}
const json = path => JSON.parse(command('gh', ['api', path]));
async function pages(path, key) {
  const values = [];
  for (let page = 1; page <= 10; page++) {
    const response = json(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const entries = key ? response[key] : response;
    if (!Array.isArray(entries) || entries.length > 100) fail('Invalid paginated inventory.');
    values.push(...entries);
    if (entries.length < 100) return values;
  }
  fail('Inventory pagination was incomplete.');
}
async function digest(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
async function regular(file, max = 512 * 1024 * 1024) {
  const s = await lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size < 1 || s.size > max) fail('A bounded regular file is required.');
  return s.size;
}
async function download(path, file, expectedSize) {
  const args = ['api', path];
  if (path.includes('/releases/assets/')) args.push('-H', 'Accept: application/octet-stream');
  const child = spawn('gh', args, {stdio: ['ignore', 'pipe', 'pipe']});
  child.stderr.resume();
  const timeout = setTimeout(() => child.kill('SIGKILL'), 600000);
  const ended = new Promise((ok, bad) => {
    child.once('error', () => bad(new Error('Artifact download could not start.')));
    child.once('close', code => code === 0 ? ok() : bad(new Error('Artifact download failed.')));
  });
  try {
    const results = await Promise.allSettled([ended, pipeline(child.stdout, createWriteStream(file, {flags: 'wx', mode: 0o600}))]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    if (expectedSize !== undefined && await regular(file) !== expectedSize) fail('Downloaded ZIP size mismatch.');
  } finally { clearTimeout(timeout); }
}

async function context(phase) {
  if (process.env.GITHUB_REPOSITORY !== PLAN.repository || !isAbsolute(process.env.SOURCE_ROOT ?? '')
      || !isAbsolute(process.env.RELEASE_TEMP ?? '')) fail('Explicit repository, SOURCE_ROOT and RELEASE_TEMP are required.');
  const root = await realpath(process.env.SOURCE_ROOT); const temp = resolve(process.env.RELEASE_TEMP);
  if (command('git', ['-C', root, 'rev-parse', 'HEAD']).trim() !== PLAN.sourceSha
      || command('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no']).trim()) fail('SOURCE_ROOT must be the clean frozen source checkout.');
  if (phase !== 'prepare' && process.env.GITHUB_ACTIONS !== 'true') fail('Signing and publishing require the isolated GitHub Actions runner.');
  if (process.env.GITHUB_ACTIONS === 'true' && dirname(temp) !== await realpath(process.env.RUNNER_TEMP)) fail('RELEASE_TEMP must be a direct private child of RUNNER_TEMP.');
  const modules = {};
  for (const name of ['release-check', 'release-tag', 'release-assets', 'release-verify', 'release-publish', 'release-notes']) {
    modules[name] = await import(pathToFileURL(resolve(root, `scripts/${name}.mjs`)).href);
  }
  await modules['release-check'].checkRelease({root, tag: PLAN.tag, requireSigning: phase === 'sign'});
  await modules['release-tag'].requireReleaseTagCommit(PLAN.repository, PLAN.tag, PLAN.sourceSha);
  const run = json(`${base}/actions/runs/${PLAN.runId}`);
  const jobs = await pages(`${base}/actions/runs/${PLAN.runId}/jobs`, 'jobs');
  const artifacts = await pages(`${base}/actions/runs/${PLAN.runId}/artifacts`, 'artifacts');
  validateCiEvidence(run, jobs, artifacts);
  return {root, temp, modules, run, jobs, artifacts};
}
async function assertWriters() {
  const original = json(`${base}/actions/runs/${PLAN.formalRunId}`);
  if (original.status !== 'completed') fail('The original formal release writer is still active.');
  validateLiveWriters(await pages(`${base}/actions/runs`, 'workflow_runs'), Number(process.env.GITHUB_RUN_ID));
}
const zipMetadata = `import sys,json,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 print(json.dumps([dict(name=i.filename,size=i.file_size,compressedSize=i.compress_size,mode=i.external_attr>>16,isDirectory=i.is_dir(),encrypted=bool(i.flag_bits&1)) for i in z.infolist()]))`;
const zipExtract = `import sys,zipfile,os
with zipfile.ZipFile(sys.argv[1]) as z:
 with z.open(sys.argv[2]) as source, open(sys.argv[3],'xb') as target:
  while True:
   data=source.read(1024*1024)
   if not data: break
   target.write(data)
os.chmod(sys.argv[3],0o600)`;

export async function prepare() {
  const c = await context('prepare');
  await mkdir(c.temp, {mode: 0o700});
  const installers = [];
  for (const a of PLAN.artifacts) {
    const zip = resolve(c.temp, `${a.id}.zip`);
    await download(`${base}/actions/artifacts/${a.id}/zip`, zip, c.artifacts.find(item => item.id === a.id).size_in_bytes);
    if (await digest(zip) !== a.sha256) fail('CI artifact ZIP SHA256 mismatch.');
    const entry = validateInstallerEntries(JSON.parse(command('python3', ['-c', zipMetadata, zip])), a);
    const file = resolve(c.temp, a.installer);
    command('python3', ['-c', zipExtract, zip, entry.name, file]);
    if (await regular(file) !== entry.size || await digest(file) !== a.installerSha256) fail('Extracted installer size/SHA256 mismatch.');
    installers.push({name: a.installer, size: entry.size, sha256: await digest(file), artifactId: a.id, zipSha256: a.sha256});
  }
  await writeFile(resolve(c.temp, 'prepared.json'), JSON.stringify({sourceSha: PLAN.sourceSha, runId: PLAN.runId, installers}, null, 2), {flag: 'wx', mode: 0o600});
  console.log('Prepared exactly three verified CI installers; no downloaded installer was executed.');
}
async function readPrepared(c) {
  const meta = JSON.parse(await readFile(resolve(c.temp, 'prepared.json'), 'utf8'));
  if (meta.sourceSha !== PLAN.sourceSha || meta.runId !== PLAN.runId || meta.installers?.length !== 3) fail('Prepared source evidence mismatch.');
  for (const a of PLAN.artifacts) {
    const matches = meta.installers.filter(i => i.name === a.installer);
    if (matches.length !== 1 || matches[0].artifactId !== a.id || matches[0].zipSha256 !== a.sha256
        || matches[0].size !== a.installerSize || matches[0].sha256 !== a.installerSha256
        || await regular(resolve(c.temp, a.installer)) !== a.installerSize
        || await digest(resolve(c.temp, a.installer)) !== a.installerSha256
        || await digest(resolve(c.temp, `${a.id}.zip`)) !== a.sha256) fail('Prepared artifact bytes changed.');
  }
  return meta;
}
async function verifyLocal(c) {
  const verifier = process.env.UPDATE_VERIFIER_BIN;
  if (!isAbsolute(verifier ?? '') || await realpath(verifier) !== resolve(c.root, 'target/release/strata-update-verifier')) fail('Build the real source Rust verifier in SOURCE_ROOT/target/release.');
  await regular(verifier);
  for (const a of PLAN.artifacts) {
    await regular(resolve(c.temp, `${a.installer}.sig`), 16384);
    command(verifier, ['--config', resolve(c.root, 'apps/desktop/src-tauri/tauri.conf.json'),
      '--signature', resolve(c.temp, `${a.installer}.sig`), '--artifact', resolve(c.temp, a.installer),
      '--version', PLAN.version, '--require-signed-version']);
  }
}
export async function sign() {
  const c = await context('sign');
  await readPrepared(c);
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim() || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) fail('An in-memory signing key is required; key files are forbidden.');
  const cli = resolve(c.root, 'apps/desktop/node_modules/@tauri-apps/cli/tauri.js');
  for (const a of PLAN.artifacts) {
    command(process.execPath, [cli, 'signer', 'sign', '--app-version', PLAN.version, resolve(c.temp, a.installer)], {cwd: resolve(c.root, 'apps/desktop')});
  }
  await verifyLocal(c);
  await writeFile(resolve(c.temp, 'signed.json'), JSON.stringify({sourceSha: PLAN.sourceSha,
    signatures: await Promise.all(PLAN.artifacts.map(async a => ({name: `${a.installer}.sig`, sha256: await digest(resolve(c.temp, `${a.installer}.sig`))})))}, null, 2), {flag: 'wx', mode: 0o600});
  console.log('All three installers signed for 0.1.3 and verified by the frozen-source Rust verifier.');
}
export async function publish() {
  const c = await context('publish');
  await readPrepared(c); await verifyLocal(c);
  const signed = JSON.parse(await readFile(resolve(c.temp, 'signed.json'), 'utf8'));
  if (signed.sourceSha !== PLAN.sourceSha || signed.signatures?.length !== 3) fail('Signed evidence mismatch.');
  for (const a of PLAN.artifacts) {
    const entries = signed.signatures.filter(s => s.name === `${a.installer}.sig`);
    if (entries.length !== 1 || entries[0].sha256 !== await digest(resolve(c.temp, `${a.installer}.sig`))) fail('Signed bytes changed.');
  }
  const body = c.modules['release-notes'].releaseNotes(await readFile(resolve(c.root, 'CHANGELOG.md'), 'utf8'), PLAN.version);
  const signatures = await Promise.all(PLAN.artifacts.map(async a => (await readFile(resolve(c.temp, `${a.installer}.sig`), 'utf8')).replace(/[\r\n]+$/, '')));
  const entry = i => ({signature: signatures[i], url: `https://github.com/${PLAN.repository}/releases/download/${PLAN.tag}/${encodeURIComponent(PLAN.artifacts[i].installer)}`});
  const manifest = {version: PLAN.version, notes: body, pub_date: new Date().toISOString(), platforms: {
    'windows-x86_64': entry(0), 'windows-x86_64-nsis': entry(0), 'linux-x86_64': entry(1),
    'linux-x86_64-appimage': entry(1), 'linux-x86_64-deb': entry(2)}};
  const localAssets = PLAN.artifacts.flatMap((a, i) => [{name: a.installer}, {name: `${a.installer}.sig`, signatureText: signatures[i]}]);
  validateLatestManifest(manifest, localAssets);
  await writeFile(resolve(c.temp, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  const sums = (await Promise.all(PLAN.artifacts.map(async a => `${await digest(resolve(c.temp, a.installer))}  ${a.installer}\n`))).join('');
  await writeFile(resolve(c.temp, 'SHA256SUMS'), sums, {flag: 'wx', mode: 0o600});
  const guard = () => c.modules['release-assets'].requireReleaseAssetsWritable({repository: PLAN.repository, tag: PLAN.tag, expectedSha: PLAN.sourceSha, requireDraft: true});
  await assertWriters(); await guard();
  const draft = await c.modules['release-verify'].findDraftRelease(PLAN.repository, PLAN.tag);
  if (draft.prerelease !== false || draft.assets?.some(a => !names().includes(a.name))) fail('Unexpected draft asset or prerelease state; no upload performed.');
  command('gh', ['release', 'upload', PLAN.tag, ...names().map(n => resolve(c.temp, n)), '--repo', PLAN.repository, '--clobber'], {timeout: 600000});
  await assertWriters(); await guard();
  const uploaded = await c.modules['release-verify'].findDraftRelease(PLAN.repository, PLAN.tag);
  validateReleaseInventory(uploaded);
  for (const asset of uploaded.assets) {
    if (asset.digest !== `sha256:${await digest(resolve(c.temp, asset.name))}`) fail('Uploaded SHA256 differs from verified CI installer/signature/manifest/checksum.');
  }
  await c.modules['release-verify'].verifyRelease({repository: PLAN.repository, tag: PLAN.tag,
    expectedSha: PLAN.sourceSha, root: c.root, verifierPath: process.env.UPDATE_VERIFIER_BIN});
  await assertWriters(); await guard();
  const finalDraft = await c.modules['release-verify'].findDraftRelease(PLAN.repository, PLAN.tag);
  validateReleaseInventory(finalDraft);
  if (finalDraft.id !== uploaded.id) fail('The verified draft identity changed.');
  for (const asset of finalDraft.assets) {
    const verified = uploaded.assets.find(a => a.name === asset.name);
    if (!verified || asset.id !== verified.id || asset.size !== verified.size || asset.digest !== verified.digest
        || asset.digest !== `sha256:${await digest(resolve(c.temp, asset.name))}`) fail('Verified release assets changed before publication.');
  }
  await c.modules['release-publish'].publishRelease({repository: PLAN.repository, tag: PLAN.tag,
    expectedSha: PLAN.sourceSha, version: PLAN.version});
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const phase = process.argv[2];
  if (process.argv.length !== 3 || !['prepare', 'sign', 'publish'].includes(phase)) fail('Use prepare, sign or publish.');
  await ({prepare, sign, publish})[phase]();
}
