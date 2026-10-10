import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { assertInside, checkX64Binary, encodeFrame, parseArguments, rpc, selectPackages, validateResponse, validateRunner, windowsEndpoint } from './preview-package-smoke.mjs';

test('package smoke requires an explicit absolute directory and exact version', () => {
  const directory = resolve('bundle');
  assert.deepEqual(parseArguments(['--bundle-dir', directory, '--version', '0.1.0-beta.1']), { bundleDirectory: directory, version: '0.1.0-beta.1' });
  for (const arguments_ of [[], ['--bundle-dir', 'relative', '--version', '0.1.0'], ['--bundle-dir', directory, '--version', 'v0.1.0'], ['--bundle-dir', directory, '--version', '0.1.0', '--version', '0.1.1'], ['--bundle-dir', directory, '--unexpected', '0.1.0']]) assert.throws(() => parseArguments(arguments_));
});

test('cleanup operations cannot target the root, parent or a prefix sibling', () => {
  const root = resolve('owned');
  assert.equal(assertInside(root, join(root, 'data', 'supervisor')), join(root, 'data', 'supervisor'));
  for (const target of [root, resolve(root, '..'), `${root}-other`, resolve(root, '..', 'outside')]) assert.throws(() => assertInside(root, target), /outside/);
});

test('the preview selector refuses old, duplicate, wrong-product or incomplete platform packages', () => {
  const windows = 'Strata.Manager_0.1.0-beta.1_x64-setup.exe';
  const linux = ['Strata.Manager_0.1.0-beta.1_amd64.AppImage', 'strata-manager_0.1.0-beta.1_amd64.deb'];
  assert.deepEqual(selectPackages([windows], '0.1.0-beta.1', 'win32'), [windows]);
  assert.deepEqual(selectPackages(linux, '0.1.0-beta.1', 'linux'), linux);
  for (const files of [[], [windows, windows], ['Other_0.1.0-beta.1_x64-setup.exe'], ['Strata.Manager_0.1.0_x64-setup.exe']]) assert.throws(() => selectPackages(files, '0.1.0-beta.1', 'win32'), /exactly one/);
  assert.throws(() => selectPackages([linux[0]], '0.1.0-beta.1', 'linux'), /exactly one/);
  assert.throws(() => selectPackages([], '0.1.0-beta.1', 'darwin'), /supported/);
});

test('the Windows endpoint mirrors SID plus lowercase canonical-path SHA256', () => {
  const sid = 'S-1-5-21-123-456-789-1001';
  const path = 'C:\\Users\\Runner\\Private Test';
  const digest = createHash('sha256').update(`${sid}\n${path.toLowerCase()}`).digest('hex').slice(0, 32);
  assert.equal(windowsEndpoint(sid, path), `\\\\.\\pipe\\strata-supervisor-${digest}`);
  assert.notEqual(windowsEndpoint(sid, path), windowsEndpoint(`${sid}-other`, path));
});

test('binary inspection refuses wrong architecture, malformed or truncated files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'strata-preview-header-test-'));
  try {
    const path = join(directory, 'program');
    const elf = Buffer.alloc(64); Buffer.from('7f454c46', 'hex').copy(elf); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18);
    await writeFile(path, elf); await checkX64Binary(path, 'linux');
    elf.writeUInt16LE(183, 18); await writeFile(path, elf); await assert.rejects(checkX64Binary(path, 'linux'), /x86_64/);
    const pe = Buffer.alloc(70); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68);
    await writeFile(path, pe); await checkX64Binary(path, 'win32');
    pe.writeUInt16LE(0xaa64, 68); await writeFile(path, pe); await assert.rejects(checkX64Binary(path, 'win32'), /x64/);
    await writeFile(path, 'not executable'); await assert.rejects(checkX64Binary(path, 'win32'), /truncated/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('RPC responses must correlate and cannot hide protocol or operation errors', () => {
  assert.deepEqual(validateResponse({ protocolVersion: 1, id: 'test', result: { version: '0.1.0' }, error: null }, 'test'), { version: '0.1.0' });
  assert.throws(() => validateResponse({ protocolVersion: 2, id: 'test' }, 'test'), /protocol/);
  assert.throws(() => validateResponse({ protocolVersion: 1, id: 'other' }, 'test'), /correlation/);
  assert.throws(() => validateResponse({ protocolVersion: 1, id: 'test', error: { code: 'service_busy', message: 'busy' } }, 'test'), /service_busy/);
});

async function withServer(handler, run) {
  const server = createServer(socket => {
    let bytes = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', data => {
      bytes = Buffer.concat([bytes, data]);
      if (bytes.length >= 4 && bytes.length === bytes.readUInt32LE(0) + 4) handler(socket, JSON.parse(bytes.subarray(4).toString()));
    });
  });
  await new Promise(resolve_ => server.listen(0, '127.0.0.1', resolve_));
  try { await run({ host: '127.0.0.1', port: server.address().port }); }
  finally { await new Promise(resolve_ => server.close(resolve_)); }
}

test('RPC accepts fragmented frames and rejects oversized, incomplete and stalled replies', async () => {
  await withServer((socket, request) => {
    const response = encodeFrame({ protocolVersion: 1, id: request.id, result: { running: true }, error: null });
    socket.write(response.subarray(0, 2)); setTimeout(() => socket.write(response.subarray(2)), 5);
  }, async address => assert.deepEqual(await rpc(address, 'hello'), { running: true }));
  await withServer(socket => { const header = Buffer.alloc(4); header.writeUInt32LE(64 * 1024 * 1024 + 1); socket.write(header); }, async address => assert.rejects(rpc(address, 'hello'), /invalid frame/));
  await withServer(socket => socket.end(Buffer.from([10, 0, 0, 0, 123])), async address => assert.rejects(rpc(address, 'hello'), /incomplete/));
  await withServer(() => {}, async address => assert.rejects(rpc(address, 'hello', {}, 20), /timed out/));
});

test('package installation requires a disposable native runner and a real Linux GUI/DBus session', () => {
  const runner = { GITHUB_ACTIONS: 'true', RUNNER_TEMP: resolve('temporary') };
  assert.throws(() => validateRunner({}, 'win32', 'x64'), /disposable/);
  assert.throws(() => validateRunner({ ...runner, RUNNER_TEMP: 'relative' }, 'win32', 'x64'), /disposable/);
  assert.throws(() => validateRunner(runner, 'win32', 'arm64'), /native/);
  assert.throws(() => validateRunner(runner, 'linux', 'x64'), /dbus-run-session/);
  assert.doesNotThrow(() => validateRunner(runner, 'win32', 'x64'));
  assert.doesNotThrow(() => validateRunner({ ...runner, DISPLAY: ':99', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/isolated' }, 'linux', 'x64'));
});
