/**
 * "Mac 稍后补发": finish a release published with defer_macos.
 *
 * Phases (all fail closed; nothing here prints secrets):
 *   pending  (ubuntu) list published releases that still wait for notarized macOS assets
 *   staple   (macOS)  check the CI notarization submission; when Accepted, staple and verify
 *   sign     (macOS)  Tauri updater signatures for the stapled DMG and app archive
 *   publish  (macOS)  add the four macOS assets, then darwin-aarch64 to latest.json (commit point)
 *
 * Only bytes bound by `release-from-ci.mjs prepare` with MACOS_RELEASE_MODE=followup
 * (this repository's own same-source CI) are ever stapled or uploaded.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CI_PROTOCOL, MACOS_COMPLETED_NOTE, MACOS_DEFERRED_MARKER, MACOS_DEFERRED_NOTE, REPOSITORY, command } from './release-from-ci.mjs';

const fail = message => { throw new Error(message); };
const base = '/repos/' + REPOSITORY;
const tagPattern = /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const submissionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RECORD_PROTOCOL = 'strata-macos-notarization/v1';
export const NOTARY_PENDING = 'In Progress';

async function digest(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
async function regularSize(file, max = 512 * 1024 * 1024) {
  const s = await lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size < 1 || s.size > max) fail('A bounded regular file is required: ' + file);
  return s.size;
}
async function output(values) {
  const text = Object.entries(values).map(([k, v]) => k + '=' + v + '\n').join('');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, text);
  process.stdout.write(text);
}

/** macOS asset names for a plan (same names the normal release would publish). */
export function macosAssets(plan) {
  const tarball = plan.artifacts.find(a => a.name === 'ci-darwin-aarch64-app-tarball')?.installer;
  const dmg = plan.artifacts.find(a => a.name === 'ci-darwin-aarch64-dmg')?.installer;
  const record = plan.artifacts.find(a => a.name === 'ci-darwin-aarch64-notarization')?.installer;
  if (!tarball || !dmg || !record || plan.macos !== 'followup') fail('A follow-up plan with macOS bytes and the notarization record is required.');
  return { tarball, dmg, record, uploads: [tarball, tarball + '.sig', dmg, dmg + '.sig'] };
}

/** Published releases created with defer_macos that still lack macOS assets. */
export function pendingReleases(releases) {
  if (!Array.isArray(releases)) fail('A release inventory is required.');
  return releases.filter(r => r && r.draft === false && typeof r.tag_name === 'string' && tagPattern.test(r.tag_name)
    && typeof r.body === 'string' && r.body.includes(MACOS_DEFERRED_MARKER)
    && Array.isArray(r.assets) && !r.assets.some(a => /_aarch64\.dmg$/i.test(a?.name ?? '')))
    .map(r => r.tag_name);
}

/** The CI record must describe exactly the bound CI DMG and run. */
export function validateRecord(record, plan, dmgSha256) {
  const names = macosAssets(plan);
  if (record?.protocol !== RECORD_PROTOCOL || !submissionPattern.test(record.submissionId ?? '')
      || record.version !== plan.version || record.sourceSha !== plan.sourceSha || record.runId !== plan.runId
      || record.runAttempt !== plan.runAttempt || !['auto', 'wait', 'defer'].includes(record.mode) || typeof record.stapled !== 'boolean'
      || typeof record.dmg?.name !== 'string' || record.dmg.name.replaceAll(' ', '.') !== names.dmg
      || !/^[0-9a-f]{64}$/.test(record.dmg.submittedSha256 ?? '') || !Number.isSafeInteger(record.dmg.size)
      || !/^[0-9a-f]{40}$/.test(record.app?.cdhash ?? '') || !/^[A-Z0-9]{10}$/.test(record.app?.teamIdentifier ?? '')) fail('The CI notarization record does not match the bound CI run and DMG.');
  const expected = record.stapled ? record.dmg.stapledSha256 : record.dmg.submittedSha256;
  if (dmgSha256 !== expected) fail('The bound CI DMG is not the notarized submission recorded by CI.');
  return record;
}

