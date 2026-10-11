import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compareStableVersions, latestDecision, patchPublication, publishRelease, releaseInventory } from './release-publish.mjs';

const repository = 'owner/strata-manager';
const expectedSha = 'a'.repeat(40);
const release = (version, id = 1, draft = false, prerelease = version.includes('-')) => ({ id, tag_name: `v${version}`, draft, prerelease });
const tagResponse = tag => ({ ref: `refs/tags/${tag}`, object: { type: 'commit', sha: expectedSha } });

test('stable selection uses numeric SemVer precedence and ignores build metadata', () => {
  for (const [a, b, expected] of [['0.10.0', '0.9.9', 1], ['1.0.0', '0.99.99', 1], ['1.1.0', '1.2.0', -1], ['1.2.3+old', '1.2.3+new', 0], ['9007199254740993.0.0', '9007199254740992.0.0', 1]]) assert.equal(compareStableVersions(a, b), expected);
  for (const invalid of ['1.0', 'v1.0.0', '01.0.0', '1.0.0-beta.1']) assert.throws(() => compareStableVersions(invalid, '1.0.0'), /SemVer|prerelease/);
});

test('only a strictly higher stable candidate advances latest, regardless of inventory order', () => {
  const releases = [release('1.3.0', 1), release('1.10.0', 2), release('1.11.0-beta.1', 3), release('2.0.0', 4, true)];
  for (const inventory of [releases, releases.toReversed()]) {
    assert.equal(latestDecision('1.2.0', inventory), false);
    assert.equal(latestDecision('1.10.0+new', inventory), false);
    assert.equal(latestDecision('1.10.1', inventory), true);
    assert.equal(latestDecision('1.11.0-beta.2', inventory), false);
  }
  assert.equal(latestDecision('0.1.0', []), true);
  assert.equal(latestDecision('0.1.0-beta.1', []), false);
  assert.throws(() => latestDecision('1.0.0', [release('not-a-version', 1, false, false)]), /SemVer/);
});

test('inventory follows every page and refuses malformed, duplicate or truncated metadata', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => release(`0.0.${index}`, index + 1));
  const paths = [];
  assert.equal((await releaseInventory(repository, { fetchJson: async path => {
    paths.push(path); return paths.length === 1 ? firstPage : [release('1.0.0', 101)];
  } })).length, 101);
  assert.deepEqual(paths, [`/repos/${repository}/releases?per_page=100&page=1`, `/repos/${repository}/releases?per_page=100&page=2`]);
  for (const entries of [null, {}, [null], [release('1.0.0', 0)], [{ ...release('1.0.0'), draft: 'false' }], [{ ...release('1.0.0'), prerelease: undefined }], [release('1.0.0'), release('2.0.0')], [...firstPage, release('2.0.0', 101)]]) await assert.rejects(releaseInventory(repository, { fetchJson: async () => entries }), /inventory|Duplicate/);
  let calls = 0;
  await assert.rejects(releaseInventory(repository, { maxPages: 1, fetchJson: async () => { calls += 1; return firstPage; } }), /pagination limit/);
  assert.equal(calls, 1);
  for (const maxPages of [0, -1, 1.5, 11, Infinity]) await assert.rejects(releaseInventory(repository, { maxPages, fetchJson: async () => assert.fail('Invalid pagination must not request data.') }), /bounded/);
});

async function simulatedPublication(version, entries, options = {}) {
  const tag = `v${version}`; const writes = []; const events = [];
  const result = await publishRelease({ repository, tag, version, expectedSha,
    fetchJson: async () => { events.push('inventory'); return entries; },
    fetchTag: async () => { events.push('tag'); return tagResponse(tag); },
    patchRelease: async (repo, id, body) => { events.push('patch'); writes.push({ repo, id, body }); return { ...entries.find(entry => entry.id === id), draft: false }; },
    logger: () => {}, ...options });
  return { result, writes, events };
}

test('stable publication changes draft and latest together and older valid tags still publish', async () => {
  for (const [candidate, existing, expected] of [['1.2.0', '1.3.0', 'false'], ['1.3.0+next', '1.3.0', 'false'], ['1.4.0', '1.3.0', 'true']]) {
    const { result, writes, events } = await simulatedPublication(candidate, [release(existing, 1), release(candidate, 2, true)]);
    assert.deepEqual(writes, [{ repo: repository, id: 2, body: { draft: false, make_latest: expected } }]);
    assert.equal(result.makeLatest, expected === 'true');
    assert.deepEqual(events, ['tag', 'inventory', 'tag', 'patch']);
  }
});

