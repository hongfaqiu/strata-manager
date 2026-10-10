import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { assertInside, checkX64Binary, compareVersions, encodeFrame, parseArguments, rpc, selectPackages, upgradeStoreCheckpoint, validateResponse, validateRunner, verifySupervisor, windowsEndpoint, windowsUpgradeSmoke } from './preview-package-smoke.mjs';

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

test('upgrade arguments require a complete Windows source, exact package name and strictly newer SemVer', () => {
  const directory = resolve('bundle');
  const source = resolve('Strata.Manager_0.1.0-beta.2_x64-setup.exe');
  const base = ['--bundle-dir', directory, '--version', '0.1.0'];
  const extra = ['--upgrade-from-installer', source, '--upgrade-from-version', '0.1.0-beta.2'];
  assert.deepEqual(parseArguments([...base, ...extra], 'win32'), { bundleDirectory: directory, version: '0.1.0', upgradeFrom: { installer: source, version: '0.1.0-beta.2' } });
  for (const arguments_ of [
    [...base, '--upgrade-from-installer', source], [...base, '--upgrade-from-version', '0.1.0-beta.2'],
    [...base, '--upgrade-from-installer', 'relative.exe', '--upgrade-from-version', '0.1.0-beta.2'],
    [...base, '--upgrade-from-installer', `${source}\n`, '--upgrade-from-version', '0.1.0-beta.2'],
    [...base, '--upgrade-from-installer', resolve('Other_0.1.0-beta.2_x64-setup.exe'), '--upgrade-from-version', '0.1.0-beta.2'],
    [...base, '--upgrade-from-installer', source, '--upgrade-from-version', '0.1.0'],
    [...base, '--upgrade-from-installer', source, '--upgrade-from-version', 'v0.1.0-beta.2'],
    [...base, ...extra, '--upgrade-from-version', '0.1.0-beta.1'],
    ['--bundle-dir', directory, '--version', '0.1.0-beta.1', ...extra],
    ['--bundle-dir', directory, '--version', '0.1.0-beta.2+new', ...extra],
  ]) assert.throws(() => parseArguments(arguments_, 'win32'));
  assert.throws(() => parseArguments([...base, ...extra], 'linux'), /Windows/);
});

test('upgrade comparison follows SemVer precedence, including numeric prereleases and ignored build metadata', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  for (let index = 1; index < ordered.length; index++) {
    assert.equal(compareVersions(ordered[index], ordered[index - 1]), 1);
    assert.equal(compareVersions(ordered[index - 1], ordered[index]), -1);
  }
  assert.equal(compareVersions('0.1.0-beta.2+new', '0.1.0-beta.2+old'), 0);
  assert.equal(compareVersions('0.1.0+new', '0.1.0+old'), 0);
  assert.equal(compareVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1);
  assert.throws(() => compareVersions('0.1.0-beta.02', '0.1.0'), /SemVer/);
});

test('upgrade KV checkpoint uses real framed RPC and rejects missing, corrupt or invalid markers', async () => {
  const values = new Map(); const methods = [];
  const marker = { key: `packageUpgradeSmoke:${randomUUID()}`, value: randomUUID() };
  await withServer((socket, request) => {
    methods.push(request.method);
    if (request.method === 'store_set') values.set(request.params.key, request.params.value);
    const result = request.method === 'store_get' ? values.get(request.params.key) ?? null : null;
    socket.end(encodeFrame({ protocolVersion: 1, id: request.id, result, error: null }));
  }, async address => {
    await upgradeStoreCheckpoint(address, { marker, seed: true });
    await upgradeStoreCheckpoint(address, { marker, seed: false });
    assert.deepEqual(methods, ['store_set', 'store_get', 'store_get']);
    values.delete(marker.key);
    await assert.rejects(upgradeStoreCheckpoint(address, { marker, seed: false }), /not preserved/);
    values.set(marker.key, 'corrupted');
    await assert.rejects(upgradeStoreCheckpoint(address, { marker, seed: false }), /not preserved/);
    const requestCount = methods.length;
    await assert.rejects(upgradeStoreCheckpoint(address, { marker: { key: 'profiles', value: marker.value }, seed: true }), /Invalid/);
    assert.equal(methods.length, requestCount, 'Invalid markers must never write another store key.');
  });
});

