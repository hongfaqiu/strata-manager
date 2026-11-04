import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const page = read('./ModelDownloadPage.tsx');
const card = read('./DownloadedModelsCard.tsx');
const helpers = read('./downloadedModels.ts');
const live = read('./catalogLive.ts');
const panel = read('./ExistingModelPanel.tsx');
const manager = read('./ServiceManagerPage.tsx');
const app = read('../App.tsx');
const bridge = read('../../../../packages/core/src/bridge.ts');
const tauri = read('../../src-tauri/src/lib.rs');
const ipc = read('../../../../crates/runtime-core/src/lib.rs');

test('downloaded models: a read-only native scan reaches the page', () => {
  assert.match(bridge, /findDownloadedModels = \(directories: string\[\] = \[\]\)[^\n]*native\('find_downloaded_models', \{ directories \}\)/);
  assert.match(tauri, /async fn find_downloaded_models\(/);
  assert.match(tauri, /check_mtp_path,\s+find_downloaded_models,/);
  assert.match(ipc, /"find_downloaded_models" => \{[\s\S]*?local_model::find_downloaded\(\s*&discovery::downloaded_model_roots\(&directories\)/);
  assert.match(helpers, /queryKey: \['downloaded-models'/);
});

test('「发现 N 个已下载模型 · 一键加入」 opens 使用已有模型 with the folder prefilled', () => {
  assert.match(card, /found: \(n: number\) => `发现 \$\{n\} 个已下载模型`, addAll: '一键加入'/);
  assert.match(card, /found: \(n: number\) => `Found \$\{n\} downloaded model/);
  assert.match(card, /onClick=\{\(\) => onUse\(models\[0\]!\)\}/);
  assert.match(page, /<DownloadedModelsCard language=\{language\} models=\{unused\}/);
  assert.match(page, /setPrefill\(\{ directory: model\.directory, groupId: model\.group\.id, key: Date\.now\(\) \}\)/);
  assert.match(page, /initialPath=\{prefill\?\.directory\} initialGroupId=\{prefill\?\.groupId\}/);
  assert.match(panel, /useState\(initialPath \?\? ''\)/);
  assert.match(panel, /useState\(initialGroupId \?\? ''\)/);
  assert.match(manager, /<DownloadedModelsCard language=\{language\} models=\{downloaded\.data \?\? \[\]\}/);
  assert.match(app, /onUseDownloaded=\{model => \{ setExistingRequest\(\{ directory: model\.directory, groupId: model\.group\.id, key: Date\.now\(\) \}\); go\('catalog'\); \}\}/);
  assert.match(helpers, /export function unusedDownloaded/);
});

test('使用已有模型 sits beside 在线下载 instead of in a collapsed section; nothing else is removed', () => {
  assert.doesNotMatch(page, /<details ref=\{localSection\}/);
  assert.match(page, /<ModelSourceChoice language=\{language\} value=\{source\}/);
  assert.match(card, /online: '在线下载'[^\n]*existing: '使用已有模型'/);
  assert.match(card, /online: 'Download online'[^\n]*existing: 'Use an existing model'/);
  assert.match(card, /role="tablist"/);
  assert.match(page, /data-testid="existing-model-shortcut" onClick=\{\(\) => useExisting\(\)\}/);
  // 导入配置, the compatibility check and the Orca import stay.
  assert.match(page, /text\('导入配置', 'Import configuration'\)/);
  assert.match(page, /<ModelInspectPanel /);
  assert.match(page, /data-testid="orca-import-section"/);
  assert.match(page, /text\('下载并准备', 'Download and prepare'\)/);
});

test('a catalog quant already on disk shows 本机已有 and 直接使用', () => {
  assert.match(card, /onDisk: '本机已有', useDirect: '直接使用'/);
  assert.match(card, /onDisk: 'On this computer', useDirect: 'Use directly'/);
  assert.match(live, /const onDisk = isLocal \? undefined : downloadedFor\(model, quant, downloaded\)/);
  assert.match(page, /rows\[model\.id\]\?\.onDisk \? <b className="is-ondisk" data-testid="catalog-on-disk">\{onboard\.onDisk\}<\/b>/);
  assert.match(page, /live\.onDisk \? onboard\.onDisk/);
  assert.match(page, /data-testid="use-downloaded-model"[^>]*onClick=\{\(\) => useExisting\(selectedOnDisk\)\}><HardDrive size=\{18\}\/>\{onboard\.useDirect\}/);
});
