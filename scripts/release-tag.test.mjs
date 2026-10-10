import assert from 'node:assert/strict';
import test from 'node:test';
import { checkReleaseTagEnvironment, ghTagJson, requireReleaseTagCommit, resolveReleaseTagCommit } from './release-tag.mjs';

const repository = 'owner/strata-manager';
const tag = 'v0.1.0-beta.1';
const commit = 'a'.repeat(40);
const otherCommit = 'b'.repeat(40);
const tagSha = 'c'.repeat(40);
const reference = (type = 'commit', sha = commit) => ({ ref: `refs/tags/${tag}`, object: { type, sha } });

test('a lightweight tag resolves its exact existing ref without consulting release metadata', async () => {
  const paths = [];
  assert.equal(await resolveReleaseTagCommit(repository, tag, { fetchJson: async path => {
    paths.push(path); return reference();
  } }), commit);
  assert.deepEqual(paths, [`/repos/${repository}/git/ref/tags/${tag}`]);
  assert.equal(await requireReleaseTagCommit(repository, tag, commit.toUpperCase(), { fetchJson: async () => reference() }), commit);
});

test('annotated tags peel only tag objects in the same repository', async () => {
  const secondTag = 'd'.repeat(40);
  const paths = [];
  const responses = [reference('tag', tagSha), { sha: tagSha, object: { type: 'tag', sha: secondTag } }, { sha: secondTag, object: { type: 'commit', sha: commit } }];
  assert.equal(await requireReleaseTagCommit(repository, tag, commit, { fetchJson: async path => {
    paths.push(path); return responses.shift();
  } }), commit);
  assert.deepEqual(paths, [`/repos/${repository}/git/ref/tags/${tag}`, `/repos/${repository}/git/tags/${tagSha}`, `/repos/${repository}/git/tags/${secondTag}`]);
});

test('an eight-object annotated chain is accepted but a ninth object is never requested', async () => {
  for (const length of [8, 9]) {
    const objects = Array.from({ length }, (_, index) => (index + 1).toString(16).padStart(40, '0'));
    const paths = [];
    let index = -1;
    const result = resolveReleaseTagCommit(repository, tag, { fetchJson: async path => {
      paths.push(path); index += 1;
      if (index === 0) return reference('tag', objects[0]);
      return { sha: objects[index - 1], object: index === length ? { type: 'commit', sha: commit } : { type: 'tag', sha: objects[index] } };
    } });
    if (length === 8) assert.equal(await result, commit);
    else await assert.rejects(result, /depth limit/);
    assert.equal(paths.length, 9);
  }
});

test('cycles and mismatched annotated object identities fail closed', async () => {
  for (const responses of [
    [reference('tag', tagSha), { sha: tagSha, object: { type: 'tag', sha: tagSha } }],
    [reference('tag', tagSha), { sha: otherCommit, object: { type: 'commit', sha: commit } }],
  ]) {
    let calls = 0;
    await assert.rejects(resolveReleaseTagCommit(repository, tag, { fetchJson: async () => { calls += 1; return responses.shift(); } }), /cycle|does not match/);
    assert.equal(calls, 2);
  }
});

test('wrong refs, malformed metadata, invalid SHAs and non-commit targets are refused', async () => {
  for (const value of [null, [], {}, { ...reference(), ref: 'refs/heads/main' }, { ...reference(), ref: `refs/tags/${tag}-other` },
    reference('tree'), reference('blob'), reference('commit', '123'), reference('commit', 'g'.repeat(40)), reference('commit', ''),
    { ...reference(), object: null }, { ...reference(), object: [] }]) {
    await assert.rejects(resolveReleaseTagCommit(repository, tag, { fetchJson: async () => value }), /exact existing|commit or annotated|full Git object/);
  }
  for (const value of [null, [], {}, { sha: tagSha, object: { type: 'tree', sha: commit } }, { sha: tagSha, object: { type: 'commit', sha: '123' } }]) {
    const responses = [reference('tag', tagSha), value];
    await assert.rejects(resolveReleaseTagCommit(repository, tag, { fetchJson: async () => responses.shift() }), /metadata|full Git object|commit or annotated/);
  }
});

