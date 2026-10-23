// The pure version helpers from the core package, for tests that stub the rest of core.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../../packages/core/src/runtime-versions.ts', import.meta.url), 'utf8');
const versionsModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module: versionsModule, exports: versionsModule.exports, require: () => ({}) });

export const runtimeVersions = versionsModule.exports;
