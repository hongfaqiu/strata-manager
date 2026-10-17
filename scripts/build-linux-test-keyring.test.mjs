/** The private test keyring may be reused only as a verified copy of the exact pinned build. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, 'scripts/build-linux-test-keyring.sh');
const linux = process.platform === 'linux';
const run = (args, env = {}) => spawnSync('bash', [script, ...args], {encoding: 'utf8', timeout: 20000,
  env: {...process.env, STRATA_TEST_KEYRING_CACHE: '', ...env}});
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const pinned = name => new RegExp(`^${name}=(\\S+)$`, 'm').exec(readFileSync(script, 'utf8'))[1];

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'strata-keyring-cache-test-'));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const key = run(['--cache-key']); assert.equal(key.status, 0, key.stderr);
  const match = /^strata-test-keyring-40\.0-([0-9a-f]{64})\n$/.exec(key.stdout); assert.ok(match, key.stdout);
  const dir = join(base, 'cache'); mkdirSync(dir, {mode: 0o700});
  const daemon = join(dir, 'gnome-keyring-daemon');
  copyFileSync(['/usr/bin/true', '/bin/true'].find(existsSync) ?? process.execPath, daemon); chmodSync(daemon, 0o700); // A real dynamically linked ELF stand-in.
  const evidence = binary => `version=40.0\nsource_sha256=${pinned('source_sha256')}\npatch_commit=${pinned('upstream_patch_commit')}\n`
    + `patch_sha256=${pinned('patch_sha256')}\nfingerprint=${match[1]}\nbinary_sha256=${binary}\n`;
  writeFileSync(join(dir, 'build-evidence.txt'), evidence(sha256(daemon)));
  return {base, dir, daemon, evidence, fingerprint: match[1]};
}

test('the cache key is stable, bound to the pinned inputs and only printed on stdout', {skip: !linux}, () => {
  const first = run(['--cache-key']); const second = run(['--cache-key']);
  assert.equal(first.status, 0); assert.equal(first.stdout, second.stdout);
  assert.match(first.stdout, /^strata-test-keyring-40\.0-[0-9a-f]{64}\n$/);
  for (const args of [['--cache-key', 'x'], ['--verify-cache'], ['--other']]) assert.equal(run(args).status, 2, args.join(' '));
});

test('a verified cache is copied into a fresh private prefix without downloading or building', {skip: !linux}, t => {
  const f = fixture(t);
  assert.equal(run(['--verify-cache', f.dir]).status, 0);
  const result = run([], {STRATA_TEST_KEYRING_CACHE: f.dir, RUNNER_TEMP: f.base});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Reusing the verified cached GNOME Keyring 40\.0 build/);
  assert.doesNotMatch(result.stderr, /Building isolated/);
  const daemon = result.stdout.trim();
  assert.ok(daemon.startsWith(f.base + '/strata-test-keyring-build.') && daemon.endsWith('/prefix/bin/gnome-keyring-daemon'));
  assert.equal(result.stdout, daemon + '\n');
  assert.equal(sha256(daemon), sha256(f.daemon));
  assert.equal(statSync(daemon).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(dirname(dirname(daemon)), 'build-evidence.txt'), 'utf8'), readFileSync(join(f.dir, 'build-evidence.txt'), 'utf8'));
});

for (const [name, tamper] of [
  ['a modified daemon', f => writeFileSync(f.daemon, Buffer.concat([readFileSync(f.daemon), Buffer.from('x')]))],
  ['a non-ELF daemon', f => { writeFileSync(f.daemon, '#!/bin/sh\n'); writeFileSync(join(f.dir, 'build-evidence.txt'), f.evidence(sha256(f.daemon))); }],
  ['different build inputs', f => writeFileSync(join(f.dir, 'build-evidence.txt'), f.evidence(sha256(f.daemon)).replace(f.fingerprint, '0'.repeat(64)))],
  ['a different pinned patch', f => writeFileSync(join(f.dir, 'build-evidence.txt'), f.evidence(sha256(f.daemon)).replace(/patch_sha256=\S+/, 'patch_sha256=' + 'f'.repeat(64)))],
  ['extra evidence', f => writeFileSync(join(f.dir, 'build-evidence.txt'), f.evidence(sha256(f.daemon)) + 'note=1\n')],
  ['a missing evidence file', f => rmSync(join(f.dir, 'build-evidence.txt'))],
  ['an extra cached file', f => writeFileSync(join(f.dir, 'libextra.so'), '')],
  ['a symbolic-link daemon', f => { const real = join(f.base, 'real'); copyFileSync(f.daemon, real); rmSync(f.daemon); symlinkSync(real, f.daemon); }],
  ['a symbolic-link cache directory', f => { const link = join(f.base, 'link'); symlinkSync(f.dir, link); f.dir = link; }],
  ['a relative cache directory', f => { f.dir = 'cache'; }],
]) {
  test(`cache verification rejects ${name}`, {skip: !linux}, t => {
    const f = fixture(t); tamper(f);
    const result = run(['--verify-cache', f.dir]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /absent, incomplete or bound to different inputs/);
  });
}

test('a relative cache setting is refused before any build', {skip: !linux}, () => {
  const result = run([], {STRATA_TEST_KEYRING_CACHE: 'relative/cache'});
  assert.equal(result.status, 2); assert.match(result.stderr, /absolute directory/);
});

test('the script never deletes or overwrites an existing cache directory', () => {
  const source = readFileSync(script, 'utf8');
  assert.doesNotMatch(source, /rm\s+-[a-z]*r/);
  assert.match(source, /! -e "\$cache_dir" \|\| -d "\$cache_dir" && ! -L "\$cache_dir" && -z "\$\(ls -A -- "\$cache_dir"\)"/);
  assert.deepEqual(readdirSync(dirname(script)).filter(name => name === 'build-linux-test-keyring.sh'), ['build-linux-test-keyring.sh']);
});
