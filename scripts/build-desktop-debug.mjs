/** Embed the frontend in a separate development app; raw cargo debug expects Vite. */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function createBuildPlan({ root = repositoryRoot, host, environment = process.env }) {
  const requested = environment.CARGO_BUILD_TARGET?.trim();
  const explicitTarget = Boolean(requested);
  const target = !requested || requested === 'host-tuple' ? host : requested;
  // Tauri and prepare-sidecar accept one platform triple, not custom JSON targets
  // or Tauri's special universal macOS target (which requires two sidecars).
  if (!target || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(target) || target.endsWith('.json') || target === 'universal-apple-darwin') {
    throw new Error('desktop:debug requires a single Rust target triple in CARGO_BUILD_TARGET.');
  }
  const nativeDirectory = join(root, 'apps/desktop/src-tauri');
  // Cargo resolves environment paths from its working directory (src-tauri).
  // Pin the absolute path before children run from different working directories.
  const requestedDirectory = environment.CARGO_TARGET_DIR || environment.CARGO_BUILD_TARGET_DIR;
  const targetDir = requestedDirectory ? resolve(nativeDirectory, requestedDirectory) : join(nativeDirectory, 'target');
  const buildEnvironment = { ...environment, CARGO_TARGET_DIR: targetDir };
  if (explicitTarget) buildEnvironment.CARGO_BUILD_TARGET = target;
  else delete buildEnvironment.CARGO_BUILD_TARGET;
  if (environment.CARGO_BUILD_TARGET_DIR) buildEnvironment.CARGO_BUILD_TARGET_DIR = targetDir;
  // A prior acceptance override must not replace the dedicated dev identity.
  delete buildEnvironment.TAURI_CONFIG;
  const suffix = target.includes('-windows-') ? '.exe' : '';
  const destination = join(root, 'output/dev-desktop');
  return {
    target,
    explicitTarget,
    targetDir,
    environment: buildEnvironment,
    executable: join(targetDir, ...(explicitTarget ? [target] : []), 'debug', `strata-manager${suffix}`),
    supervisor: join(nativeDirectory, 'binaries', `strata-supervisor-${target}${suffix}`),
    application: join(destination, `StrataManager-dev${suffix}`),
    destination,
    suffix,
  };
}

export async function buildDesktopDebug({ root = repositoryRoot, environment = process.env, spawn = spawnSync, tauriCli, log = console.log } = {}) {
  function run(command, args, options = {}) {
    const result = spawn(command, args, { cwd: root, env: environment, stdio: 'inherit', ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status ?? result.signal}).`);
    return result;
  }
  const rust = run('rustc', ['-vV'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const host = /^host:\s*(\S+)$/m.exec(rust.stdout)?.[1];
  if (!host) throw new Error('Rust host target is missing');
  const plan = createBuildPlan({ root, host, environment });
  if (!tauriCli) {
    const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
    const cliPackage = requireDesktop.resolve('@tauri-apps/cli/package.json');
    tauriCli = resolve(dirname(cliPackage), requireDesktop('@tauri-apps/cli/package.json').bin.tauri);
  }
  log(`Development target: ${plan.target}\nCargo artifacts: ${plan.targetDir}`);
  // Stage this exact target before Tauri builds; the dev config then builds only
  // the frontend so its hook cannot overwrite the sidecar with the host target.
  run(process.execPath, [join(root, 'scripts/prepare-sidecar.mjs'), '--profile', 'debug', '--target', plan.target], { env: plan.environment });
  run(process.execPath, [tauriCli, 'build', '--debug', '--no-bundle', '--no-sign', ...(plan.explicitTarget ? ['--target', plan.target] : []), '--config', join(root, 'apps/desktop/src-tauri/tauri.dev.conf.json')], {
    cwd: join(root, 'apps/desktop'),
    env: plan.environment,
  });
  for (const path of [plan.executable, plan.supervisor]) {
    if (!(await stat(path)).isFile()) throw new Error(`Missing development artifact: ${path}`);
  }
  await mkdir(plan.destination, { recursive: true });
  await copyFile(plan.executable, plan.application);
  await copyFile(plan.supervisor, join(plan.destination, `strata-supervisor${plan.suffix}`));
  log(`Standalone development files: ${plan.application}\nKeep strata-supervisor${plan.suffix} beside the application. The frontend is embedded.\nDefault app data uses io.strata.manager.dev; STRATA_MANAGER_DATA_DIR at launch overrides that isolation.\nThis build requests no installer or updater artifacts. Offline desktop-window acceptance remains separate.`);
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDesktopDebug();
}
