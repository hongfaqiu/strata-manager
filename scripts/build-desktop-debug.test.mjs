import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildDesktopDebug, createBuildPlan } from './build-desktop-debug.mjs';

const host = 'x86_64-pc-windows-msvc';

test('the desktop and sidecar use the same explicit Rust target', () => {
  const root = resolve('fixture');
  const plan = createBuildPlan({ root, host, environment: { CARGO_BUILD_TARGET: 'aarch64-pc-windows-msvc', TAURI_CONFIG: '{"identifier":"io.strata.manager"}' } });
  assert.equal(plan.target, 'aarch64-pc-windows-msvc');
  assert.equal(plan.executable, join(root, 'apps/desktop/src-tauri/target/aarch64-pc-windows-msvc/debug/strata-manager.exe'));
  assert.equal(plan.supervisor, join(root, 'apps/desktop/src-tauri/binaries/strata-supervisor-aarch64-pc-windows-msvc.exe'));
  assert.equal(plan.environment.CARGO_BUILD_TARGET, plan.target);
  assert.equal(plan.environment.TAURI_CONFIG, undefined);
});

test('a custom Cargo target directory remains absolute across the different child working directories', () => {
  const root = resolve('fixture');
  const requested = join(root, 'custom cache');
  assert.equal(createBuildPlan({ root, host, environment: { CARGO_TARGET_DIR: requested } }).targetDir, requested);
  const plan = createBuildPlan({ root, host, environment: { CARGO_TARGET_DIR: '../custom cache' } });
  assert.equal(plan.targetDir, resolve(root, 'apps/desktop/src-tauri', '../custom cache'));
  assert.equal(plan.environment.CARGO_TARGET_DIR, plan.targetDir);
  assert.equal(plan.executable, join(plan.targetDir, 'debug/strata-manager.exe'));
});

test('the default target is the Rust host and the extension follows the target OS', () => {
  const root = resolve('fixture');
  const defaultPlan = createBuildPlan({ root, host, environment: {} });
  assert.equal(defaultPlan.target, host);
  assert.equal(defaultPlan.executable, join(defaultPlan.targetDir, 'debug/strata-manager.exe'));
  assert.equal(defaultPlan.environment.CARGO_BUILD_TARGET, undefined);
  const hostTuple = createBuildPlan({ root, host, environment: { CARGO_BUILD_TARGET: 'host-tuple' } });
  assert.equal(hostTuple.executable, join(hostTuple.targetDir, host, 'debug/strata-manager.exe'));
  const plan = createBuildPlan({ root, host, environment: { CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu' } });
  assert.equal(plan.executable, join(plan.targetDir, plan.target, 'debug/strata-manager'));
  assert.equal(plan.application, join(root, 'output/dev-desktop/StrataManager-dev'));
});

test('unsupported custom JSON or multi-target input fails before starting a build', () => {
  const root = resolve('fixture');
  for (const target of ['../custom-target.json', 'x86_64-pc-windows-msvc,aarch64-pc-windows-msvc', 'universal-apple-darwin']) {
    assert.throws(() => createBuildPlan({ root, host, environment: { CARGO_BUILD_TARGET: target } }), /single Rust target triple/);
  }
});

test('the build stages the requested target sidecar first and copies only its exact artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strata-debug-target-'));
  const target = 'aarch64-pc-windows-msvc';
  const targetDir = join(root, 'custom cache');
  const plan = createBuildPlan({ root, host, environment: { CARGO_BUILD_TARGET: target, CARGO_TARGET_DIR: targetDir } });
  const calls = [];
  try {
    await mkdir(join(targetDir, target, 'debug'), { recursive: true });
    await mkdir(join(root, 'apps/desktop/src-tauri/binaries'), { recursive: true });
    await writeFile(plan.executable, 'requested-target-app');
    await writeFile(plan.supervisor, 'requested-target-sidecar');
    await writeFile(join(root, 'apps/desktop/src-tauri/binaries', `strata-supervisor-${host}.exe`), 'stale-host-sidecar');
    const result = await buildDesktopDebug({
      root,
      environment: plan.environment,
      tauriCli: join(root, 'fake-tauri.js'),
      spawn(command, args, options) {
        calls.push({ command, args, options });
        return command === 'rustc' ? { status: 0, stdout: `host: ${host}\n` } : { status: 0 };
      },
      log() {},
    });
    assert.deepEqual(calls[1].args, [join(root, 'scripts/prepare-sidecar.mjs'), '--profile', 'debug', '--target', target]);
    assert.ok(calls[2].args.includes('--no-bundle'));
    assert.ok(calls[2].args.includes('--no-sign'));
    assert.deepEqual(calls[2].args.slice(calls[2].args.indexOf('--target'), calls[2].args.indexOf('--target') + 2), ['--target', target]);
    assert.equal(calls[2].options.env.CARGO_TARGET_DIR, targetDir);
    assert.equal(await readFile(result.application, 'utf8'), 'requested-target-app');
    assert.equal(await readFile(join(root, 'output/dev-desktop/strata-supervisor.exe'), 'utf8'), 'requested-target-sidecar');
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed sidecar build does not run Tauri or reuse a staged binary', async () => {
  const root = resolve('fixture');
  const calls = [];
  await assert.rejects(buildDesktopDebug({ root, tauriCli: 'fake-tauri.js', environment: {}, log() {}, spawn(command, args) {
    calls.push(args);
    return command === 'rustc' ? { status: 0, stdout: `host: ${host}\n` } : { status: 7 };
  } }), /exit 7/);
  assert.equal(calls.length, 2);
});

test('an implicit host build retains Cargo host cache without adding --target', async () => {
  const calls = [];
  await assert.rejects(buildDesktopDebug({ root: resolve('fixture'), tauriCli: 'fake-tauri.js', environment: {}, log() {}, spawn(command, args, options) {
    calls.push({ args, options });
    if (command === 'rustc') return { status: 0, stdout: `host: ${host}\n` };
    return { status: calls.length === 3 ? 13 : 0 };
  } }), /exit 13/);
  assert.equal(calls.length, 3);
  assert.ok(!calls[2].args.includes('--target'));
  assert.equal(calls[2].options.env.CARGO_BUILD_TARGET, undefined);
});

test('the development config builds the frontend and declares the separate unbundled identity', async () => {
  const config = JSON.parse(await readFile(new URL('../apps/desktop/src-tauri/tauri.dev.conf.json', import.meta.url), 'utf8'));
  assert.equal(config.identifier, 'io.strata.manager.dev');
  assert.equal(config.productName, 'Strata Manager Dev');
  assert.equal(config.build.beforeBuildCommand, 'pnpm -w build');
  assert.equal(config.bundle.active, false);
  assert.equal(config.bundle.createUpdaterArtifacts, false);
});
