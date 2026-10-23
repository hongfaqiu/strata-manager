// The pure version helpers from the core package, for tests that stub the rest of core.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const load = (file, require = () => ({})) => {
  const source = readFileSync(new URL(`../../../packages/core/src/${file}`, import.meta.url), 'utf8');
  const loaded = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module: loaded, exports: loaded.exports, require });
  return loaded.exports;
};
const versions = load('runtime-versions.ts');
// The installed-version helpers (「已安装版本」) build on the version helpers.
const installed = load('installed-runtimes.ts', name => name === './runtime-versions' ? versions : {});

export const runtimeVersions = { ...versions, ...installed };