test('all serialized stable completion orders publish every tag and keep latest monotonic', async () => {
  for (const versions of [['1.1.0', '1.3.0', '1.2.0'], ['1.3.0', '1.2.0', '1.1.0'], ['1.2.0', '1.1.0', '1.3.0']]) {
    const published = []; let latest;
    for (const [index, version] of versions.entries()) {
      const { result } = await simulatedPublication(version, [...published, release(version, index + 1, true)]);
      if (result.makeLatest) { if (latest) assert.equal(compareStableVersions(version, latest), 1); latest = version; }
      published.push(release(version, index + 1));
    }
    assert.equal(published.length, 3); assert.equal(latest, '1.3.0');
  }
});

test('prereleases always preserve stable latest, including the first preview', async () => {
  for (const stable of [[], [release('1.3.0', 1)]]) {
    const { writes } = await simulatedPublication('9.0.0-beta.1', [...stable, release('9.0.0-beta.1', 2, true)]);
    assert.equal(writes[0].body.make_latest, 'false');
  }
});

test('a missing, published, duplicate or misclassified draft cannot be published', async () => {
  for (const entries of [[], [release('1.0.0')], [release('1.0.0', 1, true), release('1.0.0', 2, true)], [release('1.0.0', 1, true, true)]]) await assert.rejects(simulatedPublication('1.0.0', entries, { patchRelease: async () => assert.fail('An invalid draft must not be written.') }), /unpublished draft|prerelease status/);
  await assert.rejects(simulatedPublication('1.0.0', [release('bad-stable', 1, false, false), release('1.0.0', 2, true)], { patchRelease: async () => assert.fail('Unknown stable precedence must not be written.') }), /SemVer/);
});

test('a tag moved during inventory collection fails before the publication write', async () => {
  let tagReads = 0;
  await assert.rejects(simulatedPublication('1.0.0', [release('1.0.0', 1, true)], {
    fetchTag: async () => ({ ...tagResponse('v1.0.0'), object: { type: 'commit', sha: ++tagReads === 1 ? expectedSha : 'b'.repeat(40) } }),
    patchRelease: async () => assert.fail('A moved source tag must not be published.'),
  }), /expected source commit/);
  assert.equal(tagReads, 2);
});

test('PATCH is one structured, repository-bound request with a finite timeout and no credential arguments', () => {
  let request;
  assert.deepEqual(patchPublication(repository, 12, { draft: false, make_latest: 'false' }, { execute: (...arguments_) => {
    request = arguments_; return '{"id":12}';
  } }), { id: 12 });
  assert.deepEqual(request, ['gh', ['api', '--method', 'PATCH', `/repos/${repository}/releases/12`, '--input', '-'], {
    input: '{"draft":false,"make_latest":"false"}', encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30000, killSignal: 'SIGKILL',
  }]);
  for (const body of [{ draft: true, make_latest: 'false' }, { draft: false, make_latest: true }, { draft: false, make_latest: 'legacy' }, { draft: false, make_latest: 'false', tag_name: 'different' }]) assert.throws(() => patchPublication(repository, 12, body, { execute: () => assert.fail('Invalid PATCH must not execute.') }), /Invalid release/);
});

test('an unexpected PATCH response is reported without retrying or mutating a tag', async () => {
  let writes = 0;
  await assert.rejects(simulatedPublication('1.0.0', [release('1.0.0', 1, true)], { patchRelease: async () => { writes += 1; return release('another', 7); } }), /Inspect the release before retrying/);
  assert.equal(writes, 1);
});

test('the workflow queues every publication without replacing pending tags and retains all gates', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const reusable = await readFile(new URL('../.github/workflows/release-from-ci.yml', import.meta.url), 'utf8');
  const helper = await readFile(new URL('./release-from-ci.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /uses: \.\/\.github\/workflows\/release-from-ci\.yml/);
  const publication = reusable.slice(reusable.indexOf('\n  promote:'));
  assert.match(publication, /needs: resolve/);
  assert.match(publication, /concurrency:\s*\n\s*group: .*format\('release-publish-\{0\}', github\.repository\).*\n\s*queue: max\s*\n\s*cancel-in-progress: false/);
  assert.ok(publication.indexOf('node scripts/release-from-ci.mjs prepare') < publication.indexOf('node scripts/release-from-ci.mjs sign'));
  assert.ok(publication.indexOf('node scripts/release-from-ci.mjs sign') < publication.indexOf('node scripts/release-from-ci.mjs publish'));
  assert.ok(helper.indexOf("c.modules['release-verify'].verifyRelease") < helper.indexOf("c.modules['release-publish'].publishRelease"));
  assert.doesNotMatch(publication + helper, /gh release edit|--latest/);
  assert.match(helper, /default_branch/);
  assert.doesNotMatch(publication, /matrix:|tauri-apps\/tauri-action/);
});
