/** Build the independent supervisor and stage Tauri's target-suffixed sidecar. */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let profile = 'release';
let target;
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (flag === '--profile' && ['debug', 'release'].includes(value)) profile = value;
  else if (flag === '--target' && value && /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(value)) target = value;
  else throw new Error(`Invalid argument: ${flag}. Use --profile debug|release and optionally --target <Rust triple>.`);
  index += 1;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status ?? result.signal}).`);
  return result;
}

if (!target) {
  const { stdout } = run('rustc', ['-vV'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  target = /^host:\s*(\S+)$/m.exec(stdout)?.[1];
  if (!target) throw new Error('Unable to identify the Rust host target.');
}

const targetDir = join(root, 'apps', 'desktop', 'src-tauri', 'target');
const args = ['build', '--locked', '--manifest-path', join(root, 'Cargo.toml'), '-p', 'strata-supervisor', '--target-dir', targetDir, '--target', target];
if (profile === 'release') args.push('--release');
run('cargo', args);
const extension = target.includes('-windows-') ? '.exe' : '';
const binary = join(targetDir, target, profile, `strata-supervisor${extension}`);
if (!(await stat(binary)).isFile()) throw new Error(`Supervisor executable is missing: ${binary}`);
const distribution = join(root, 'apps', 'desktop', 'src-tauri', 'binaries');
await mkdir(distribution, { recursive: true });
const staged = join(distribution, `strata-supervisor-${target}${extension}`);
await copyFile(binary, staged);
console.log(`Supervisor staged for ${target} (${profile}): ${staged}`);
