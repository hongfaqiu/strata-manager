import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { MODEL_CATALOG } from '../../../../packages/core/src/catalog.ts';
import { isOrcaRouterEvidence } from '../../../../packages/core/src/orca-import.ts';

const load = (file, modules) => {
  const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => modules[name] ?? {} });
  return module.exports;
};
const estimates = load('./d2Estimates.ts', { '@strata-manager/core': { MODEL_CATALOG, isOrcaRouterEvidence } });
const live = load('./catalogLive.ts', { './d2Estimates': estimates, react: {} });
const swift = MODEL_CATALOG.find(model => model.family === 'swift');

test('identifies catalog quantization from a model or config label', () => {
  const requirement = estimates.catalogRequirement('Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S swift-iq3_s.json');
  assert.equal(requirement.family, 'swift');
  assert.equal(requirement.quant, 'IQ3_S');
  assert.equal(requirement.ramGB, 62);
  assert.equal(estimates.catalogRequirement('Swift IQ3_XXS').quant, 'IQ3_XXS');
  assert.equal(estimates.catalogRequirement('my-custom-model.gguf'), undefined, 'unknown models stay 未实测');
  assert.equal(estimates.catalogRequirement('orcarouter-qwen3.8-flash-next-uncensored-iq3_xxs strata-orca-iq3_xxs.json'), undefined, 'OrcaRouter IQ3_XXS is not the official Qwen IQ3_XXS row');
});

test('fit uses total memory and is unknown without it', () => {
  assert.equal(estimates.fitState(48, 96), 'fits');
  assert.equal(estimates.fitState(62, 64), 'tight');
  assert.equal(estimates.fitState(62, 32), 'over');
  assert.equal(estimates.fitState(62, undefined), undefined);
});

test('fit softens to tight when GPU offload covers the peak RAM shortfall', () => {
  // 31 GB RAM + 24 GB VRAM: peak 48 is over RAM alone but within RAM+(VRAM-5)
  assert.equal(estimates.fitState(48, 31, 24), 'tight');
  assert.equal(estimates.fitState(48, 31), 'over');
  assert.equal(estimates.fitState(48, 31, 8), 'over', 'tiny VRAM still over');
  assert.equal(estimates.environmentVramGB(['NVIDIA GeForce RTX 4090, 560.94, 24564 MiB']), 24);
  assert.equal(estimates.environmentVramGB(['Intel UHD']), undefined);
  assert.equal(estimates.usableMemoryGB(31, 24), 31 + 19);
});

test('parses download progress from task messages', () => {
  assert.equal(estimates.taskProgress('Downloading 42%'), 42);
  assert.equal(Math.round(estimates.taskProgress('Swift 1.5 IQ3_XXS 下载中 31.2 / 75.8 GB')), 41);
  assert.equal(estimates.taskProgress('Preparing files'), undefined);
});

test('row status follows live tasks and local models', () => {
  const running = [{ id: 'a', kind: 'setup-model', state: 'running', message: 'Swift 1.5 IQ3_XXS 下载中 37.9 / 75.8 GB', startedAt: 1 }];
  const row = live.rowLive(swift, running, [], 96);
  assert.equal(row.downloading, true);
  assert.equal(Math.round(row.progress), 50);
  assert.equal(row.fit, 'fits');
  const quant = live.quantLive(swift, 'IQ3_S', [], [{ name: 'Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S', configPath: 'x', modelPath: 'D:/m/swift-iq3_s', sizeBytes: 1 }], 96);
  assert.equal(quant.local, true);
  const failed = live.quantLive(swift, 'IQ2_XS', [{ id: 'b', kind: 'setup-model', state: 'failed', message: 'swift IQ2_XS failed', startedAt: 1 }], [], undefined);
  assert.equal(failed.failed, true);
  assert.equal(failed.fit, undefined, 'without memory the fit is 未实测');
});

test('DeepSeek-V4.1-Flash: the card never suggests the manual-only 2.25 bpw set', () => {
  const deepseek = MODEL_CATALOG.find(model => model.family === 'deepseek41');
  const roomy = live.rowLive(deepseek, [], [], 256);
  assert.equal(roomy.fit, 'fits');
  assert.equal(roomy.bestQuant, 'IST-DAS-2.00bpw');
  assert.equal(live.rowLive(deepseek, [], [], 36).bestQuant, 'IST-DAS-1.75bpw');
  assert.equal(estimates.catalogRequirement('deepseek-v4.1-flash strata-deepseek-v4.1-flash-ist-das-2.00bpw.json'), undefined, 'a DeepSeek config is never read as another family');
});
