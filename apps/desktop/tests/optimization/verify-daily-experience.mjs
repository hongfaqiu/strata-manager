import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
const fixture=dirname(fileURLToPath(import.meta.url)),root=resolve(fixture,'../../../..'),requireDesktop=createRequire(resolve(root,'apps/desktop/package.json'));
const {createServer}=await import(pathToFileURL(requireDesktop.resolve('vite')).href),{default:react}=await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const {chromium}=await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE||requireDesktop.resolve('playwright')).href);
const server=await createServer({configFile:false,root:fixture,plugins:[react()],server:{host:'127.0.0.1',port:18759,fs:{allow:[root]}},clearScreen:false});await server.listen();
const origin=`http://127.0.0.1:${server.httpServer.address().port}`,output=resolve(root,'output/playwright/daily-experience');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.STRATA_BROWSER_EXECUTABLE});const results=[];
async function test(name,search,action){const ctx=await browser.newContext({viewport:{width:1360,height:900}});await ctx.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));try{await page.goto(`${origin}/daily-experience-app.html?version=0.1.6&${search}`);await page.locator('.desktop-app-frame').waitFor();await action(page);assert.deepEqual(errors,[]);await page.screenshot({path:resolve(output,`${results.length+1}-${name}.png`),fullPage:true});results.push({name,passed:true});console.log(`PASS ${name}`);}catch(error){results.push({name,passed:false,error:String(error),errors});await page.screenshot({path:resolve(output,`${results.length}-failure.png`)});console.log(`FAIL ${name}: ${error}`);}finally{await ctx.close();}}
const mutations=page=>page.evaluate(()=>window.__fixture.calls.filter(c=>/^(start_service|switch_local_service|ensure_local_service|restart_service|stop_service|set_service_auth)$/.test(c.command)||(c.command==='strata_request'&&c.args.method&&c.args.method!=='GET'&&/^\/(?:v1\/)?(?:load|unload|vram)(?:[?\/]|$)/.test(c.args.path))).map(c=>c.command));
try{
  await test('stopped-diagnostic','stopped&diagnostic#overview',async page=>{await page.getByTestId('startup-diagnostic').waitFor();assert.match(await page.getByTestId('startup-diagnostic').innerText(),/监听端口被占用/);assert.deepEqual(await mutations(page),[]);await page.getByRole('button',{name:'打开网络配置',exact:true}).click();await page.locator('#view-config').waitFor();assert.deepEqual(await mutations(page),[]);});
  await test('resource-selection','stopped#catalog',async page=>{const panel=page.getByTestId('resource-assessment').first();await panel.getByText('适合尝试',{exact:true}).waitFor();await page.locator('.model-download-preset > summary').click();await page.getByRole('spinbutton',{name:'上下文长度',exact:true}).fill('262144');await panel.getByText('存在资源风险',{exact:true}).waitFor();assert.deepEqual(await mutations(page),[]);});
  await test('capability-restart-and-identity','#connections',async page=>{
    await page.evaluate(()=>{const f=window.__fixture;f.configs.a.args=f.configs.a.args.filter((arg,index,args)=>arg!=='--prompt-cache'&&args[index-1]!=='--prompt-cache'&&!arg.startsWith('--prompt-cache='));f.configs.a.args.push('--prompt-cache','4');const original=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=(command,args)=>command==='chat_runtime_evidence'?Promise.resolve({verified:true,pid:99999,startedAt:1,promptCache:1}):original(command,args);});
    const panel=page.locator('.daily-capabilities').first();await panel.locator('summary').click();await panel.getByRole('button',{name:'核验服务能力',exact:true}).click();await panel.getByText('需要重启',{exact:true}).waitFor();
    await page.evaluate(()=>{window.__fixture.serviceStatuses.a={profileId:'a',running:true,owned:true,pid:100000,startedAt:2,phase:'ready'};});
    await panel.getByText('需要重启',{exact:true}).waitFor({state:'hidden',timeout:10000});assert.deepEqual(await mutations(page),[]);
  });
  await test('api-text-tools-image','#connections',async page=>{await page.getByRole('button',{name:'接入 API',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'开始验证',exact:true}).click();await dialog.getByText(/本次验证通过/).waitFor();await dialog.getByRole('radio',{name:'工具结构',exact:true}).click();await dialog.getByRole('button',{name:'开始验证',exact:true}).click();await dialog.getByText(/本次验证通过/).waitFor();await dialog.getByRole('radio',{name:'图片',exact:true}).click();await dialog.getByRole('button',{name:'开始验证',exact:true}).click();await dialog.getByText(/本次验证通过/).waitFor();assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(c=>c.command==='strata_stream').every(c=>c.args.body.max_tokens===256)),true);assert.deepEqual(await mutations(page),[]);});
  await test('lan-preview-preserves-stopped','stopped#connections',async page=>{const sharing=page.locator('.service-sharing-panel');await sharing.getByRole('button',{name:'预览变更',exact:true}).waitFor();await sharing.getByRole('spinbutton',{name:'共享端口'}).fill('19009');await sharing.getByRole('button',{name:'预览变更',exact:true}).click();const review=page.getByRole('dialog',{name:'确认局域网设置变更'});assert.match(await review.innerText(),/当前服务保持未启动/);await review.getByRole('button',{name:'保存配置',exact:true}).click();await review.waitFor({state:'hidden'});assert.deepEqual(await mutations(page),['set_service_auth']);assert.equal(await page.evaluate(()=>window.__fixture.sharing.keyCount),2);});
  await test('chat-request-evidence','#chat',async page=>{await page.locator('#input').fill('fixture request');await page.getByRole('button',{name:'发送',exact:true}).click();await page.locator('.chat-execution').waitFor();await page.getByText('STRATA_API_OK',{exact:true}).waitFor();assert.match(await page.locator('.chat-execution').innerText(),/TTFT/);await page.locator('.chat-execution summary').click();assert.match(await page.locator('.chat-execution').innerText(),/fixture-request/);assert.deepEqual(await mutations(page),[]);});
  const orcaCalls=(page,command)=>page.evaluate(command=>window.__fixture.calls.filter(c=>c.command===command).map(c=>c.args),command);
  const openOrca=async page=>{await page.locator('.model-download-orca > summary').click();await page.getByTestId('orca-import').waitFor();};
  await test('orca-import-download','stopped&orca=ready#catalog',async page=>{
    await openOrca(page);assert.equal(await page.getByTestId('orca-import-badge').innerText(),'社区兼容 · 非官方菜单 · 仅文本');
    await page.getByTestId('orca-ram').getByText(/49\.8 GiB/).waitFor();assert.match(await page.getByTestId('orca-import').innerText(),/85\.20 GB/);
    await page.getByTestId('orca-import-start').click();await page.waitForFunction(()=>window.__fixture.calls.some(c=>c.command==='run_orca_import'));
    const [run]=await orcaCalls(page,'run_orca_import');assert.deepEqual(run.request,{source:'download',mtp:true});assert.ok(run.profile.installDir);assert.deepEqual(await mutations(page),[]);
  });
  await test('orca-import-local-windows-no-mtp','stopped&orca=ready#catalog',async page=>{
    await openOrca(page);await page.getByRole('radio',{name:/使用已下载的分片/}).check();await page.getByRole('button',{name:'选择第 1 个分片…',exact:true}).click();
    await page.getByText('完整',{exact:true}).first().waitFor();await page.getByRole('switch',{name:'准备 MTP 草稿层（可选）'}).or(page.getByLabel('准备 MTP 草稿层（可选）')).first().click();
    await page.waitForFunction(()=>window.__fixture.calls.some(c=>c.command==='orca_import_plan'&&c.args.request.mtp===false));await page.getByTestId('orca-import-start').click();
    await page.waitForFunction(()=>window.__fixture.calls.some(c=>c.command==='run_orca_import'));const [run]=await orcaCalls(page,'run_orca_import');
    assert.deepEqual(run.request,{source:'local',shardPath:'D:\\HF\\orcarouter\\Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00001-of-00002.gguf',mtp:false});assert.deepEqual(await mutations(page),[]);
  });
  await test('orca-import-refuses-iq3m',`stopped&orca=ready&orca-shard=${encodeURIComponent('/home/me/Qwen3.8-Flash-Next-Uncensored-IQ3_M-00001-of-00002.gguf')}#catalog`,async page=>{
    await openOrca(page);await page.getByRole('radio',{name:/使用已下载的分片/}).check();await page.getByRole('button',{name:'选择第 1 个分片…',exact:true}).click();
    assert.match(await page.getByTestId('orca-name-problem').innerText(),/IQ3_M 暂不支持.*Q5_0/);assert.equal(await page.getByTestId('orca-import-start').isDisabled(),true);
    assert.equal((await orcaCalls(page,'orca_import_plan')).filter(c=>c.request.source==='local').length,0);assert.equal((await orcaCalls(page,'run_orca_import')).length,0);
  });
  await test('orca-import-low-ram-warns','stopped&orca=lowram#catalog',async page=>{
    await openOrca(page);await page.getByText('本机内存低于该需求，可能无法启动或频繁读盘。',{exact:true}).waitFor();assert.equal(await page.getByTestId('orca-import-start').isDisabled(),false);
  });
  await test('orca-import-blocked','stopped&orca=blocked&language=en#catalog',async page=>{
    await page.locator('.model-download-orca > summary').click();await page.getByTestId('orca-problems').waitFor();assert.equal(await page.getByTestId('orca-import-badge').innerText(),'Community compatible · Not in the official menu · Text only');
    assert.equal(await page.getByTestId('orca-import-start').isDisabled(),true);assert.equal((await orcaCalls(page,'run_orca_import')).length,0);
  });
  await test('english-dark-narrow','stopped&language=en&theme=dark#connections',async page=>{await page.setViewportSize({width:800,height:850});await page.getByRole('heading',{name:'API and external assistants',exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(await mutations(page),[]);});
}finally{await writeFile(resolve(output,'results.json'),JSON.stringify(results,null,2));await browser.close();await server.close();}
if(results.some(r=>!r.passed))process.exitCode=1;