/** Apple's log must accept exactly the submitted bytes and cover the app's code directory. */
export function validateNotaryLog(log, record) {
  const cdhashes = (Array.isArray(log?.ticketContents) ? log.ticketContents : []).map(t => String(t?.cdhash ?? '').toLowerCase());
  if (log?.jobId?.toLowerCase() !== record.submissionId.toLowerCase() || log.status !== 'Accepted'
      || log.sha256 !== record.dmg.submittedSha256) fail('Apple notary log does not accept the recorded DMG bytes.');
  if (!cdhashes.includes(record.app.cdhash)) fail('Apple notary ticket does not cover the app code directory.');
  return true;
}

/** Add darwin-aarch64 to a deferred manifest; every other field stays byte-identical in value. */
export function completedManifest(manifest, { plan, tarball, signature }) {
  if (manifest?.version !== plan.version || !manifest.platforms || typeof manifest.platforms !== 'object') fail('latest.json does not belong to this release.');
  if (Object.hasOwn(manifest.platforms, 'darwin-aarch64')) fail('latest.json already has darwin-aarch64.');
  if (typeof signature !== 'string' || !signature || /[\r\n]$/.test(signature)) fail('A trimmed updater signature is required.');
  return { ...manifest, platforms: { ...manifest.platforms, 'darwin-aarch64': {
    signature, url: 'https://github.com/' + plan.repository + '/releases/download/' + encodeURIComponent(plan.tag) + '/' + encodeURIComponent(tarball) } } };
}

export function completedBody(body) {
  if (typeof body !== 'string' || !body.includes(MACOS_DEFERRED_NOTE)) fail('The release body lost its deferred macOS note.');
  return body.replace(MACOS_DEFERRED_NOTE, MACOS_COMPLETED_NOTE);
}

/** Tar entries must stay inside one "Strata Manager.app" directory. */
export function validateTarEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 2) fail('The app archive is empty.');
  for (const name of entries) {
    const clean = name.replace(/^\.\//, '');
    if (typeof name !== 'string' || clean.startsWith('/') || clean.split('/').includes('..')
        || !(clean === 'Strata Manager.app' || clean === 'Strata Manager.app/' || clean.startsWith('Strata Manager.app/'))) fail('Unsafe app archive entry: ' + name);
  }
  return true;
}

// ---------- runner phases ----------
const json = path => JSON.parse(command('gh', ['api', path]));
async function listReleases() {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const entries = json(base + '/releases?per_page=100&page=' + page);
    if (!Array.isArray(entries) || entries.length > 100) fail('Invalid release inventory.');
    all.push(...entries);
    if (entries.length < 100) return all;
  }
  fail('Release inventory pagination was incomplete.');
}
async function pending() {
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY) fail('Canonical repository only.');
  const requested = process.env.RELEASE_TAG ?? '';
  const tags = pendingReleases(await listReleases());
  if (requested && !tagPattern.test(requested)) fail('RELEASE_TAG must be v<semver>.');
  // An explicit tag may also be complete already; the macOS job reports that idempotently.
  const selected = requested ? [requested] : tags;
  await output({ tags: JSON.stringify(selected), count: String(selected.length) });
}