test('missing refs, permissions errors and a moved tag cannot authorize publication', async () => {
  for (const message of ['HTTP 404 Not Found', 'HTTP 403 Resource not accessible by integration', 'metadata request timed out']) {
    await assert.rejects(requireReleaseTagCommit(repository, tag, commit, { fetchJson: async () => { throw new Error(message); } }), error => error.message === message);
  }
  await assert.rejects(requireReleaseTagCommit(repository, tag, commit, { fetchJson: async () => reference('commit', otherCommit) }), /does not match the expected source/);
});

test('invalid inputs and unbounded depth fail before any request', async () => {
  const fetchJson = async () => assert.fail('Invalid input must not request metadata.');
  for (const value of ['', null, 'owner', '../owner/repo', 'owner/repo/other']) await assert.rejects(resolveReleaseTagCommit(value, tag, { fetchJson }), /owner\/repository/);
  for (const value of ['', null, '@', '.hidden', 'v..1', 'v@{1}', '/v1', 'v1/', 'v//1', 'v1.lock', 'v1/.hidden', 'v1.', 'v 1', 'v1\n', 'v1\\other', 'v1?other', 'v1:other', 'v'.repeat(256)]) await assert.rejects(resolveReleaseTagCommit(repository, value, { fetchJson }), /Git tag name/);
  for (const value of [0, -1, 1.5, 9, Infinity]) await assert.rejects(resolveReleaseTagCommit(repository, tag, { fetchJson, maxTagDepth: value }), /bounded/);
  for (const value of ['', undefined, '123', 'x'.repeat(40)]) await assert.rejects(requireReleaseTagCommit(repository, tag, value, { fetchJson }), /Expected release commit/);
});

test('slash-containing tags use one encoded exact-ref endpoint and Git SHA-256 is supported', async () => {
  const nestedTag = 'release/v0.1.0-beta.1';
  const sha256 = 'e'.repeat(64);
  const paths = [];
  assert.equal(await requireReleaseTagCommit(repository, nestedTag, sha256, { fetchJson: async path => {
    paths.push(path); return { ref: `refs/tags/${nestedTag}`, object: { type: 'commit', sha: sha256 } };
  } }), sha256);
  assert.deepEqual(paths, [`/repos/${repository}/git/ref/tags/release%2Fv0.1.0-beta.1`]);
});

test('GitHub metadata subprocess has a 30-second deadline and forced termination', () => {
  let request;
  assert.deepEqual(ghTagJson('/repos/owner/strata-manager/git/ref/tags/v1', { execute: (...values) => {
    request = values; return '{"ref":"refs/tags/v1"}';
  } }), { ref: 'refs/tags/v1' });
  assert.deepEqual(request, ['gh', ['api', '/repos/owner/strata-manager/git/ref/tags/v1'], { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 30000, killSignal: 'SIGKILL' }]);
  assert.throws(() => ghTagJson('/repos/owner/strata-manager/git/ref/tags/v1', { execute: () => 'not JSON' }), SyntaxError);
  assert.throws(() => ghTagJson('/repos/owner/strata-manager/git/ref/tags/v1', { execute: () => { throw new Error('deadline'); } }), /deadline/);
});

test('the CLI environment binds repository, tag and workflow SHA and only logs public source identity', async () => {
  const messages = [];
  const env = { GITHUB_REPOSITORY: repository, RELEASE_TAG: tag, GITHUB_SHA: commit, GH_TOKEN: 'do-not-output-test-credential' };
  assert.equal(await checkReleaseTagEnvironment({ env, fetchJson: async () => reference(), logger: text => messages.push(text) }), commit);
  assert.deepEqual(messages, [`Release source verified: ${repository} ${tag} -> ${commit}.`]);
  for (const key of ['GITHUB_REPOSITORY', 'RELEASE_TAG', 'GITHUB_SHA']) {
    const missing = { ...env }; delete missing[key];
    await assert.rejects(checkReleaseTagEnvironment({ env: missing, fetchJson: async () => assert.fail('Missing environment must not request metadata.'), logger: () => assert.fail('Refused identity must not log success.') }));
  }
  await assert.rejects(checkReleaseTagEnvironment({ env, fetchJson: async () => reference('commit', otherCommit), logger: () => assert.fail('Mismatched source must not log success.') }), /does not match/);
});
