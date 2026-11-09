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
const core = {
  normalizeGpuSelection: value => value.split(',').map(part => part.trim()).filter(Boolean).join(','),
  gpuRoles: { parseRolesText: () => null, rolesText: () => '' },
};
const selector = load('./GpuSelector.tsx', { '@strata-manager/core': core });
const { autoIntelOnlyNeedsSycl } = load('./SetupAdvancedOptions.tsx', { './GpuSelector': selector, '@strata-manager/core': core });

const intel = [{ id: 0, name: 'Intel(R) Arc(TM) A770 Graphics' }];
const intelWithIgpu = [
  { id: 0, name: 'Intel(R) Arc(TM) A750 Graphics' },
  { id: 1, name: 'Intel(R) UHD Graphics 770' },
];
const mixed = [
  { id: 0, name: 'Intel(R) Arc(TM) A770 Graphics' },
  { id: 1, name: 'NVIDIA GeForce RTX 4090' },
];

test('automatic backend shows the Intel SYCL hint only for pure-Intel GPU lists (W8A)', () => {
  assert.equal(autoIntelOnlyNeedsSycl({ backend: 'auto', gpus: '' }, intel), true);
  assert.equal(autoIntelOnlyNeedsSycl({ gpus: '0,1' }, intelWithIgpu), true);
  assert.equal(autoIntelOnlyNeedsSycl({ backend: 'sycl', gpus: '' }, intel), false, 'explicit SYCL needs no hint');
  assert.equal(autoIntelOnlyNeedsSycl({ backend: 'cuda', gpus: '' }, intel), false);
  assert.equal(autoIntelOnlyNeedsSycl({ backend: 'auto', gpus: '' }, mixed), false, 'mixed NVIDIA must not auto-sycl');
  assert.equal(autoIntelOnlyNeedsSycl({ backend: 'auto', gpus: '' }, [{ id: 0, name: 'AMD Radeon RX 7900 XTX' }]), false);
  assert.equal(autoIntelOnlyNeedsSycl({ backend: 'auto', gpus: '' }, undefined), false);
  assert.equal(autoIntelOnlyNeedsSycl({ backend: 'auto', gpus: '0' }, []), false);
});