async function followupState() {
  const temp = process.env.RELEASE_TEMP;
  if (!isAbsolute(temp ?? '') || !isAbsolute(process.env.SOURCE_ROOT ?? '')) fail('RELEASE_TEMP and SOURCE_ROOT are required.');
  if (process.env.GITHUB_ACTIONS === 'true' && dirname(resolve(temp)) !== await realpath(process.env.RUNNER_TEMP)) fail('RELEASE_TEMP must be a private direct child of RUNNER_TEMP.');
  await regularSize(join(temp, 'prepared.json'), 65536);
  const meta = JSON.parse(await readFile(join(temp, 'prepared.json'), 'utf8'));
  const plan = meta.plan;
  if (meta.protocol !== CI_PROTOCOL || meta.validateOnly !== false || plan?.macos !== 'followup' || plan.tag !== process.env.RELEASE_TAG
      || plan.repository !== REPOSITORY || plan.sourceSha !== process.env.EXPECTED_SOURCE_SHA) fail('A follow-up prepare ledger for this tag is required.');
  const names = macosAssets(plan);
  for (const a of plan.artifacts) {
    const i = meta.installers.find(x => x.name === a.installer);
    if (!i || await regularSize(join(temp, a.installer)) !== i.size || await digest(join(temp, a.installer)) !== i.sha256) fail('Prepared follow-up bytes changed.');
  }
  const record = validateRecord(JSON.parse(await readFile(join(temp, names.record), 'utf8')), plan, await digest(join(temp, names.dmg)));
  return { temp: resolve(temp), root: await realpath(process.env.SOURCE_ROOT), plan, names, record, out: join(resolve(temp), 'macos-out') };
}
const retry = (binary, args) => {
  for (let attempt = 1; ; attempt++) {
    try { return execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 }); }
    catch (error) {
      if (attempt >= 4) { process.stderr.write(String(error.stdout ?? '') + String(error.stderr ?? '')); fail(binary + ' ' + args[0] + ' failed'); }
      execFileSync('sleep', [String(attempt * 15)]);
    }
  }
};
// Never let a failing command echo its arguments (they include notary credentials).
const run = (binary, args) => {
  try { return execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) { process.stderr.write(String(error.stderr ?? '').slice(0, 8192)); fail(binary + ' ' + (args[0] ?? '') + ' ' + (args[1] ?? '') + ' failed'); }
};
async function notaryAuth(temp) {
  const { APPLE_API_ISSUER: issuer, APPLE_API_KEY: keyId, APPLE_API_PRIVATE_KEY: key } = process.env;
  if (!issuer || !/^[A-Z0-9]{10}$/.test(keyId ?? '') || !key) fail('APPLE_API_ISSUER / APPLE_API_KEY / APPLE_API_PRIVATE_KEY are required.');
  const dir = join(dirname(temp), 'strata-private-keys');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'AuthKey_' + keyId + '.p8');
  await writeFile(path, key.endsWith('\n') ? key : key + '\n', { mode: 0o600 });
  return { args: ['--key', path, '--key-id', keyId, '--issuer', issuer], cleanup: () => rm(dir, { recursive: true, force: true }) };
}
function codesignOutput(path) {
  // codesign -dv writes its details to stderr.
  const r = spawnSync('codesign', ['-dv', '--verbose=4', path], { encoding: 'utf8' });
  if (r.status !== 0) fail('codesign could not read ' + path);
  return (r.stdout ?? '') + (r.stderr ?? '');
}
function requireDeveloperId(path, record, { cdhash = false } = {}) {
  const info = codesignOutput(path);
  if (!/^Authority=Developer ID Application: .+$/m.test(info) || !info.includes('\nTeamIdentifier=' + record.app.teamIdentifier + '\n')) fail('Not signed by the recorded Developer ID team: ' + path);
  if (cdhash && (info.match(/^CDHash=([0-9a-f]+)$/m)?.[1] ?? '').toLowerCase() !== record.app.cdhash) fail('The app code directory differs from the notarized CI app.');
}

