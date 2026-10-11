import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { requireReleaseAssetsWritable } from './release-assets.mjs';

const repository = 'owner/strata-manager';
const tag = 'v0.1.0-beta.2';
const expectedSha = 'a'.repeat(40);
const reference = (sha = expectedSha) => ({ ref: `refs/tags/${tag}`, object: { type: 'commit', sha } });
const release = (id = 1, draft = true, name = tag) => ({ id, tag_name: name, draft, prerelease: name.includes('-') });

async function guard(entries, options = {}) {
  return requireReleaseAssetsWritable({ repository, tag, expectedSha,
    fetchTag: async () => reference(), fetchJson: async () => entries, logger: () => {}, ...options });
}

test('a new tag or exactly one unpublished draft allows uploads without any write', async () => {
  for (const [entries, releaseId] of [[[], null], [[release()], 1], [[release(2, false, 'v0.0.1'), release()], 1]]) {
    const events = []; const messages = [];
    const result = await guard(entries, {
      fetchTag: async () => { events.push('tag'); return reference(); },
      fetchJson: async () => { events.push('inventory'); return entries; },
      logger: message => messages.push(message),
    });
    assert.deepEqual(result, { tag, source: expectedSha, releaseId });
    assert.deepEqual(events, ['tag', 'inventory', 'tag']);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Release upload allowed/);
  }
});

test('both published previews and stable releases fail before an upload is authorized', async () => {
  for (const publicTag of [tag, 'v0.1.0']) {
    await assert.rejects(guard([release(1, false, publicTag)], {
      tag: publicTag,
      fetchTag: async () => ({ ...reference(), ref: `refs/tags/${publicTag}` }),
      logger: () => assert.fail('A public release must never log upload permission.'),
    }), /already publicly released/);
  }
});

test('every duplicate same-tag release is rejected, including public and draft mixtures', async () => {
  for (const drafts of [[true, true], [true, false], [false, true], [false, false]]) {
    await assert.rejects(guard(drafts.map((draft, index) => release(index + 1, draft))), /Duplicate releases/);
  }
});

test('the complete inventory is required even when the first page contains an acceptable draft', async () => {
  const first = [release(), ...Array.from({ length: 99 }, (_, index) => release(index + 2, false, `v0.0.${index}`))];
  const paths = [];
  assert.equal((await guard([], { fetchJson: async path => { paths.push(path); return paths.length === 1 ? first : []; } })).releaseId, 1);
  assert.deepEqual(paths, [`/repos/${repository}/releases?per_page=100&page=1`, `/repos/${repository}/releases?per_page=100&page=2`]);
  let pages = 0;
  await assert.rejects(guard([], { fetchJson: async () => ++pages === 1 ? first : [release(101, false)] }), /Duplicate releases/);
  assert.equal(pages, 2);
});

test('malformed metadata, duplicate IDs and oversized pages cannot authorize an upload', async () => {
  const oversized = Array.from({ length: 101 }, (_, index) => release(index + 1, true, `v0.0.${index}`));
  for (const entries of [null, {}, [null], [[]], [release(0)], [{ ...release(), tag_name: '' }],
    [{ ...release(), draft: 'true' }], [{ ...release(), prerelease: undefined }],
    [release(), release(1, true, 'v0.0.1')], oversized]) {
    await assert.rejects(guard(entries, { logger: () => assert.fail('Bad metadata must never authorize uploads.') }), /inventory|Duplicate release ID/);
  }
});

test('pagination exhaustion or request failure fails closed without an authorization message', async () => {
  let pages = 0;
  await assert.rejects(guard([], { maxPages: 2, fetchJson: async () => {
    const start = pages++ * 100;
    return Array.from({ length: 100 }, (_, index) => release(start + index + 1, true, `v0.0.${start + index}`));
  } }), /pagination limit/);
  assert.equal(pages, 2);
  for (const maxPages of [0, 11, 1.5, Infinity]) await assert.rejects(guard([], { maxPages,
    fetchJson: async () => assert.fail('Invalid pagination must not fetch inventory.') }), /bounded/);
  for (const message of ['HTTP 403', 'HTTP 404', 'timeout', 'not JSON']) await assert.rejects(guard([], {
    fetchJson: async () => { throw new Error(message); }, logger: () => assert.fail('A failed request must not authorize uploads.'),
  }), error => error.message === message);
});

