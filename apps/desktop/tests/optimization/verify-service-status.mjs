import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname,resolve } from 'node:path';
import { mkdir,writeFile } from 'node:fs/promises';
import { createServer as socketServer } from 'node:net';
import { fileURLToPath,pathToFileURL } from 'node:url';
const fixture=dirname(fileURLToPath(import.meta.url)),root=resolve(fixture,'../../../..');
const requireDesktop=createRequire(resolve(root,'apps/desktop/package.json'));
const {createServer}=await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const {default:react}=await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const {chromium}=await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const port=await new Promise((resolve,reject)=>{const server=socketServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const server=await createServer({configFile:false,root:fixture,plugins:[react()],server:{host:'127.0.0.1',port,strictPort:true,fs:{allow:[root]}},clearScreen:false});await server.listen();
const origin=`http://127.0.0.1:${port}`,output=resolve(root,'output/playwright/service-status');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.STRATA_BROWSER_EXECUTABLE || undefined});
const results=[],trigger=page=>page.getByRole('button',{name:/^(服务状态与快捷操作|Service status and quick actions)$/}),panel=page=>page.locator('.service-status-popover');
async function run(name,query,action,viewport={width:1366,height:768}){
  const context=await browser.newContext({viewport}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));page.setDefaultTimeout(10000);
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  try{await page.goto(`${origin}/service-status-app.html?${query}#overview`);await trigger(page).waitFor();await page.waitForFunction(()=>document.querySelector('#pill-text')?.textContent&&!document.querySelector('.boot'));await action(page);assert.deepEqual(errors,[]);await page.screenshot({path:resolve(output,`${name}.png`),fullPage:true});results.push({name,passed:true});console.log(`PASS ${name}`);}catch(error){results.push({name,passed:false,error:String(error),pageErrors:errors});await page.screenshot({path:resolve(output,`${name}-failure.png`),fullPage:true});console.log(`FAIL ${name}: ${error}`);}finally{await context.close();}
}
try{
  await run('open-dismiss-keyboard-navigation','',async page=>{
    await trigger(page).click();await panel(page).waitFor();const popup=await panel(page).boundingBox();assert.ok(popup.y+popup.height<=756,'Quick panel stays within the viewport');assert.equal(await trigger(page).getAttribute('aria-expanded'),'true');assert.match(await panel(page).innerText(),/API\s+在线/);await page.keyboard.press('Escape');await panel(page).waitFor({state:'hidden'});assert.equal(await trigger(page).evaluate(element=>element===document.activeElement),true);
    await page.keyboard.press('Enter');await panel(page).waitFor();await page.locator('#workspace-page-title').click();await panel(page).waitFor({state:'hidden'});await trigger(page).click();await panel(page).getByRole('button',{name:'监控',exact:true}).click();await page.waitForFunction(()=>['#monitor','#monitoring'].includes(location.hash));await panel(page).waitFor({state:'hidden'});
  });
  await run('unloaded-localized-and-load-action','unloaded',async page=>{
    await page.waitForFunction(()=>document.querySelector('#pill-text')?.textContent.includes('模型未加载'));await trigger(page).click();assert.match(await panel(page).innerText(),/API\s+在线/);const load=panel(page).getByRole('button',{name:'加载模型',exact:true});assert.equal(await load.isEnabled(),true);await load.click();await page.waitForFunction(()=>!window.__fixture.unloaded);await panel(page).getByRole('button',{name:'刷新状态'}).click();await page.waitForFunction(()=>document.querySelector('.service-status-model-state')?.textContent.includes('已就绪'));const posts=await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='strata_request'&&call.args.method==='POST'));assert.deepEqual(posts.map(call=>call.args.path),['/load']);
  });
  await run('stopped-refresh-does-not-enable-service','stopped',async page=>{
    await page.waitForFunction(()=>document.querySelector('#pill-text')?.textContent==='未启动');await trigger(page).click();await panel(page).getByRole('button',{name:'刷新状态'}).click();const calls=await page.evaluate(()=>window.__fixture.calls);assert.equal(calls.some(call=>call.command==='strata_request'),false);assert.equal(calls.some(call=>/^(start_service|ensure_local_service|switch_local_service)$/.test(call.command)),false);assert.equal(await panel(page).getByRole('button',{name:'停止服务',exact:true}).count(),0);
  });
  await run('external-owner-cannot-load-or-stop','unloaded&external',async page=>{
    await page.waitForFunction(()=>document.querySelector('#pill-text')?.textContent.includes('模型未加载'));await trigger(page).click();assert.match(await panel(page).innerText(),/外部服务/);assert.equal(await panel(page).getByRole('button',{name:'加载模型',exact:true}).isDisabled(),true);assert.equal(await panel(page).getByRole('button',{name:'停止服务',exact:true}).isDisabled(),true);
  });
  await run('benchmark-interlocks-quick-actions','',async page=>{
    await page.locator('.manager-nav').getByRole('button',{name:'监控',exact:true}).click();await page.locator('.workspace-subnav').getByRole('button',{name:'Benchmark 测试',exact:true}).click();await page.evaluate(()=>{window.__fixture.benchmark.mode='hold';});await page.locator('.benchmark-page').getByRole('button',{name:'开始测试',exact:true}).click();await page.waitForFunction(()=>window.__fixture.benchmark.streams.length>0);await trigger(page).click();assert.match(await panel(page).innerText(),/Benchmark 正在运行/);assert.equal(await panel(page).getByRole('button',{name:'停止服务',exact:true}).isDisabled(),true);assert.equal(await panel(page).getByRole('button',{name:'释放模型内存',exact:true}).isDisabled(),true);await page.keyboard.press('Escape');await page.locator('.benchmark-page').getByRole('button',{name:'停止测试',exact:true}).click();
  });
  await run('failed-tuning-is-not-repeated-in-quick-panel','failed',async page=>{
    await trigger(page).click();await panel(page).waitFor();assert.equal(await panel(page).locator('.service-status-issue').count(),0);assert.doesNotMatch(await panel(page).innerText(),/最近调优/);
  });
  for(const language of ['zh-CN','en'])await run(`narrow-${language}`,`unloaded&language=${language}`,async page=>{
    await trigger(page).click();const rect=await panel(page).boundingBox();assert.ok(rect.x>=11&&rect.x+rect.width<=481&&rect.y+rect.height<=781);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  },{width:480,height:800});
}finally{await writeFile(resolve(output,'results.json'),JSON.stringify({scope:'Real React App with isolated in-memory native fixture. No real services or GPU.',results},null,2));await browser.close();await server.close();}
if(results.some(result=>!result.passed))process.exitCode=1;
