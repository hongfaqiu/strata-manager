import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compile = url => ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(compile(new URL('./configLookup.ts', import.meta.url)), { module, exports: module.exports });
const { configDirectory } = module.exports;
const configLookupDirectories = (...args) => [...module.exports.configLookupDirectories(...args)];
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

test('导入配置: an upstream config outside the current runtime is looked up in its own folder first', () => {
  const config = 'C:\\Users\\me\\AppData\\Local\\Strata\\install\\strata-ud-q4_k_xl.json';
  const runtime = 'C:\\Users\\me\\AppData\\Roaming\\io.strata.manager\\runtimes\\release-0.2.38';
  assert.deepEqual(configLookupDirectories(config, runtime), ['C:\\Users\\me\\AppData\\Local\\Strata\\install', runtime]);
});

test('a config inside the runtime is scanned once, and a POSIX path works without a runtime', () => {
  assert.deepEqual(configLookupDirectories('D:/AI/Strata/strata-q4.json', 'd:\\ai\\strata\\'), ['D:/AI/Strata']);
  assert.deepEqual(configLookupDirectories('/home/me/strata-data/strata-q2.json'), ['/home/me/strata-data']);
  assert.equal(configDirectory('C:\\x/y\\strata-a.json'), 'C:\\x/y');
});

test('openConfigProfile no longer replaces the config folder with the runtime folder', () => {
  assert.doesNotMatch(app, /previous\?\.installDir \|\| configPath\.slice/);
  assert.match(app, /core\.discoverLocal\(configLookupDirectories\(configPath, previous\?\.installDir\)\)/);
});
