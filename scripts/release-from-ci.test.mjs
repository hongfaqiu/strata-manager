import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN, validateCiEvidence, validateInstallerEntries, validateLiveWriters,
  validateLatestManifest, validateReleaseInventory,
} from './release-from-ci.mjs';

const clone = value => structuredClone(value);
const successfulStep = name => ({ name, status: 'completed', conclusion: 'success' });

function ciFixture() {
  const run = {
    id: PLAN.runId, name: 'Build and test', path: PLAN.workflowPath,
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    head_sha: PLAN.sourceSha, run_attempt: 1,
    repository: { full_name: PLAN.repository },
    head_repository: { full_name: PLAN.repository },
  };
  const jobs = [
    {
      name: 'desktop (windows-latest, x86_64-pc-windows-msvc, nsis)',
      status: 'completed', conclusion: 'success',
      steps: [
        'Native tests (Windows)', 'Rust checks', 'Build test installers',
        'Verify installed Windows package and background IPC',
      ].map(successfulStep),
    },
    {
      name: 'desktop (ubuntu-22.04, x86_64-unknown-linux-gnu, appimage,deb)',
      status: 'completed', conclusion: 'success',
      steps: [
        'Native tests under Xvfb (Linux)', 'Rust checks', 'Build test installers',
        'Linux Secret Service wrapper contracts',
        'Build the pinned private Linux test keyring',
        'Linux Secret Service fresh-connection regression',
        'Verify Linux AppImage and DEB startup under Xvfb',
      ].map(successfulStep),
    },
  ];
  const artifacts = PLAN.artifacts.map(artifact => ({
    id: artifact.id, name: artifact.name, digest: `sha256:${artifact.sha256}`,
    expired: false, size_in_bytes: 4096,
    workflow_run: { id: PLAN.runId, head_sha: PLAN.sourceSha },
  }));
  return { run, jobs, artifacts };
}

test('the promotion plan is bound to the tested source and three artifact identities', () => {
  assert.equal(PLAN.repository, 'hongfaqiu/strata-manager');
  assert.equal(PLAN.sourceSha, 'ec0797dc06fc833cb5ebf433ecfb71b4c113767c');
  assert.equal(PLAN.tag, 'v0.1.3');
  assert.equal(PLAN.version, '0.1.3');
  assert.equal(PLAN.runId, 38159155279);
  assert.deepEqual(PLAN.artifacts.map(item => [item.id, item.sha256]), [
    [11709972517, '3150b9795da86427a49e0407141bf0b28ef71d212dc6ea155460bcea561bbc2e'],
    [11710157903, '85dd7aa50f8bd6a4029f6fb8f1186cd880f17213741c350d72129bfd11c300e7'],
    [11710068043, 'd9f90edcadf588bf57edad7f6fc6df19af56b66896f40185f5f94a5c57203d52'],
  ]);
});

test('complete same-source CI with all native, package and smoke gates is accepted', () => {
  const { run, jobs, artifacts } = ciFixture();
  assert.equal(validateCiEvidence(run, jobs, artifacts), true);
});

const invalidCiCases = [
  ['another source commit', fixture => { fixture.run.head_sha = 'a'.repeat(40); }],
  ['another run', fixture => { fixture.run.id += 1; }],
  ['a pull-request run', fixture => { fixture.run.event = 'pull_request'; }],
  ['another workflow', fixture => { fixture.run.path = '.github/workflows/release.yml'; }],
  ['a fork source', fixture => { fixture.run.head_repository.full_name = 'someone/strata-manager'; }],
  ['a partial whole run', fixture => { fixture.run.status = 'in_progress'; fixture.run.conclusion = null; }],
  ['a failed whole run', fixture => { fixture.run.conclusion = 'failure'; }],
  ['a missing platform job', fixture => { fixture.jobs.pop(); }],
  ['a queued platform job', fixture => { fixture.jobs[1].status = 'queued'; }],
  ['failed native tests', fixture => { fixture.jobs[0].steps[0].conclusion = 'failure'; }],
  ['skipped clippy', fixture => { fixture.jobs[1].steps[1].conclusion = 'skipped'; }],
  ['a missing package smoke', fixture => { fixture.jobs[1].steps.pop(); }],
  ['a wrong artifact ID', fixture => { fixture.artifacts[0].id += 1; }],
  ['a wrong ZIP digest', fixture => { fixture.artifacts[1].digest = `sha256:${'f'.repeat(64)}`; }],
  ['an expired artifact', fixture => { fixture.artifacts[2].expired = true; }],
  ['an artifact from another run', fixture => { fixture.artifacts[0].workflow_run.id += 1; }],
  ['a missing artifact', fixture => { fixture.artifacts.pop(); }],
  ['a duplicate artifact', fixture => { fixture.artifacts.push(clone(fixture.artifacts[0])); }],
];
for (const [label, mutate] of invalidCiCases) {
  test(`CI refuses ${label}`, () => {
    const fixture = ciFixture();
    mutate(fixture);
    assert.throws(() => validateCiEvidence(fixture.run, fixture.jobs, fixture.artifacts));
  });
}

function entryFixture(artifact = PLAN.artifacts[0]) {
  return { name: artifact.installer, size: artifact.installerSize, compressedSize: 2048,
    mode: 0o100644, isDirectory: false, encrypted: false };
}

test('ZIP selection accepts each fixed installer without executing its contents', () => {
  for (const artifact of PLAN.artifacts) {
    const selected = validateInstallerEntries([entryFixture(artifact)], artifact);
    assert.equal(selected.name, artifact.installer);
  }
});

