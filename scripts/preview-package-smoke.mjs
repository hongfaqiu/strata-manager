/** Exercise the actual preview packages on disposable CI runners, without model inference. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { semver } from './release-check.mjs';

const protocolVersion = 1;
const maximumFrame = 64 * 1024 * 1024;
const delay = milliseconds => new Promise(resolve_ => setTimeout(resolve_, milliseconds));
const alive = pid => {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      // A gracefully exited orphan may briefly await its runner's subreaper.
      const status = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (status.slice(status.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    }
    return true;
  } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return false; throw error; }
};

export function compareVersions(left, right) {
  const a = semver.exec(left); const b = semver.exec(right);
  if (!a || !b) throw new Error('Upgrade versions must be valid SemVer.');
  for (let index = 1; index <= 3; index++) {
    const difference = BigInt(a[index]) - BigInt(b[index]);
    if (difference) return difference > 0n ? 1 : -1;
  }
  if (!a[4] || !b[4]) return a[4] ? -1 : b[4] ? 1 : 0;
  const first = a[4].split('.'); const second = b[4].split('.');
  for (let index = 0; index < Math.max(first.length, second.length); index++) {
    if (first[index] === second[index]) continue;
    if (first[index] === undefined || second[index] === undefined) return first[index] === undefined ? -1 : 1;
    const firstNumeric = /^\d+$/.test(first[index]); const secondNumeric = /^\d+$/.test(second[index]);
    if (firstNumeric && secondNumeric) return BigInt(first[index]) > BigInt(second[index]) ? 1 : -1;
    if (firstNumeric !== secondNumeric) return firstNumeric ? -1 : 1;
    return first[index] > second[index] ? 1 : -1;
  }
  return 0;
}

function validateUpgrade(upgradeFrom, version, platform) {
  if (platform !== 'win32') throw new Error('Same-directory NSIS upgrade smoke requires Windows.');
  if (!isAbsolute(upgradeFrom.installer ?? '') || /[\x00-\x1f\x7f]/.test(upgradeFrom.installer)) throw new Error('The upgrade installer must have an absolute path without control characters.');
  if (compareVersions(version, upgradeFrom.version) <= 0) throw new Error('The candidate version must be strictly newer than the upgrade source.');
  selectPackages([upgradeFrom.installer], upgradeFrom.version, 'win32');
}

export function parseArguments(arguments_, platform = process.platform) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]; const value = arguments_[index + 1];
    if (!['--bundle-dir', '--version', '--upgrade-from-installer', '--upgrade-from-version'].includes(flag) || !value || values[flag]) throw new Error('Use --bundle-dir <absolute directory> --version <SemVer>, optionally with both --upgrade-from-installer and --upgrade-from-version.');
    values[flag] = value;
  }
  if (!isAbsolute(values['--bundle-dir'] ?? '') || !semver.test(values['--version'] ?? '')) throw new Error('An absolute bundle directory and version are required.');
  const options = { bundleDirectory: values['--bundle-dir'], version: values['--version'] };
  if (values['--upgrade-from-installer'] || values['--upgrade-from-version']) {
    if (!values['--upgrade-from-installer'] || !values['--upgrade-from-version']) throw new Error('Both upgrade source arguments are required.');
    options.upgradeFrom = { installer: values['--upgrade-from-installer'], version: values['--upgrade-from-version'] };
    validateUpgrade(options.upgradeFrom, options.version, platform);
  }
  return options;
}

export function assertInside(root, target) {
  const child = relative(root, target);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Operation is outside the owned package-test sandbox.');
  return target;
}

async function ownedPath(root, target) {
  assertInside(root, target);
  const actual = await realpath(target);
  assertInside(root, actual);
  return actual;
}

async function boundedCommand(command, arguments_, { cwd, env = process.env, timeout = 60000, verbatim = false } = {}) {
  const child = spawn(command, arguments_, { cwd, env, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; let expired = false;
  child.stdout.on('data', data => { if (output.length < 65536) output += data.toString().slice(0, 65536 - output.length); });
  child.stderr.on('data', data => { if (errors.length < 65536) errors += data.toString().slice(0, 65536 - errors.length); });
  let rejectCompletion;
  const timer = setTimeout(() => {
    expired = true; child.kill('SIGKILL');
    child.stdout.destroy(); child.stderr.destroy();
    rejectCompletion(new Error(`${basename(command)} timed out after ${timeout} ms.`));
  }, timeout);
  try {
    await new Promise((resolve_, reject) => {
      rejectCompletion = reject;
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (expired) reject(new Error(`${basename(command)} timed out after ${timeout} ms.`));
        else if (code !== 0) reject(new Error(`${basename(command)} failed (${code ?? signal}): ${errors.trim() || output.trim()}`));
        else resolve_();
      });
    });
    return output.trim();
  } finally { clearTimeout(timer); }
}

const powershell = code => boundedCommand('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { timeout: 15000 });
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;

export function windowsEndpoint(identity, canonicalDataDirectory) {
  const hash = createHash('sha256').update(`${identity}\n${canonicalDataDirectory.toLowerCase()}`).digest('hex').slice(0, 32);
  return `\\\\.\\pipe\\strata-supervisor-${hash}`;
}

async function endpoint(dataDirectory) {
  if (process.platform === 'win32') {
    const identity = await powershell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
    if (!/^S-1-\d+(?:-\d+)+$/.test(identity)) throw new Error('Cannot resolve the current Windows SID.');
    return windowsEndpoint(identity, await realpath(dataDirectory));
  }
  return join(dataDirectory, '.ipc', 'supervisor.sock');
}

export function encodeFrame(request) {
  const payload = Buffer.from(JSON.stringify(request));
  if (!payload.length || payload.length > maximumFrame) throw new Error('Invalid RPC frame size.');
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
  return frame;
}

export function validateResponse(response, id) {
  if (!response || response.id !== id || response.protocolVersion !== protocolVersion) throw new Error('Supervisor RPC correlation or protocol mismatch.');
  if (response.error) throw new Error(`Supervisor RPC ${response.error.code}: ${response.error.message}`);
  return response.result;
}

export function rpc(address, method, params = {}, timeout = 3000) {
  const id = randomUUID();
  const request = { protocolVersion, id, method, params };
  return new Promise((resolve_, reject) => {
    const socket = createConnection(address);
    let bytes = Buffer.alloc(0); let length;
    const finish = (error, value) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve_(value); };
    const timer = setTimeout(() => finish(new Error(`Supervisor RPC ${method} timed out.`)), timeout);
    socket.once('connect', () => socket.write(encodeFrame(request)));
    socket.once('error', error => finish(error));
    socket.once('end', () => finish(new Error('Supervisor closed an incomplete RPC response.')));
    socket.on('data', data => {
      try {
        if (bytes.length + data.length > maximumFrame + 4) throw new Error('Supervisor response exceeds the frame limit.');
        bytes = Buffer.concat([bytes, data]);
        if (length === undefined && bytes.length >= 4) {
          length = bytes.readUInt32LE(0);
          if (!length || length > maximumFrame) throw new Error('Supervisor returned an invalid frame size.');
        }
        if (length !== undefined && bytes.length >= length + 4) {
          if (bytes.length !== length + 4) throw new Error('Supervisor returned extra frame bytes.');
          finish(null, validateResponse(JSON.parse(bytes.subarray(4).toString('utf8')), id));
        }
      } catch (error) { finish(error); }
    });
  });
}

async function filesUnder(directory, depth = 0) {
  if (depth > 5) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path, depth + 1));
    else if (entry.isFile()) result.push(path);
  }
  if (result.length > 10000) throw new Error('Unexpectedly large package file listing.');
  return result;
}

export function selectPackages(files, version, platform) {
  const suffixes = platform === 'win32' ? ['_x64-setup.exe'] : platform === 'linux' ? ['_amd64.AppImage', '_amd64.deb'] : [];
  if (!suffixes.length) throw new Error('Only Windows x64 and Linux x64 package tests are supported.');
  return suffixes.map(suffix => {
    const matches = files.filter(file => basename(file).toLowerCase().endsWith(`_${version}${suffix}`.toLowerCase()) && /^strata[. _-]*manager_/i.test(basename(file)));
    if (matches.length !== 1) throw new Error(`Expected exactly one Strata Manager ${version}${suffix} package.`);
    return matches[0];
  });
}

export async function checkX64Binary(path, platform) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(64);
    if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length) throw new Error('Packaged executable header is truncated.');
    if (platform === 'linux') {
      if (header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) throw new Error('Expected a Linux x86_64 ELF executable.');
    } else {
      if (header.subarray(0, 2).toString() !== 'MZ') throw new Error('Expected a Windows PE executable.');
      const offset = header.readUInt32LE(60);
      if (offset < 64 || offset > 1024 * 1024) throw new Error('Invalid Windows PE header offset.');
      const signature = Buffer.alloc(6);
      if ((await file.read(signature, 0, 6, offset)).bytesRead !== 6 || signature.readUInt32LE(0) !== 0x4550 || signature.readUInt16LE(4) !== 0x8664) throw new Error('Expected a Windows x64 PE executable.');
    }
  } finally { await file.close(); }
}

async function findExecutables(root, packageDirectory) {
  const files = await filesUnder(packageDirectory);
  const extension = process.platform === 'win32' ? '.exe' : '';
  const supervisor = files.filter(file => basename(file) === `strata-supervisor${extension}`);
  const desktop = files.filter(file => process.platform === 'win32' ? /^strata[ ._-]*manager\.exe$/i.test(basename(file)) : basename(file) === 'strata-manager');
  if (supervisor.length !== 1 || desktop.length !== 1) throw new Error('The package must contain exactly one desktop executable and supervisor sidecar.');
  for (const file of [desktop[0], supervisor[0]]) { await ownedPath(root, file); await checkX64Binary(file, process.platform); }
  return { desktop: desktop[0], supervisor: supervisor[0] };
}

export async function verifySupervisor(status, { root, dataDirectory, version, supervisor }) {
  if (!status || status.protocolVersion !== protocolVersion || status.version !== version || status.running !== true || !Number.isSafeInteger(status.pid) || status.pid < 1 || status.pid === process.pid) throw new Error('Packaged supervisor protocol, process or version does not match.');
  const actualData = await realpath(status.dataDir);
  if (actualData !== await realpath(dataDirectory)) throw new Error('The package connected to another data directory.');
  const executable = await ownedPath(root, status.executablePath);
  assertInside(join(dataDirectory, 'supervisor'), executable);
  const expectedHash = createHash('sha256').update(await readFile(supervisor)).digest('hex');
  const actualHash = createHash('sha256').update(await readFile(executable)).digest('hex');
  if (status.executableHash !== expectedHash || actualHash !== expectedHash) throw new Error('The running supervisor does not match the packaged sidecar bytes.');
  if (status.activeServices !== 0) throw new Error('A fresh package-test store unexpectedly started a model service.');
  return { ...status, executablePath: executable };
}

function launchGui(executable, environment, cwd) {
  const child = spawn(executable, [], { cwd, env: environment, windowsHide: true, detached: process.platform === 'linux', stdio: ['ignore', 'ignore', 'pipe'] });
  const state = { child, executable, error: null, stderr: '' };
  child.once('error', error => { state.error = error; });
  child.stderr.on('data', bytes => { if (state.stderr.length < 32768) state.stderr += bytes.toString().slice(0, 32768 - state.stderr.length); });
  return state;
}

async function closeGui(gui) {
  if (!gui?.child.pid) return;
  const child = gui.child;
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Take handles while our root Child is live; exclude the independently
    // running supervisor, which must receive its graceful RPC shutdown below.
    await powershell(`$rootProcess = Get-Process -Id ${child.pid} -ErrorAction Stop; if ($rootProcess.Path -ine ${psLiteral(gui.executable)}) { throw 'GUI process identity changed.' }; $all = @(Get-CimInstance Win32_Process); $owned = @{ ${child.pid} = $true }; do { $changed = $false; foreach ($p in $all) { if ($owned.ContainsKey([int]$p.ParentProcessId) -and !$owned.ContainsKey([int]$p.ProcessId) -and $p.Name -ine 'strata-supervisor.exe') { $owned[[int]$p.ProcessId] = $true; $changed = $true } } } while ($changed); $handles = @(); foreach ($id in $owned.Keys) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { $null = $p.Handle; $handles += $p } }; foreach ($p in $handles) { if (!$p.HasExited) { $p.Kill(); if (!$p.WaitForExit(10000)) { throw 'Owned GUI helper did not exit.' } } }`);
  } else {
    // Close only the GUI first; its independently running supervisor still
    // needs to flush the graceful shutdown response.
    child.kill('SIGTERM');
    const deadline = Date.now() + 5000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  const deadline = Date.now() + 10000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
  if (child.exitCode === null && child.signalCode === null) throw new Error('The package-test GUI did not stop.');
}

async function forceOwnedSupervisor(status, root, dataDirectory) {
  if (!status?.pid || !status.executablePath) return;
  await ownedPath(root, status.executablePath);
  assertInside(join(dataDirectory, 'supervisor'), status.executablePath);
  if (process.platform === 'win32') {
    // Recheck path and start time immediately before a failure-only PID stop.
    await powershell(`$p = Get-Process -Id ${status.pid} -ErrorAction SilentlyContinue; if ($p) { if ($p.Path -ine ${psLiteral(status.executablePath)} -or [Math]::Abs(([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() - ${Number(status.startedAt)}) -gt 30000) { throw 'Supervisor process identity changed; refusing PID stop.' }; Stop-Process -InputObject $p -Force -ErrorAction Stop; $p.WaitForExit(10000) | Out-Null }`);
  } else {
    let executable; let arguments_;
    try { executable = await realpath(`/proc/${status.pid}/exe`); arguments_ = (await readFile(`/proc/${status.pid}/cmdline`)).toString().split('\0'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (executable !== status.executablePath || arguments_[arguments_.indexOf('--data-dir') + 1] !== dataDirectory) throw new Error('Supervisor process identity changed; refusing PID stop.');
    process.kill(status.pid, 'SIGKILL');
  }
}

async function stopSupervisor(address, status, root, dataDirectory, tolerateFailure = false) {
  if (!status) return;
  let gracefulError;
  try { if ((await rpc(address, 'shutdown_supervisor', {}, 5000))?.stopped !== true) throw new Error('Supervisor did not acknowledge shutdown.'); }
  catch (error) { gracefulError = error; }
  const deadline = Date.now() + 15000;
  while (alive(status.pid) && Date.now() < deadline) await delay(100);
  if (alive(status.pid)) {
    await forceOwnedSupervisor(status, root, dataDirectory);
    const forcedDeadline = Date.now() + 5000;
    while (alive(status.pid) && Date.now() < forcedDeadline) await delay(100);
    if (alive(status.pid)) throw new Error('The package-test supervisor could not be stopped.');
    if (!tolerateFailure) throw gracefulError ?? new Error('Packaged supervisor required forced shutdown.');
  }
  if (gracefulError && !tolerateFailure) throw gracefulError;
}

export async function upgradeStoreCheckpoint(address, { marker, seed }) {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if (!marker || !new RegExp(`^packageUpgradeSmoke:${uuid}$`).test(marker.key) || !new RegExp(`^${uuid}$`).test(marker.value) || typeof seed !== 'boolean') throw new Error('Invalid package-upgrade store marker.');
  if (seed) await rpc(address, 'store_set', { key: marker.key, value: marker.value });
  if (await rpc(address, 'store_get', { key: marker.key }) !== marker.value) throw new Error('The package-upgrade private store marker was not preserved.');
}

async function runInstalledPackage(root, label, packageDirectory, launcher, version, options = {}) {
  const { desktop, supervisor } = await findExecutables(root, packageDirectory);
  await ownedPath(root, launcher ?? desktop);
  const dataDirectory = options.dataDirectory ?? join(root, `${label}-data`);
  if (options.dataDirectory) {
    await ownedPath(root, dataDirectory);
    if (!(await lstat(dataDirectory)).isDirectory()) throw new Error('The reused package-test store is not a directory.');
  } else await mkdir(dataDirectory, { mode: 0o700 });
  const desktopHash = createHash('sha256').update(await readFile(desktop)).digest('hex');
  const environment = { ...process.env, STRATA_MANAGER_DATA_DIR: dataDirectory };
  delete environment.STRATA_MANAGER_SUPERVISOR;
  delete environment.TAURI_SIGNING_PRIVATE_KEY;
  delete environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  if (process.platform === 'linux') {
    for (const [key, name] of Object.entries({ XDG_DATA_HOME: 'xdg-data', XDG_CONFIG_HOME: 'xdg-config', XDG_CACHE_HOME: 'xdg-cache', XDG_RUNTIME_DIR: 'xdg-runtime' })) {
      const directory = join(root, `${label}-${name}`); await mkdir(directory, { mode: 0o700 }); environment[key] = directory;
    }
  }
  const address = await endpoint(dataDirectory);
  const gui = launchGui(launcher ?? desktop, environment, dirname(launcher ?? desktop));
  let background; let failure;
  try {
    const deadline = Date.now() + 45000;
    let lastError;
    while (Date.now() < deadline) {
      if (gui.error || gui.child.exitCode !== null || gui.child.signalCode !== null) throw gui.error ?? new Error(`Packaged GUI exited before startup: ${gui.stderr}`);
      try { const status = await rpc(address, 'hello'); background = await verifySupervisor(status, { root, dataDirectory, version, supervisor }); break; }
      catch (error) { lastError = error; await delay(200); }
    }
    if (!background) throw new Error(`Packaged GUI did not start a matching supervisor within 45 seconds: ${lastError?.message}; ${gui.stderr}`);
    await delay(2000);
    if (gui.error || gui.child.exitCode !== null || gui.child.signalCode !== null) throw new Error(`Packaged GUI did not remain running: ${gui.stderr}`);
    // A blank private store must stay empty; this smoke never prepares a model.
    const profiles = await rpc(address, 'local_installations');
    if (!Array.isArray(profiles) || profiles.length) throw new Error('Package-test store contains unexpected model registrations.');
    if (options.upgradeCheckpoint) await upgradeStoreCheckpoint(address, options.upgradeCheckpoint);
    console.log(`${label}: x64 desktop + sidecar; actual GUI launch; protocol ${protocolVersion}; version ${version}; packaged sidecar SHA256 ${background.executableHash}; private empty store verified.`);
  } catch (error) { failure = error; }
  finally {
    try { await closeGui(gui); } catch (error) { failure ??= error; }
    if (!background) {
      // Cleanup may recover a late start, but only after strict sandbox/hash checks.
      try { background = await verifySupervisor(await rpc(address, 'hello'), { root, dataDirectory, version, supervisor }); } catch { /* Never signal an unverified PID. */ }
    }
    try { await stopSupervisor(address, background, root, dataDirectory, Boolean(failure)); } catch (error) { failure ??= error; }
    if (process.platform === 'linux' && gui.child.pid) {
      // The detached group is exclusive to this launch. With the supervisor
      // already stopped, close any remaining WebKit helper processes.
      try { process.kill(-gui.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
    }
  }
  if (failure) throw failure;
  console.log(`${label}: test GUI closed; isolated supervisor acknowledged shutdown and exited. GPU, model inference, login startup and interactive UI flows are outside this smoke.`);
  return { desktopHash, supervisorHash: background.executableHash };
}