async function withUpgradeFixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'strata-preview-smoke-')));
  const oldInstaller = join(root, 'Strata.Manager_0.1.0-beta.2_x64-setup.exe');
  const installer = join(root, 'Strata.Manager_0.1.0_x64-setup.exe');
  const installDirectory = join(root, 'windows-install');
  const dataDirectory = join(root, 'windows-upgrade-data');
  const trace = []; const values = new Map();
  const source = { installer: oldInstaller, version: '0.1.0-beta.2' };
  // These are inert contract fixtures. No installer or GUI is executed by Node tests.
  await writeFile(oldInstaller, 'old inert installer fixture'); await writeFile(installer, 'new inert installer fixture');
  const command = async (executable, arguments_, options) => {
    assert.equal(options.cwd, root); assert.equal(options.verbatim, true);
    if (executable === oldInstaller || executable === installer) {
      trace.push(executable === oldInstaller ? 'install-old' : 'install-new');
      assert.deepEqual(arguments_, ['/S', `/D=${installDirectory}`]);
      assert.equal(options.timeout, 180000);
      await mkdir(installDirectory, { recursive: true });
      await writeFile(join(installDirectory, 'uninstall.exe'), 'inert uninstaller fixture');
      await writeFile(join(installDirectory, 'strata-manager.exe'), 'inert desktop fixture');
      await writeFile(join(installDirectory, 'strata-supervisor.exe'), 'inert supervisor fixture');
    } else {
      assert.equal(executable, join(installDirectory, 'uninstall.exe'));
      assertInside(root, executable);
      assert.deepEqual(arguments_, ['/S', `_?=${installDirectory}`]);
      assert.equal(options.timeout, 120000);
      trace.push('uninstall');
      await rm(installDirectory, { recursive: true });
    }
  };
  const dependencies = { command, platform: 'win32', architecture: 'x64', environment: { GITHUB_ACTIONS: 'true', RUNNER_TEMP: dirname(root) }, logger: () => {} };
  try {
    await withServer((socket, request) => {
      if (request.method === 'store_set') values.set(request.params.key, request.params.value);
      socket.end(encodeFrame({ protocolVersion: 1, id: request.id, result: request.method === 'store_get' ? values.get(request.params.key) ?? null : null, error: null }));
    }, async address => {
      dependencies.runPackage = async (sandbox, label, directory, launcher, version, options) => {
        assert.equal(sandbox, root); assert.equal(directory, installDirectory); assert.equal(launcher, undefined);
        assert.equal(options.dataDirectory, dataDirectory);
        const old = version === source.version;
        assert.equal(label, old ? 'windows-upgrade-before' : 'windows-upgrade-after');
        assert.equal(options.upgradeCheckpoint.seed, old);
        trace.push(old ? 'verify-old' : 'verify-new');
        await upgradeStoreCheckpoint(address, options.upgradeCheckpoint);
        trace.push(old ? 'closed-old' : 'closed-new');
        return { desktopHash: (old ? 'a' : 'b').repeat(64), supervisorHash: (old ? 'c' : 'd').repeat(64) };
      };
      await run({ root, source, installer, dependencies, trace, values });
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('upgrade installs old then new in one directory, preserves its real RPC KV and only uninstalls last', async () => {
  await withUpgradeFixture(async ({ root, source, installer, dependencies, trace, values }) => {
    await windowsUpgradeSmoke(root, installer, '0.1.0', source, dependencies);
    assert.deepEqual(trace, ['install-old', 'verify-old', 'closed-old', 'install-new', 'verify-new', 'closed-new', 'uninstall']);
    assert.equal(values.size, 1);
  });
});

test('upgrade never installs the candidate while old shutdown is pending or after it rejects', async () => {
  await withUpgradeFixture(async ({ root, source, installer, dependencies, trace }) => {
    let started; const oldStarted = new Promise(resolve_ => { started = resolve_; });
    let rejectShutdown; const stopped = new Promise((_, reject) => { rejectShutdown = reject; });
    const runPackage = dependencies.runPackage;
    dependencies.runPackage = async (...arguments_) => {
      await runPackage(...arguments_); started(); await stopped;
    };
    const operation = windowsUpgradeSmoke(root, installer, '0.1.0', source, dependencies);
    const rejected = assert.rejects(operation, /old shutdown failed/);
    await oldStarted;
    assert.equal(trace.includes('install-new'), false);
    rejectShutdown(new Error('old shutdown failed'));
    await rejected;
    assert.deepEqual(trace, ['install-old', 'verify-old', 'closed-old', 'uninstall']);
  });
});

test('failed candidate installation cleans up the owned old installation without running a new package', async () => {
  await withUpgradeFixture(async ({ root, source, installer, dependencies, trace }) => {
    const command = dependencies.command;
    dependencies.command = async (...arguments_) => {
      if (arguments_[0] === installer) { trace.push('failed-install-new'); throw new Error('candidate installation failed'); }
      return command(...arguments_);
    };
    await assert.rejects(windowsUpgradeSmoke(root, installer, '0.1.0', source, dependencies), /candidate installation failed/);
    assert.deepEqual(trace, ['install-old', 'verify-old', 'closed-old', 'failed-install-new', 'uninstall']);
  });
});

test('lost upgrade data and unchanged installed bytes fail acceptance and still uninstall', async () => {
  for (const defect of ['lost-data', 'stale-desktop', 'stale-supervisor']) {
    await withUpgradeFixture(async ({ root, source, installer, dependencies, trace, values }) => {
      const runPackage = dependencies.runPackage;
      dependencies.runPackage = async (...arguments_) => {
        const candidate = arguments_[4] === '0.1.0';
        if (candidate && defect === 'lost-data') values.clear();
        const result = await runPackage(...arguments_);
        if (candidate && defect === 'stale-desktop') result.desktopHash = 'a'.repeat(64);
        if (candidate && defect === 'stale-supervisor') result.supervisorHash = 'c'.repeat(64);
        return result;
      };
      await assert.rejects(windowsUpgradeSmoke(root, installer, '0.1.0', source, dependencies), defect === 'lost-data' ? /not preserved/ : /did not replace/);
      assert.equal(trace.at(-1), 'uninstall');
    });
  }
});

test('upgrade refuses non-CI, non-Windows, non-owned and empty inputs before executing any command', async () => {
  await withUpgradeFixture(async ({ root, source, installer, dependencies, trace }) => {
    await assert.rejects(windowsUpgradeSmoke(root, installer, '0.1.0', source, { ...dependencies, environment: {} }), /disposable/);
    await assert.rejects(windowsUpgradeSmoke(root, installer, '0.1.0', source, { ...dependencies, platform: 'linux', environment: { ...dependencies.environment, DISPLAY: ':99', DBUS_SESSION_BUS_ADDRESS: 'private' } }), /Windows/);
    const outside = join(root, 'not-a-owned-top-level-sandbox'); await mkdir(outside);
    await assert.rejects(windowsUpgradeSmoke(outside, installer, '0.1.0', source, dependencies), /owned disposable/);
    await writeFile(source.installer, '');
    await assert.rejects(windowsUpgradeSmoke(root, installer, '0.1.0', source, dependencies), /nonempty regular/);
    assert.deepEqual(trace, []);
  });
});

test('upgrade reports leftover binaries and preserves the original failure if uninstall also fails', async () => {
  await withUpgradeFixture(async ({ root, source, installer, dependencies, trace }) => {
    const command = dependencies.command;
    dependencies.command = async (...arguments_) => {
      if (basename(arguments_[0]) === 'uninstall.exe') { trace.push('uninstall-with-residue'); return; }
      return command(...arguments_);
    };
    await assert.rejects(windowsUpgradeSmoke(root, installer, '0.1.0', source, dependencies), /left packaged executables/);
    assert.equal(trace.at(-1), 'uninstall-with-residue');
  });
  await withUpgradeFixture(async ({ root, source, installer, dependencies }) => {
    const command = dependencies.command;
    dependencies.runPackage = async () => { throw new Error('original startup failure'); };
    dependencies.command = async (...arguments_) => {
      if (basename(arguments_[0]) === 'uninstall.exe') throw new Error('owned uninstall failure');
      return command(...arguments_);
    };
    await assert.rejects(windowsUpgradeSmoke(root, installer, '0.1.0', source, dependencies), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0].message, 'original startup failure');
      assert.equal(error.errors[1].message, 'owned uninstall failure');
      return true;
    });
  });
});

