import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

test('all interface packs contain every key and preserve interpolation markers', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({configFile:false,root,server:{middlewareMode:true},clearScreen:false});
  try {
    const {en, languageResources} = await server.ssrLoadModule('/src/i18n.ts');
    const expected = Object.keys(en).sort();
    assert.equal(Object.keys(languageResources).length,10);
    const markers = value => (value.match(/\{\{[^}]+\}\}/g) ?? []).sort();
    for (const [locale,{translation}] of Object.entries(languageResources)) {
      assert.deepEqual(Object.keys(translation).sort(),expected,locale+' key coverage');
      for (const key of expected) {
        assert.equal(typeof translation[key],'string',locale+'/'+key);
        assert.ok(translation[key].trim(),locale+'/'+key+' empty');
        assert.ok(!translation[key].includes('\uFFFD'),locale+'/'+key+' malformed Unicode');
        assert.deepEqual(markers(translation[key]),markers(en[key]),locale+'/'+key+' interpolation');
      }
      if (!['en','zh-CN'].includes(locale)) {
        assert.notEqual(translation.settings,en.settings,locale+' settings is translated');
        assert.notEqual(translation.chooseLanguage,en.chooseLanguage,locale+' first launch is translated');
      }
    }
  } finally {await server.close();}
});