async function staple() {
  const s = await followupState();
  const auth = await notaryAuth(s.temp);
  try {
    const info = JSON.parse(run('xcrun', ['notarytool', 'info', s.record.submissionId, ...auth.args, '--output-format', 'json']));
    const status = info?.status;
    console.log('Notary submission ' + s.record.submissionId + ': ' + status);
    if (status === NOTARY_PENDING) {
      console.log('::notice title=macOS notarization pending::' + s.plan.tag + ' is still being notarized; the scheduled follow-up will check again.');
      return output({ status: 'pending' });
    }
    if (status !== 'Accepted') {
      try { process.stdout.write(run('xcrun', ['notarytool', 'log', s.record.submissionId, ...auth.args])); } catch {}
      fail('Apple did not accept the macOS submission (' + status + '); fix the build and release a new version.');
    }
    const logPath = join(s.temp, 'notary-log.json');
    await rm(logPath, { force: true });
    run('xcrun', ['notarytool', 'log', s.record.submissionId, ...auth.args, logPath]);
    validateNotaryLog(JSON.parse(await readFile(logPath, 'utf8')), s.record);
  } finally { await auth.cleanup(); }

  await rm(s.out, { recursive: true, force: true });
  await mkdir(s.out, { mode: 0o700 });
  const dmg = join(s.out, s.names.dmg);
  await copyFile(join(s.temp, s.names.dmg), dmg);
  if (!s.record.stapled) retry('xcrun', ['stapler', 'staple', dmg]);
  retry('xcrun', ['stapler', 'validate', dmg]);
  run('codesign', ['--verify', '--strict', '--verbose=2', dmg]);
  requireDeveloperId(dmg, s.record);
  retry('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg]);

  const work = join(s.temp, 'macos-app');
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { mode: 0o700 });
  const tarball = join(s.temp, s.names.tarball);
  validateTarEntries(run('tar', ['-tzf', tarball]).split('\n').filter(Boolean));
  run('tar', ['-xzf', tarball, '-C', work]);
  const app = join(work, 'Strata Manager.app');
  requireDeveloperId(app, s.record, { cdhash: true });
  requireDeveloperId(join(app, 'Contents/MacOS/strata-supervisor'), s.record);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  let stapled = true;
  try { run('xcrun', ['stapler', 'validate', app]); } catch { stapled = false; }
  if (!stapled) retry('xcrun', ['stapler', 'staple', app]);
  retry('xcrun', ['stapler', 'validate', app]);
  retry('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
  const archive = join(s.out, s.names.tarball);
  run('tar', ['-czf', archive, '-C', work, 'Strata Manager.app']);
  validateTarEntries(run('tar', ['-tzf', archive]).split('\n').filter(Boolean));
  const staged = { protocol: RECORD_PROTOCOL, tag: s.plan.tag, sourceSha: s.plan.sourceSha, runId: s.plan.runId, submissionId: s.record.submissionId,
    files: [{ name: s.names.dmg, sha256: await digest(dmg), size: await regularSize(dmg) },
      { name: s.names.tarball, sha256: await digest(archive), size: await regularSize(archive) }] };
  await writeFile(join(s.out, 'staged.json'), JSON.stringify(staged, null, 2), { flag: 'wx', mode: 0o600 });
  console.log('Stapled and verified ' + s.names.dmg + ' and ' + s.names.tarball + '.');
  return output({ status: 'accepted' });
}

async function staged(s) {
  const st = JSON.parse(await readFile(join(s.out, 'staged.json'), 'utf8'));
  if (st.protocol !== RECORD_PROTOCOL || st.tag !== s.plan.tag || st.sourceSha !== s.plan.sourceSha || st.runId !== s.plan.runId
      || st.submissionId !== s.record.submissionId || st.files?.length !== 2) fail('Staged evidence mismatch.');
  for (const f of st.files) if (await digest(join(s.out, f.name)) !== f.sha256 || await regularSize(join(s.out, f.name)) !== f.size) fail('Staged bytes changed.');
  return st;
}
function verifyLocal(s) {
  const verifier = process.env.UPDATE_VERIFIER_BIN;
  if (!isAbsolute(verifier ?? '') || resolve(verifier) !== join(s.root, 'target/release/strata-update-verifier')) fail('Build the source Rust verifier in SOURCE_ROOT/target/release.');
  for (const name of [s.names.tarball, s.names.dmg]) command(verifier, ['--config', join(s.root, 'apps/desktop/src-tauri/tauri.conf.json'),
    '--signature', join(s.out, name + '.sig'), '--artifact', join(s.out, name), '--version', s.plan.version, '--require-signed-version']);
}
async function sign() {
  const s = await followupState(); await staged(s);
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim() || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) fail('An in-memory signing key is required; key files are forbidden.');
  const cli = join(s.root, 'apps/desktop/node_modules/@tauri-apps/cli/tauri.js');
  for (const name of [s.names.tarball, s.names.dmg]) {
    await rm(join(s.out, name + '.sig'), { force: true });
    command(process.execPath, [cli, 'signer', 'sign', '--app-version', s.plan.version, join(s.out, name)], { cwd: join(s.root, 'apps/desktop') });
  }
  verifyLocal(s);
  console.log('Updater signatures created and verified for the stapled macOS files.');
}

