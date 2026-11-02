import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const load = (file, modules) => {
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, require: name => modules[name] ?? {} });
  return module.exports;
};
const core = { normalizeGpuSelection: value => value.split(',').map(part => part.trim()).filter(Boolean).join(',') };
const selector = load('./GpuSelector.tsx', { '@strata-manager/core': core });
const { autoAmdMultiGpuOnWindows } = load('./SetupAdvancedOptions.tsx', { './GpuSelector': selector, '@strata-manager/core': core });

const amd = [{ id: 0, name: 'AMD Radeon RX 7900 XTX (24 GB)' }, { id: 1, name: 'AMD Radeon RX 7900 XTX (24 GB)' }];

test('automatic backend warns about the Windows AMD single-card limit only for several AMD cards', () => {
  assert.equal(autoAmdMultiGpuOnWindows({ gpus: '0,1' }, amd, true), true);
  assert.equal(autoAmdMultiGpuOnWindows({ backend: 'auto', gpus: 'all' }, amd, true), true);
  assert.equal(autoAmdMultiGpuOnWindows({ gpus: '0' }, amd, true), false);
  assert.equal(autoAmdMultiGpuOnWindows({ gpus: '' }, amd, true), false);
  assert.equal(autoAmdMultiGpuOnWindows({ gpus: '0,1' }, amd, false), false, 'Linux HIP runs several cards');
  assert.equal(autoAmdMultiGpuOnWindows({ backend: 'cuda', gpus: '0,1' }, amd, true), false);
  assert.equal(autoAmdMultiGpuOnWindows({ gpus: '0,1' }, [{ id: 0, name: 'NVIDIA GeForce RTX 4090 (24 GB)' }, { id: 1, name: 'AMD Radeon(TM) Graphics' }], true), false);
});