async function uninstallWindowsPackage(root, installDirectory, installed, command = boundedCommand, logger = console.log) {
  const uninstall = join(installDirectory, 'uninstall.exe');
  try {
    if ((await lstat(uninstall)).isFile()) {
      await ownedPath(root, uninstall);
      // _?= suppresses the asynchronous temporary copy and keeps uninstall synchronous.
      await command(uninstall, ['/S', `_?=${installDirectory}`], { cwd: root, timeout: 120000, verbatim: true });
      const files = await filesUnder(installDirectory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
      if (files.some(file => /^strata[ ._-]*manager\.exe$/i.test(basename(file)) || basename(file) === 'strata-supervisor.exe')) throw new Error('NSIS uninstall left packaged executables behind.');
      logger('windows-nsis: silent installation and silent uninstallation verified on the disposable runner.');
    } else if (installed) throw new Error('NSIS package did not install its uninstaller.');
  } catch (error) { if (error.code !== 'ENOENT' || installed) throw error; }
}

async function windowsSmoke(root, installer, version) {
  const installDirectory = join(root, 'windows-install');
  let installed = false;
  try {
    // NSIS requires /D last, with no quoting around the directory value.
    await boundedCommand(installer, ['/S', `/D=${installDirectory}`], { cwd: root, timeout: 180000, verbatim: true });
    installed = true;
    await runInstalledPackage(root, 'windows-nsis', installDirectory, undefined, version);
  } finally {
    await uninstallWindowsPackage(root, installDirectory, installed);
  }
}

// This checks offline NSIS installation, not Tauri updater check/download/install.
// The workflow must independently verify the source package signature before entry.
export async function windowsUpgradeSmoke(root, installer, version, upgradeFrom, {
  command = boundedCommand, runPackage = runInstalledPackage,
  environment = process.env, platform = process.platform, architecture = process.arch, logger = console.log,
} = {}) {
  validateRunner(environment, platform, architecture);
  validateUpgrade(upgradeFrom, version, platform);
  const actualRoot = await realpath(root); const parent = await realpath(environment.RUNNER_TEMP);
  if (dirname(actualRoot) !== parent || !basename(actualRoot).startsWith('strata-preview-smoke-') || (await lstat(root)).isSymbolicLink()) throw new Error('Upgrade smoke requires its owned disposable sandbox.');
  for (const [path, expectedVersion] of [[upgradeFrom.installer, upgradeFrom.version], [installer, version]]) {
    if (!isAbsolute(path) || !semver.test(expectedVersion)) throw new Error('Invalid upgrade package path or version.');
    selectPackages([path], expectedVersion, 'win32');
    const file = await lstat(path);
    if (!file.isFile() || !file.size || file.isSymbolicLink()) throw new Error('Upgrade installers must be nonempty regular files.');
    selectPackages([await realpath(path)], expectedVersion, 'win32');
  }
  const installDirectory = join(actualRoot, 'windows-install');
  const dataDirectory = join(actualRoot, 'windows-upgrade-data');
  await mkdir(dataDirectory, { mode: 0o700 });
  const marker = { key: `packageUpgradeSmoke:${randomUUID()}`, value: randomUUID() };
  let installed = false; let failure;
  try {
    // /D is intentionally last for both installers, including directories with spaces.
    await command(upgradeFrom.installer, ['/S', `/D=${installDirectory}`], { cwd: actualRoot, timeout: 180000, verbatim: true });
    installed = true;
    const before = await runPackage(actualRoot, 'windows-upgrade-before', installDirectory, undefined, upgradeFrom.version, { dataDirectory, upgradeCheckpoint: { marker, seed: true } });
    // runPackage only resolves after our GUI and verified supervisor have exited.
    await command(installer, ['/S', `/D=${installDirectory}`], { cwd: actualRoot, timeout: 180000, verbatim: true });
    const after = await runPackage(actualRoot, 'windows-upgrade-after', installDirectory, undefined, version, { dataDirectory, upgradeCheckpoint: { marker, seed: false } });
    for (const key of ['desktopHash', 'supervisorHash']) {
      if (!/^[0-9a-f]{64}$/.test(before?.[key]) || !/^[0-9a-f]{64}$/.test(after?.[key]) || before[key] === after[key]) throw new Error(`Same-directory upgrade did not replace ${key}.`);
    }
  } catch (error) { failure = error; }
  finally {
    try { await uninstallWindowsPackage(actualRoot, installDirectory, installed, command, logger); }
    catch (error) { failure = failure ? new AggregateError([failure, error], `${failure.message}; upgrade cleanup failed: ${error.message}`) : error; }
  }
  if (failure) throw failure;
  logger(`windows-nsis-upgrade: ${upgradeFrom.version} -> ${version}; same install directory and private store; changed desktop/sidecar bytes; retained KV; both verified backgrounds exited; uninstall verified. This is not Tauri updater end-to-end acceptance.`);
}

async function linuxSmoke(root, packages, version) {
  const [appimage, deb] = packages;
  const imageDirectory = join(root, 'appimage-extract');
  await mkdir(imageDirectory);
  const image = join(imageDirectory, basename(appimage));
  await copyFile(appimage, image);
  const imageFile = await open(image, 'r+'); await imageFile.chmod(0o700); await imageFile.close();
  await boundedCommand(image, ['--appimage-extract'], { cwd: imageDirectory, timeout: 120000 });
  const extracted = join(imageDirectory, 'squashfs-root');
  await runInstalledPackage(root, 'linux-appimage', extracted, join(extracted, 'AppRun'), version);
  const debDirectory = join(root, 'deb-extract');
  await mkdir(debDirectory);
  const metadata = await boundedCommand('dpkg-deb', ['--field', deb, 'Version', 'Architecture']);
  const fields = Object.fromEntries(metadata.split(/\r?\n/).map(line => { const index = line.indexOf(':'); return [line.slice(0, index), line.slice(index + 1).trim()]; }));
  if (fields.Version !== version || fields.Architecture !== 'amd64') throw new Error('DEB control metadata does not match the expected preview version and architecture.');
  await boundedCommand('dpkg-deb', ['--extract', deb, debDirectory], { timeout: 120000 });
  await runInstalledPackage(root, 'linux-deb', debDirectory, undefined, version);
  console.log('linux-deb: control version/amd64, filesystem extraction and packaged GUI/IPC startup verified. System dpkg installation is outside this smoke.');
}

async function cleanSandbox(root, parent) {
  const actual = await realpath(root);
  if (dirname(actual) !== parent || !basename(actual).startsWith('strata-preview-smoke-') || (await lstat(actual)).isSymbolicLink()) throw new Error('Refusing unexpected package-test cleanup directory.');
  await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
}

export function validateRunner(environment, platform, architecture) {
  if (architecture !== 'x64' || !['win32', 'linux'].includes(platform)) throw new Error('Use a native Windows x64 or Linux x64 runner.');
  if (environment.GITHUB_ACTIONS !== 'true' || !environment.RUNNER_TEMP || !isAbsolute(environment.RUNNER_TEMP)) throw new Error('Installation smoke is restricted to disposable GitHub Actions runners.');
  if (platform === 'linux' && (!environment.DISPLAY || !environment.DBUS_SESSION_BUS_ADDRESS)) throw new Error('Run Linux smoke inside dbus-run-session and xvfb-run.');
}

export async function main(arguments_ = process.argv.slice(2)) {
  const { bundleDirectory, version, upgradeFrom } = parseArguments(arguments_);
  validateRunner(process.env, process.platform, process.arch);
  const packages = selectPackages(await filesUnder(await realpath(bundleDirectory)), version, process.platform);
  for (const package_ of packages) if (!(await stat(package_)).size) throw new Error('A preview package is empty.');
  const parent = await realpath(process.env.RUNNER_TEMP || tmpdir());
  const root = await mkdtemp(join(parent, 'strata-preview-smoke-'));
  console.log(`Preview package smoke: ${process.platform} x64 ${version}; disposable sandbox ${root}`);
  try {
    if (upgradeFrom) await windowsUpgradeSmoke(root, packages[0], version, upgradeFrom);
    else if (process.platform === 'win32') await windowsSmoke(root, packages[0], version);
    else await linuxSmoke(root, packages, version);
  } finally { await cleanSandbox(root, parent); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Preview package smoke failed: ${error.stack || error}`); process.exitCode = 1; });
}
