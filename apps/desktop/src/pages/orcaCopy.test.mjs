import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compile = url => ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(compile(new URL('./orcaCopy.ts', import.meta.url)), { module, exports: module.exports });
const { orcaCopy } = module.exports;
const languages = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'ru'];

test('OrcaRouter import copy covers all 10 languages with the same keys', () => {
  assert.deepEqual(Object.keys(orcaCopy).sort(), [...languages].sort());
  const keys = Object.keys(orcaCopy.en).sort();
  for (const language of languages) {
    const copy = orcaCopy[language];
    assert.deepEqual(Object.keys(copy).sort(), keys, language);
    for (const key of keys) {
      const value = copy[key];
      const text = typeof value === 'function' ? value('12.34', '56.7') : value;
      assert.equal(typeof text, 'string', `${language}/${key}`);
      assert.ok(text.trim(), `${language}/${key} empty`);
      if (typeof value === 'function') assert.ok(text.includes('12.34') || text.includes('12'), `${language}/${key} drops its value`);
    }
    // ORCA.md figures and the refusal reason stay intact in every language
    assert.match(copy.intro, /IQ3_XXS/);
    assert.match(copy.intro, /85[.,]20/);
    assert.match(copy.ramText('128', '100'), /49[.,]8/);
    assert.match(copy.iq3m, /Q5_0/);
    assert.match(copy.packTodo, /--compat-bf16/);
  }
  assert.equal(orcaCopy['zh-CN'].badge, '社区兼容 · 非官方菜单 · 仅文本');
  assert.equal(orcaCopy['zh-CN'].title, '导入 OrcaRouter 去审查模型');
});