const invalidZipCases = [
  ['parent traversal', entry => { entry.name = `../${entry.name}`; }],
  ['absolute paths', entry => { entry.name = `/${entry.name}`; }],
  ['Windows traversal separators', entry => { entry.name = `..\\${entry.name}`; }],
  ['symbolic links', entry => { entry.mode = 0o120777; }],
  ['directories', entry => { entry.isDirectory = true; }],
  ['encrypted data', entry => { entry.encrypted = true; }],
  ['empty payloads', entry => { entry.size = 0; }],
  ['unbounded payload sizes', entry => { entry.size = Number.MAX_SAFE_INTEGER; }],
  ['a stale installer version', entry => { entry.name = entry.name.replace('0.1.3', '0.1.2'); }],
];
for (const [label, mutate] of invalidZipCases) {
  test(`ZIP refuses ${label}`, () => {
    const entry = entryFixture();
    mutate(entry);
    assert.throws(() => validateInstallerEntries([entry], PLAN.artifacts[0]));
  });
}
test('ZIP refuses duplicate installers and unrelated executable files', () => {
  const entry = entryFixture();
  assert.throws(() => validateInstallerEntries([entry, clone(entry)], PLAN.artifacts[0]));
  assert.throws(() => validateInstallerEntries([entry, { ...entry, name: 'extra.exe' }], PLAN.artifacts[0]));
});

function completedFormalRun() {
  return { id: PLAN.formalRunId, path: '.github/workflows/release.yml',
    head_branch: PLAN.tag, head_sha: PLAN.sourceSha, status: 'completed', conclusion: 'cancelled' };
}
test('writer checks accept a finished old release and exclude only their own run', () => {
  const ownRunId = 9999;
  const own = { id: ownRunId, path: '.github/workflows/release-from-ci.yml', status: 'in_progress' };
  assert.equal(validateLiveWriters([completedFormalRun(), own], ownRunId), true);
});
test('writer checks reject queued original and independent concurrent writers', () => {
  assert.throws(() => validateLiveWriters([{ ...completedFormalRun(), status: 'queued' }], 9999));
  assert.throws(() => validateLiveWriters([completedFormalRun(), {
    id: 10000, path: '.github/workflows/release.yml', head_branch: PLAN.tag,
    head_sha: PLAN.sourceSha, status: 'in_progress',
  }], 9999));
  assert.throws(() => validateLiveWriters([completedFormalRun(), {
    id: 10000, path: '.github/workflows/release-from-ci.yml', status: 'queued',
  }], 9999));
});

function releaseFixture() {
  let nextId = 1;
  const assets = [];
  const updates = {};
  for (const artifact of PLAN.artifacts) {
    const signatureText = Buffer.from(`public-signature-fixture-${artifact.kind}`).toString('base64');
    assets.push({ id: nextId++, name: artifact.installer, size: 4096 });
    assets.push({ id: nextId++, name: `${artifact.installer}.sig`, size: 128, signatureText });
    updates[artifact.kind] = { signature: signatureText,
      url: `https://github.com/${PLAN.repository}/releases/download/${PLAN.tag}/${encodeURIComponent(artifact.installer)}` };
  }
  assets.push({ id: nextId++, name: 'latest.json', size: 1024 });
  assets.push({ id: nextId++, name: 'SHA256SUMS', size: 512 });
  const manifest = { version: PLAN.version, notes: 'Release test fixture',
    pub_date: '2026-10-12T00:00:00Z', platforms: {
      'windows-x86_64': clone(updates.windows),
      'windows-x86_64-nsis': clone(updates.windows),
      'linux-x86_64': clone(updates.appimage),
      'linux-x86_64-appimage': clone(updates.appimage),
      'linux-x86_64-deb': clone(updates.deb),
    } };
  return { manifest, release: { id: 123, tag_name: PLAN.tag, draft: true, prerelease: false, assets } };
}

test('exact eight-asset draft and all five canonical updater entries are accepted', () => {
  const { manifest, release } = releaseFixture();
  assert.equal(validateLatestManifest(manifest, release.assets), true);
  assert.equal(validateReleaseInventory(release), true);
});
test('updater refuses changed versions, external URLs, missing DEB and signature substitution', () => {
  for (const mutate of [
    manifest => { manifest.version = '0.1.4'; },
    manifest => { manifest.platforms['windows-x86_64'].url = 'https://example.org/package.exe'; },
    manifest => { delete manifest.platforms['linux-x86_64-deb']; },
    manifest => { manifest.platforms['linux-x86_64-appimage'].signature = 'different-public-signature'; },
    manifest => { manifest.platforms['linux-x86_64-deb'].url = manifest.platforms['linux-x86_64'].url; },
  ]) {
    const { manifest, release } = releaseFixture();
    mutate(manifest);
    assert.throws(() => validateLatestManifest(manifest, release.assets));
  }
});
test('release inventory refuses public releases, prereleases and every eight-asset deviation', () => {
  for (const mutate of [
    release => { release.draft = false; },
    release => { release.prerelease = true; },
    release => { release.tag_name = 'v0.1.2'; },
    release => { release.assets.pop(); },
    release => { release.assets.push({ id: 100, name: 'README.md', size: 1 }); },
    release => { release.assets[1].name = release.assets[0].name; },
    release => { release.assets[0].size = 0; },
    release => { release.assets[0].id = 0; },
  ]) {
    const { release } = releaseFixture();
    mutate(release);
    assert.throws(() => validateReleaseInventory(release));
  }
});
