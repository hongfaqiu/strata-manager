import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const fixture=dirname(fileURLToPath(import.meta.url)), root=resolve(fixture,'../../../..');
const requireDesktop=createRequire(resolve(root,'apps/desktop/package.json'));
const {createServer}=await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const {default:react}=await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const modulePath=process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright');
const {chromium}=await import(pathToFileURL(modulePath).href);
const server=await createServer({configFile:false,root:fixture,plugins:[react()],server:{host:'127.0.0.1',port:0,fs:{allow:[root]}},clearScreen:false});
await server.listen();
const origin='http://127.0.0.1:'+server.httpServer.address().port;
const output=resolve(root,'output/language-verification');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.STRATA_BROWSER_EXECUTABLE || undefined});
const results=[];
async function run(name,params,action) {
  if (process.env.STRATA_LANGUAGE_CASE && process.env.STRATA_LANGUAGE_CASE !== name) return;
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.stack || String(error)));
  page.setDefaultTimeout(10000);
  const base=origin+'/language-app.html?case='+encodeURIComponent(name)+'&'+params;
  try {
    await page.goto(base);
    await action(page,base);
    assert.deepEqual(errors,[]);
    const calls=await page.evaluate(()=>window.__fixture.calls);
    assert.equal(calls.filter(call=>/^(switch_local_service|ensure_local_service|start_service|stop_service|restart_service)$/.test(call.command)).length,0,'no model lifecycle action');
    results.push({name,passed:true});
    console.log('PASS '+name);
  } catch(error) {
    await writeFile(resolve(output,name+'-errors.json'),JSON.stringify(errors,null,2));
    await page.screenshot({path:resolve(output,name+'-failure.png')});
    await writeFile(resolve(output,name+'-failure.txt'),await page.locator('body').innerText());
    throw error;
  } finally {await context.close();}
}
const language=async(page,locale)=>{await page.waitForFunction(expected=>document.documentElement.lang===expected,locale);};
const confirm=async page=>{
  await page.locator('[role="dialog"] .dialog-footer button').click();
  await page.locator('[role="dialog"]').waitFor({state:'hidden'});
};
try {
  const cases=[['en-US','en'],['zh-CN','zh-CN'],['zh-TW','zh-TW'],['ja-JP','ja'],['ko-KR','ko'],['de-DE','de'],['fr-FR','fr'],['es-ES','es'],['pt-BR','pt'],['ru-RU','ru'],['ar-SA','en'],['C.UTF-8','en']];
  for(const [nativeLocale,expected] of cases) await run('system-'+nativeLocale,'locale='+encodeURIComponent(nativeLocale),async page=>{
    await language(page,expected);
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.evaluate(()=>window.__fixture.store.settings.languagePreference),'system');
    if(expected==='en') await page.getByRole('dialog').getByText('Choose your language',{exact:true}).waitFor();
    if(['en','ja','de'].includes(expected)) await page.screenshot({path:resolve(output,'first-launch-'+expected+'.png')});
    await confirm(page);
    await page.reload();
    await language(page,expected);
    await page.waitForFunction(()=>window.__fixture.calls.some(call=>call.command==='apply_settings'));
    assert.equal(await page.getByRole('dialog').count(),0);
  });
  await run('manual-override','locale=en-US',async(page,base)=>{
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByRole('combobox').click();
    await page.getByRole('option',{name:'日本語',exact:true}).click();
    await language(page,'ja');
    await confirm(page);
    await page.goto(base.replace('locale=en-US','locale=de-DE')+'#settings');
    await language(page,'ja');
    await page.waitForFunction(()=>window.__fixture.calls.some(call=>call.command==='apply_settings'));
    assert.equal(await page.getByRole('dialog').count(),0);
    assert.equal(await page.evaluate(()=>window.__fixture.store.settings.languagePreference),'ja');
    const selector=page.getByRole('combobox',{name:await page.evaluate(()=>window.__i18n.t('language')),exact:true});
    await selector.click();
    await page.getByRole('option',{name:'システムの言語に従う',exact:true}).click();
    await language(page,'de');
    await page.waitForFunction(()=>window.__fixture.calls.some(call=>call.command==='store_set' && call.args.key==='settings' && call.args.value.languagePreference==='system'));
    await page.goto(base.replace('locale=en-US','locale=fr-FR')+'#settings');
    await language(page,'fr');
    await page.screenshot({path:resolve(output,'settings-fr.png')});
  });
  for(const [saved,os,expected] of [['zh-CN','en-US','zh-CN'],['en','zh-CN','en']]) await run('legacy-'+saved,'legacy='+saved+'&locale='+os+'&installer=fr',async page=>{
    await language(page,expected);
    await page.waitForFunction(()=>window.__fixture.calls.some(call=>call.command==='apply_settings'));
    assert.equal(await page.getByRole('dialog').count(),0);
    assert.equal(await page.evaluate(()=>window.__fixture.store.settings.languagePreference),saved);
  });
  await run('installer-choice','locale=en-US&installer=fr',async page=>{
    await language(page,'fr');
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.evaluate(()=>window.__fixture.store.settings.languagePreference),'fr');
    await confirm(page);
  });
  await run('installer-default-follows-system','locale=fr-FR&installer=fr',async(page,base)=>{
    await language(page,'fr');
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.evaluate(()=>window.__fixture.store.settings.languagePreference),'system');
    await confirm(page);
    await page.goto(base.replace('locale=fr-FR','locale=de-DE'));
    await language(page,'de');
    await page.waitForFunction(()=>window.__fixture.calls.some(call=>call.command==='apply_settings'));
    assert.equal(await page.getByRole('dialog').count(),0);
  });
  await run('all-pages-german','locale=de-DE',async(page,base)=>{
    await confirm(page);
    for(const route of ['overview','models','monitoring','usage','tasks','environment','settings','about','benchmark']){
      await page.goto(base+'#'+route);
      await language(page,'de');
      await page.waitForFunction(()=>window.__fixture.calls.some(call=>call.command==='apply_settings'));
      assert.ok(!(await page.locator('body').innerText()).includes('undefined'));
    }
  });
  await writeFile(resolve(output,'results.json'),JSON.stringify({source:'Actual App and production CSS with isolated synthetic native/storage data; no real services or installer executed.',results},null,2));
} finally {await browser.close();await server.close();}
