import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const panel = read('./ExistingModelPanel.tsx');
const copy = read('./existingModelCopy.ts');
const page = read('./ModelDownloadPage.tsx');
const guide = read('../onboarding/OnboardingPage.tsx');
const strings = read('../onboarding/OnboardingStrings.ts');
const app = read('../App.tsx');
const tauri = read('../../src-tauri/src/lib.rs');

test('#75: the wizard model step offers 使用已有模型 next to downloading', () => {
  assert.match(guide, /options=\{\[\{ value: 'catalog', label: t\('obSourceCatalog'\) \}, \{ value: 'existing', label: t\('obSourceExisting'\) \}\]\}/);
  assert.match(guide, /<ExistingModelPanel compact /);
  assert.match(guide, /onSetup=\{request => props\.onPrepareModel\(request\)\}/, 'same setup task as downloading, with localModel');
  assert.match(strings, /obSourceExisting: \["使用已有模型", "Use an existing model"/);
  assert.match(app, /onChooseDirectory=\{\(\) => choose\(true\)\} onChooseFile=\{\(\) => choose\(false\)\}\r?\n/);
});

test('#75: the Models page has the same flow after the wizard, with a visible shortcut', () => {
  assert.match(page, /data-testid="existing-model-shortcut"/);
  assert.match(page, /<ExistingModelPanel language=\{language\}/);
  assert.match(page, /onSetup=\{onLocalSetup\} onOrcaImport=\{onOrcaImport\}/);
  assert.match(app, /onLocalSetup=\{request => act\('setup', \(\) => runRecipe\(\{ kind: 'setup', \.\.\.request \}\)/);
});

test('#75: a detected but unregistered runtime no longer leaves the Models page disabled', () => {
  assert.match(page, /\[runtimeOverride, saved\.runtime, fallbackRuntime, detectedReady\]/);
  assert.match(page, /item\.readiness === 'ready'/);
  assert.match(app, /\['models', 'profiles', 'config', 'catalog'\]\.includes\(page\)/);
  assert.match(app, /detectedRuntimes=\{detectedRuntimes \?\? \[\]\}/);
});

test('#75: localModel reaches run_setup and the disk preflight; scans are read-only commands', () => {
  assert.match(app, /core\.runSetup\(recipe\.profile, recipe\.model, recipe\.quant, recipe\.context, recipe\.images, recipe\.options, recipe\.localModel\)/);
  assert.match(panel, /core\.setupDiskPreflight\(setup\.profile, setup\.model, setup\.quant, setup\.images, setup\.localModel\)/, 'revalidated right before submitting');
  assert.match(tauri, /"localModel":local_model/);
  assert.match(tauri, /scan_local_models,\s+check_mtp_path,/);
});

test('#75: validation and MTP mapping are explained in Chinese and English', () => {
  assert.match(copy, /上游 setup\.py 没有 --mtp 安装参数/);
  assert.match(copy, /Upstream setup\.py has no --mtp setup flag/);
  assert.match(copy, /unsupported: '引擎不支持'/);
  assert.match(copy, /renamed: '文件名不同'/);
  assert.match(panel, /disabled=\{disabled \|\| !runtime\?\.installDir \|\| !ready/);
});

test('#4926: using existing files keeps image support instead of setting it off', () => {
  assert.doesNotMatch(panel, /images: false/);
  assert.match(panel, /core\.localModelImages\(group\?\.family, previous\.isSuccess \? previous\.data : null\)/);
  assert.match(panel, /queryFn: \(\) => core\.readConfig\(runtime!\)/);
  assert.match(panel, /<Toggle ariaLabel=\{t\.images\} checked=\{images\}/);
  assert.match(copy, /images: '图像支持', imagesKept: '沿用当前配置'/);
  assert.match(copy, /images: 'Image support', imagesKept: 'Kept from the current configuration'/);
});

test('upstream #5052: a renamed copy says it is installed apart, in Chinese and English', () => {
  assert.match(panel, /core\.localModelInstalledApart\(group\) && <p className="existing-model-ok" data-testid="existing-model-apart">/);
  assert.match(panel, /apart \? disk\.data\?\.dataDirectory : undefined/, 'the command shows the own --data-dir from the disk check');
  assert.match(copy, /renamedApart: '单独打包并登记为新配置，不复用、不覆盖已装的同量化模型。'/);
  assert.match(copy, /renamedApart: 'Packed and registered as its own configuration; an installed model of the same size is neither reused nor replaced\.'/);
  assert.match(copy, /mtpLinked: '将链接到此模型自己的数据目录'/);
});

test('not recognized: the empty state points to the model folder (Documents\\Strata\\Models), not setup.py', () => {
  const manager = read('./ServiceManagerPage.tsx');
  const zh = manager.match(/noServicesDataHelp: '([^']*)'/g);
  assert.equal(zh.length, 2);
  for (const line of zh) assert.doesNotMatch(line, /setup\.py/);
  assert.match(zh[0], /已下载的模型不用删/);
  assert.match(zh[0], /使用已有模型/);
  assert.match(zh[0], /文档\\\\Strata\\\\Models/);
  assert.match(zh[1], /do not need to be deleted/);
  assert.match(zh[1], /Use an existing model/);
  assert.match(zh[1], /Documents\\\\Strata\\\\Models/);
  assert.match(manager, /noServicesHelp: '[^']*已下载的模型不用删[^']*'/);
  assert.match(manager, /noServicesHelp: '[^']*do not need to be deleted[^']*'/);
  const i18n = read('../i18n.ts');
  assert.match(i18n, /localSetupNothingFoundHint: '[^']*已下载的模型不用删[^']*'/);
  assert.match(i18n, /localSetupNothingFoundHint: '[^']*do not need to be deleted[^']*'/);
});

test('the delete-model confirmation says a downloaded model can be used from its folder instead', () => {
  const dialog = read('./ModelDeletionDialog.tsx');
  assert.match(dialog, /keepHint: '只是没识别出来？已下载的模型不用删[^']*使用已有模型[^']*'/);
  assert.match(dialog, /keepHint: 'Just not recognized\? Downloaded models do not need to be deleted[^']*Use an existing model[^']*'/);
  assert.match(dialog, /data-testid="model-deletion-keep-hint">\{w\.keepHint\}/);
});

test('N4A: a package without strata-vision does not offer image input, with a short text-only note', () => {
  assert.match(panel, /core\.engineAllowsImageInput\(modelImages, hasVisionReader\)/);
  assert.match(panel, /core\.engineVisionTextOnly\(language\)/);
  assert.match(page, /core\.engineAllowsImageInput\(!!entry\?\.images, hasVisionReader\)/);
  assert.match(page, /data-testid="model-download-no-vision"/);
  assert.match(guide, /core\.engineAllowsImageInput\(/);
  assert.match(guide, /data-testid="ob-no-vision"/);
  const dialog = read('./VisionSupportDialog.tsx');
  assert.match(dialog, /data-testid="vision-no-reader"/);
  assert.match(dialog, /core\.engineVisionTextOnly\(language\)/);
  assert.match(dialog, /core\.engineAllowsImageInput\(true, hasReader, \{ deepseek: deepseekVision !== null \}\)/);
});

