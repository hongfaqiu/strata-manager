import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const install = read('./InstallRuntimePage.tsx');
const panel = read('./RuntimeManagementPanel.tsx');
const dialog = read('./RuntimeUpdateDialog.tsx');
const shared = read('./LocalRuntimePackage.tsx');
const guide = read('../onboarding/OnboardingPage.tsx');
const app = read('../App.tsx');

test('#74: the Strata page offers local packages when no runtime is installed', () => {
  assert.match(install, /\{!running && <LocalRuntimePackageFields packages=\{packages\}/);
  assert.match(install, /core\.prepareLocalRuntime\(local\.chosen\)/, 'same IPC and arguments as the guide');
  assert.match(install, /disabled=\{props\.operationDisabled \|\| !loaded \|\| busy \|\| packages\.missing\}/);
  assert.match(install, /startLocal: '使用本地安装包安装'/);
  assert.match(install, /startLocal: 'Install from local package'/);
  assert.match(app, /<InstallRuntimePage [^>]*os=\{environment\.data\?\.os\}/);
});

test('#74: a runtime that needs repair can be prepared from local packages', () => {
  assert.match(install, /detected\.readiness === 'repair' && !running && <LocalRuntimePackageFields/);
  assert.match(install, /onClick=\{\(\) => void start\(true\)\}/);
});

test('#74: an installed engine can be updated or reinstalled from a local ZIP', () => {
  assert.match(panel, /\{installed && <button type="button" data-testid="runtime-local-package"/);
  assert.match(panel, /localPackage: '使用本地安装包'/);
  assert.match(panel, /localPackage: 'Install from local package'/);
  assert.match(panel, /setPending\(\{ runtime, release: info, local: true \}\)/);
  assert.match(panel, /mode: 'local'/);
  assert.match(panel, /localEntry=\{!!pending\.local\}/);
  assert.match(dialog, /localEntry \? 'local' :/);
  assert.match(dialog, /savedSourceNeedsSelection = !localEntry &&/);
  assert.match(panel, /core\.updateRuntimeZip\(runtime\.installDir, selectedAssetName, true, pending\.target \? \{ \.\.\.download, targetVersion: pending\.target \} : download\)/, 'the existing verified update path installs the ZIP');
});

test('the guide and the Strata page share one local-package flow', () => {
  assert.match(guide, /useLocalRuntimePackages\(packagePlatform,/);
  assert.match(install, /useLocalRuntimePackages\(core\.runtimePackagePlatform\(props\.os\)/);
  assert.match(shared, /core\.localRuntimePackageSelection\(source, archives, platform\)/);
  assert.match(shared, /filters: macEngine/);
  assert.match(shared, /name: 'TAR\.GZ'/);
  assert.match(shared, /name: 'ZIP'/);
  for (const key of ['obPackageSource', 'obSourceDownload', 'obSourceLocal', 'obLocalHintWindows', 'obLocalHintLinux', 'obLocalHintMac', 'obLocalStrata', 'obLocalEngine', 'obLocalRequired']) assert.match(shared, new RegExp(`'${key}'`));
});
