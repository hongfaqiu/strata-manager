import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { copyWebsiteScreenshots } from './website-screenshots.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'strata-website-screenshots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const destination = join(root, 'published');
  const outside = join(root, 'outside');
  await mkdir(source);
  await mkdir(outside);
  return { source, destination, outside };
}

async function fileLink(t, target, path) {
  try { await symlink(target, path, 'file'); return true; }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip(`File symlinks unavailable: ${error.code}`);
    return false;
  }
}

const directoryLink = (target, path) => symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');

test('Preserve top-level WebP and recursively publish nested WebP bytes', async t => {
  const { source, destination } = await fixture(t);
  await mkdir(join(source, 'v0.1.4', 'zh'), { recursive: true });
  await writeFile(join(source, 'overview.zh.webp'), Buffer.from([0, 1, 2]));
  await writeFile(join(source, 'v0.1.4', 'zh', 'benchmark.webp'), Buffer.from([3, 4, 5]));
  assert.equal(await copyWebsiteScreenshots(source, destination), 2);
  assert.deepEqual(await readFile(join(destination, 'overview.zh.webp')), Buffer.from([0, 1, 2]));
  assert.deepEqual(await readFile(join(destination, 'v0.1.4', 'zh', 'benchmark.webp')), Buffer.from([3, 4, 5]));
});

test('Exclude metadata, scripts, other image formats and helpers contents', async t => {
  const { source, destination } = await fixture(t);
  await mkdir(join(source, 'helpers'));
  for (const name of ['manifest.json', 'capture.mjs', 'README.md', 'other.png', 'fake.webp.json', 'helpers/private.webp']) {
    await writeFile(join(source, name), 'not published');
  }
  await writeFile(join(source, 'chat.webp'), 'published');
  assert.equal(await copyWebsiteScreenshots(source, destination), 1);
  assert.equal(await readFile(join(destination, 'chat.webp'), 'utf8'), 'published');
  for (const name of ['manifest.json', 'capture.mjs', 'README.md', 'other.png', 'fake.webp.json', 'helpers']) {
    await assert.rejects(access(join(destination, name)), { code: 'ENOENT' });
  }
});

test('Reject a WebP file symlink that points outside the screenshot root', async t => {
  const { source, destination, outside } = await fixture(t);
  const target = join(outside, 'external.webp');
  await writeFile(target, 'outside');
  if (!await fileLink(t, target, join(source, 'linked.webp'))) return;
  await assert.rejects(copyWebsiteScreenshots(source, destination), /links are not allowed/);
  await assert.rejects(access(destination), { code: 'ENOENT' });
});

test('Reject file symlinks even when their extension would be ignored', async t => {
  const { source, destination, outside } = await fixture(t);
  const target = join(outside, 'manifest.json');
  await writeFile(target, '{}');
  if (!await fileLink(t, target, join(source, 'manifest.json'))) return;
  await assert.rejects(copyWebsiteScreenshots(source, destination), /links are not allowed/);
});

test('Reject directory symlinks or Windows junctions outside the root', async t => {
  const { source, destination, outside } = await fixture(t);
  await writeFile(join(outside, 'external.webp'), 'outside');
  await directoryLink(outside, join(source, 'v0.1.4'));
  await assert.rejects(copyWebsiteScreenshots(source, destination), /links are not allowed/);
  await assert.rejects(access(destination), { code: 'ENOENT' });
});

test('Reject directory links even when their target stays within the root', async t => {
  const { source, destination } = await fixture(t);
  await mkdir(join(source, 'original'));
  await writeFile(join(source, 'original', 'chat.webp'), 'original');
  await directoryLink(join(source, 'original'), join(source, 'alias'));
  await assert.rejects(copyWebsiteScreenshots(source, destination), /links are not allowed/);
});

test('Reject a linked source root and a non-directory source root', async t => {
  const { source, destination, outside } = await fixture(t);
  const linkedRoot = join(outside, 'linked-root');
  await directoryLink(source, linkedRoot);
  await assert.rejects(copyWebsiteScreenshots(linkedRoot, destination), /ordinary screenshot directory/);
  const fileRoot = join(outside, 'file-root.webp');
  await writeFile(fileRoot, 'file');
  await assert.rejects(copyWebsiteScreenshots(fileRoot, destination), /ordinary screenshot directory/);
});

test('Reject an existing destination junction instead of writing outside', async t => {
  const { source, destination, outside } = await fixture(t);
  await mkdir(join(source, 'v0.1.4'));
  await writeFile(join(source, 'v0.1.4', 'chat.webp'), 'image');
  await mkdir(destination);
  await directoryLink(outside, join(destination, 'v0.1.4'));
  await assert.rejects(copyWebsiteScreenshots(source, destination), /links are not allowed/);
  await assert.rejects(access(join(outside, 'chat.webp')), { code: 'ENOENT' });
});