test('a wrong or unavailable source is refused before reading the release inventory', async () => {
  const fetchJson = async () => assert.fail('An invalid source must not read the inventory.');
  await assert.rejects(guard([], { fetchJson, fetchTag: async () => reference('b'.repeat(40)) }), /expected source commit/);
  await assert.rejects(guard([], { fetchJson, fetchTag: async () => { throw new Error('missing ref'); } }), /missing ref/);
  for (const [key, value] of [['repository', 'invalid'], ['tag', ''], ['expectedSha', 'bad']]) {
    await assert.rejects(guard([], { [key]: value, fetchJson, fetchTag: async () => assert.fail('Invalid source must not fetch a tag.') }));
  }
});

test('a tag moved during inventory collection fails the final source check', async () => {
  let tagReads = 0;
  await assert.rejects(guard([release()], { fetchTag: async () => reference(++tagReads === 1 ? expectedSha : 'b'.repeat(40)),
    logger: () => assert.fail('A moved tag must never authorize uploads.') }), /expected source commit/);
  assert.equal(tagReads, 2);
});

test('checksum replacement requires the existing unique draft and refuses invalid guard options', async () => {
  await assert.rejects(guard([], { requireDraft: true }), /exactly one unpublished draft/);
  assert.equal((await guard([release()], { requireDraft: true })).releaseId, 1);
  await assert.rejects(guard([release(1, false)], { requireDraft: true }), /already publicly released/);
  await assert.rejects(guard([], { requireDraft: 'true', fetchTag: async () => assert.fail('An invalid option must not fetch metadata.') }), /boolean/);
});

test('the CLI rejects unsupported arguments without a metadata request', () => {
  const script = fileURLToPath(new URL('./release-assets.mjs', import.meta.url));
  for (const args of [['--unsafe'], ['--require-draft', '--require-draft']]) {
    assert.throws(() => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }),
      error => error.status === 1 && error.stderr.includes('Only --require-draft is supported.'));
  }
});

test('reusable promotion rejects public tags early and rechecks the unique draft around upload and verification', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const reusable = await readFile(new URL('../.github/workflows/release-from-ci.yml', import.meta.url), 'utf8');
  const helper = await readFile(new URL('./release-from-ci.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /uses: \.\/\.github\/workflows\/release-from-ci\.yml/);
  const context = helper.slice(helper.indexOf('async function context('), helper.indexOf('async function bindCi('));
  assert.match(context, /requireReleaseTagCommit/);
  assert.match(context, /requireReleaseAssetsWritable/);
  assert.match(context, /await requireSourceRelease\(plan/);
  assert.match(helper, /requireDraft: false/);
  const publication = helper.slice(helper.indexOf('export async function publish('));
  const upload = publication.indexOf("command('gh', ['release', 'upload'");
  const verify = publication.indexOf("c.modules['release-verify'].verifyRelease");
  assert.ok(upload > publication.indexOf('await guard(true)'));
  assert.ok(publication.indexOf('await guard(true)', upload) > upload);
  assert.ok(verify > upload);
  assert.ok(publication.indexOf('await guard(true)', verify) > verify);
  assert.ok(publication.indexOf("c.modules['release-publish'].publishRelease") > verify);
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const source of [ci, reusable]) {
    const releaseTests = source.split(/\r?\n/).filter(line => line.includes('node --test scripts/release-check.test.mjs'));
    assert.ok(releaseTests.length > 0);
    for (const line of releaseTests) assert.ok(line.includes('scripts/release-assets.test.mjs'));
  }
});