async function publish() {
  const s = await followupState(); const st = await staged(s); verifyLocal(s);
  const verify = await import(pathToFileURL(join(s.root, 'scripts/release-verify.mjs')).href);
  const tagModule = await import(pathToFileURL(join(s.root, 'scripts/release-tag.mjs')).href);
  const p = s.plan;
  await tagModule.requireReleaseTagCommit(p.repository, p.tag, p.sourceSha);
  const release = await verify.findPublishedRelease(p.repository, p.tag);
  if (!release.body?.includes(MACOS_DEFERRED_MARKER)) fail('Only releases published with defer_macos can be completed.');
  const manifestAsset = release.assets.find(a => a.name === 'latest.json');
  if (!manifestAsset) fail('The release has no latest.json.');
  const manifestPath = join(s.temp, 'release-latest.json');
  await rm(manifestPath, { force: true });
  await verify.downloadAssetToFile(p.repository, manifestAsset, manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (Object.hasOwn(manifest.platforms ?? {}, 'darwin-aarch64')) {
    // Committed earlier: verify, never rewrite.
    await verify.verifyRelease({ repository: p.repository, tag: p.tag, expectedSha: p.sourceSha, root: s.root, verifierPath: process.env.UPDATE_VERIFIER_BIN, published: true });
    console.log('macOS assets were already added to ' + p.tag + '; nothing to do.');
    return;
  }
  // Before the latest.json commit point, only our own four names may exist (from an interrupted run).
  const ours = new Set(s.names.uploads);
  const others = { ...release, assets: release.assets.filter(a => !ours.has(a.name)) };
  verify.validateRelease(others, manifest, { repository: p.repository, tag: p.tag, version: p.version, expectedSha: p.sourceSha,
    tagCommitSha: p.sourceSha, productName: p.productName, macos: 'deferred', published: true });
  command('gh', ['release', 'upload', p.tag, ...s.names.uploads.map(n => join(s.out, n)), '--repo', p.repository, '--clobber'], { timeout: 900000 });
  const signature = (await readFile(join(s.out, s.names.tarball + '.sig'), 'utf8')).replace(/[\r\n]+$/, '');
  const next = completedManifest(manifest, { plan: p, tarball: s.names.tarball, signature });
  const latest = join(s.out, 'latest.json');
  await writeFile(latest, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const uploaded = await verify.findPublishedRelease(p.repository, p.tag);
  for (const f of st.files) {
    const a = uploaded.assets.find(x => x.name === f.name);
    if (!a || a.size !== f.size || a.digest !== 'sha256:' + f.sha256) fail('Uploaded macOS asset differs from the verified local file: ' + f.name);
  }
  // Commit point: clients only see macOS once darwin-aarch64 is in latest.json.
  command('gh', ['release', 'upload', p.tag, latest, '--repo', p.repository, '--clobber'], { timeout: 300000 });
  await verify.verifyRelease({ repository: p.repository, tag: p.tag, expectedSha: p.sourceSha, root: s.root, verifierPath: process.env.UPDATE_VERIFIER_BIN, published: true });
  const body = completedBody(release.body);
  const patched = JSON.parse(command('gh', ['api', '--method', 'PATCH', base + '/releases/' + release.id, '--input', '-'], { input: JSON.stringify({ body }) }));
  if (patched.id !== release.id || patched.draft !== false) fail('Release identity changed while updating its notes.');
  console.log('Added notarized macOS assets and darwin-aarch64 to ' + p.tag + '.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [phase, ...rest] = process.argv.slice(2);
  const phases = { pending, staple, sign, publish };
  if (!phases[phase] || rest.length) fail('Use pending, staple, sign or publish.');
  await phases[phase]();
}