test('actual supervisor files must match candidate version, private data path, hash and zero services', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'strata-preview-smoke-')));
  try {
    const dataDirectory = join(root, 'data'); const cached = join(dataDirectory, 'supervisor');
    await mkdir(cached, { recursive: true });
    const supervisor = join(root, 'packaged-supervisor.exe'); const executablePath = join(cached, 'running-supervisor.exe');
    await writeFile(supervisor, 'candidate bytes'); await writeFile(executablePath, await readFile(supervisor));
    const executableHash = createHash('sha256').update(await readFile(supervisor)).digest('hex');
    const status = { protocolVersion: 1, version: '0.1.0', running: true, pid: process.pid + 1, dataDir: dataDirectory, executablePath, executableHash, activeServices: 0 };
    const context = { root, dataDirectory, version: '0.1.0', supervisor };
    await verifySupervisor(status, context);
    await assert.rejects(verifySupervisor({ ...status, version: '0.1.0-beta.2' }, context), /version/);
    await assert.rejects(verifySupervisor({ ...status, activeServices: 1 }, context), /model service/);
    await assert.rejects(verifySupervisor({ ...status, dataDir: root }, context), /another data/);
    await assert.rejects(verifySupervisor({ ...status, executableHash: '0'.repeat(64) }, context), /sidecar bytes/);
    await writeFile(executablePath, 'stale cached supervisor');
    await assert.rejects(verifySupervisor(status, context), /sidecar bytes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
