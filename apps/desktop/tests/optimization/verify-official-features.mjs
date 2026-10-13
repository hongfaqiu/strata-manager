import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = dirname(fileURLToPath(import.meta.url)), root = resolve(fixture,'../../../..');
const requireDesktop = createRequire(resolve(root,'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const server = await createServer({configFile:false,root:fixture,plugins:[react()],server:{host:'127.0.0.1',port:18741,strictPort:true,fs:{allow:[root]}},clearScreen:false});
await server.listen();
const origin='http://127.0.0.1:18741', output=resolve(root,'output/playwright/official-features');
await mkdir(output,{recursive:true});
const results=[];
let browser;
async function choose(page,name,label,controlRoot=page) { await controlRoot.getByRole('combobox',{name,exact:true}).click(); await page.getByRole('option',{name:label,exact:true}).click(); }
async function pinJsonDocument(page) {
  await page.locator('#sampling-btn').click();await choose(page,'输出格式','JSON Schema');await page.getByRole('switch',{name:'复用长文',exact:true}).click();await page.getByRole('spinbutton',{name:'复用前多少字符（留空：全文）'}).fill('4');
  await page.screenshot({path:resolve(output,'app-sampling-drawer.png'),fullPage:true});await page.locator('#s-apply').click();await page.getByRole('dialog').waitFor({state:'hidden'});
}
async function supervisorSelection(page, id, updateServices = true) {
  await page.evaluate(async ({ id, updateServices }) => {
    const fixture = window.__fixture;
    Object.assign(fixture.supervisor, { pid: 88888, activeLocalInstallation: id, localServiceDesired: true, activeServices: 1 });
    fixture.supervisor.health = { [id]: { phase: 'healthy', apiHealthy: true, loaded: true, pid: id === 'a' ? 99999 : 99998, checkedAt: Date.now(), lastHealthyAt: Date.now(), reason: '', failures: [], observerState: 'idle' } };
    if (updateServices) for (const profile of fixture.profiles) fixture.serviceStatuses[profile.id] = { profileId: profile.id, running: profile.id === id, owned: profile.id === id, pid: profile.id === id ? (id === 'a' ? 99999 : 99998) : null, phase: profile.id === id ? 'ready' : 'stopped' };
    await window.__query.invalidateQueries({ queryKey: ['supervisor'] });
  }, { id, updateServices });
}
async function activeProfile(page, id) {
  await page.waitForFunction(id => window.__fixture.store.activeProfile === id, id);
  await page.getByRole('button', { name: '服务状态与快捷操作', exact: true }).click();
  await page.getByRole('dialog', { name: `Fixture ${id.toUpperCase()}`, exact: true }).locator('.service-status-model').waitFor();
  await page.getByRole('button', { name: '关闭快捷面板', exact: true }).click();
}
async function run(name,tab,action,app=false) {
  const context=await browser.newContext({viewport:{width:1440,height:1050}});
  // No request ever reaches a supervisor or a real model, even if a product bug tries.
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage(),pageErrors=[];
  page.setDefaultTimeout(10000);page.on('pageerror',error=>pageErrors.push(String(error)));
  try {
    await page.goto(app ? `${origin}/official-app.html#${tab}` : `${origin}/official-features.html?tab=${tab}`);
    if(app) await page.locator('#view-config, #view-chat, .model-grid, .service-manager-card, .management-content').first().waitFor(); else await page.getByRole('heading',{name:'官方功能 · 隔离交互验证'}).waitFor();
    await action(page);assert.deepEqual(pageErrors,[]);
    assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>/^(switch_local_service|ensure_local_service|start_service|stop_service|restart_service|take_over_service)$/.test(call.command)).length),0);
    await page.screenshot({path:resolve(output,`${name}.png`),fullPage:true});results.push({name,passed:true});console.log(`PASS ${name}`);
  } catch(error) {
    results.push({name,passed:false,error:String(error),pageErrors});console.log(`FAIL ${name}: ${error}`);
    await page.screenshot({path:resolve(output,`${name}-failure.png`),fullPage:true});await writeFile(resolve(output,`${name}-failure.txt`),await page.locator('body').innerText());
  } finally {await context.close();}
}
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.STRATA_BROWSER_EXECUTABLE||undefined});
  await run('setup-sources-gpus-inspect','setup',async page=>{
    await page.getByTestId('setup-advanced-options').locator('summary').first().click();
    await choose(page,'下载来源','Hugging Face 镜像');await page.getByRole('textbox',{name:'HF 镜像地址'}).fill('http://mirror.example');
    assert.equal(await page.getByRole('button',{name:'提交准备选项'}).isDisabled(),true);
    await page.getByRole('textbox',{name:'HF 镜像地址'}).fill('https://hf-mirror.com/');
    await choose(page,'显卡类型','NVIDIA 显卡（CUDA）');await page.getByRole('textbox',{name:'使用哪些显卡'}).fill('2, 0');
    await page.getByRole('button',{name:'提交准备选项'}).click();
    await page.waitForFunction(()=>window.__fixture.calls.some(call=>call.command==='run_setup'));
    const setup=await page.evaluate(()=>window.__fixture.calls.find(call=>call.command==='run_setup').args);
    assert.equal(setup.quant,'IQ3_S');assert.deepEqual(setup.options,{source:'mirror',hfEndpoint:'https://hf-mirror.com',backend:'cuda',gpus:'2,0'});
    await choose(page,'下载来源','ModelScope 魔搭');await page.getByRole('button',{name:'提交准备选项'}).click();
    await page.waitForFunction(()=>window.__fixture.calls.filter(call=>call.command==='run_setup').length===2);
    assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='run_setup').at(-1).args.options.hfEndpoint),undefined);
    await page.getByTestId('model-inspect-panel').screenshot({path:resolve(output,'model-inspect-visible-options.png')});await page.getByRole('textbox',{name:'模型位置'}).fill('hf:owner/repo');
    await page.getByRole('textbox',{name:'指定量化版本（可选）'}).fill('IQ3_S');await page.getByRole('button',{name:'检查兼容性',exact:true}).click();
    await page.getByText('检查完成',{exact:true}).waitFor();await page.getByTestId('model-inspect-panel').screenshot({path:resolve(output,'model-inspect-visible-result.png')});await page.getByRole('button',{name:'查看详细结果',exact:true}).click();assert.match(await page.getByRole('dialog',{name:'模型检查结果'}).locator('pre').innerText(),/compatible/);
    assert.deepEqual(await page.evaluate(()=>window.__fixture.calls.find(call=>call.command==='inspect_gguf').args.request),{installationId:'a',target:'hf:owner/repo',variant:'IQ3_S'});
  });
  await run('inspect-cancellation','setup',async page=>{
    await page.getByRole('textbox',{name:'模型位置'}).fill('C:\\fixture\\wait.gguf');await page.getByRole('button',{name:'检查兼容性',exact:true}).click();
    await page.getByRole('button',{name:'取消',exact:true}).click();await page.getByText('已取消',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='cancel_task').length),1);
  });
  await run('chat-json-prefix-and-invalid-schema','chat',async page=>{
    assert.equal(await page.locator('.chat-advanced-options details').count(),0);await page.locator('.chat-advanced-options').screenshot({path:resolve(output,'chat-visible-options.png')});await choose(page,'输出格式','JSON Schema');
    await page.getByRole('switch',{name:'复用长文',exact:true}).click();await page.getByRole('spinbutton',{name:'复用前多少字符（留空：全文）'}).fill('4');
    await page.getByRole('button',{name:'构造聊天请求'}).click();
    const body=await page.evaluate(()=>window.__fixture.chatBody);assert.equal(body.response_format.type,'json_schema');assert.deepEqual(body.strata_prefix,{message:1,chars:4});assert.equal(body.strata_mcp,undefined);assert.equal(body.messages[0].role,'user');assert.equal(body.messages[0].content,'长文😀内容供固定前缀测试。');
    // The official server prepends the JSON-format system prompt; the fixed
    // prefix indexes that final server-side message list, so its offset is 1.
    await page.screenshot({path:resolve(output,'chat-json-prefix-request.png'),fullPage:true});
    await page.getByRole('textbox',{name:'JSON Schema',exact:true}).fill('{invalid');await page.getByRole('button',{name:'构造聊天请求'}).click();assert.match(await page.getByTestId('chat-request').innerText(),/不是有效 JSON/);
  });
  await run('mcp-application-default-and-optional-external','mcp',async page=>{
    await page.getByRole('radio',{name:'通过本应用管理（推荐）',exact:true}).waitFor();
    await page.getByRole('button',{name:'检查连接',exact:true}).click();await page.getByRole('button',{name:'外部助手接入帮助',exact:true}).click();await page.getByRole('dialog',{name:'外部助手接入说明'}).getByText('strata_status',{exact:true}).waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'外部助手接入说明'}).waitFor({state:'hidden'});assert.equal(await page.locator('.mcp-integration-panel details').count(),0);await page.locator('.mcp-integration-panel').screenshot({path:resolve(output,'mcp-visible-controls.png')});
    assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='manager_mcp_connection').length),1);
    assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='probe_official_mcp'||call.command==='set_external_management').length),0);
    assert.match(await page.getByRole('textbox',{name:'无密钥 MCP 客户端配置'}).inputValue(),/--mcp-server/);
    await choose(page,'MCP 客户端','Cursor');const managedConfig=JSON.parse(await page.getByRole('textbox',{name:'无密钥 MCP 客户端配置'}).inputValue());assert.equal(managedConfig.mcpServers.strata.command,'C:\\fixture\\strata-supervisor.exe');assert.deepEqual(managedConfig.mcpServers.strata.args,['--mcp-server','--data-dir','C:\\fixture\\manager-data','--profile-id','a']);
    await page.getByRole('radio',{name:'外部独立接管',exact:true}).check();
    assert.equal(await page.getByRole('textbox',{name:'无密钥 MCP 客户端配置'}).count(),0);
    await page.getByRole('button',{name:'检查连接',exact:true}).click();
    await page.waitForFunction(()=>window.__fixture.calls.filter(call=>call.command==='probe_official_mcp').length===1);
    assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='probe_official_mcp').length),1);
    assert.equal(await page.getByRole('textbox',{name:'无密钥 MCP 客户端配置'}).count(),0);
    await page.getByRole('button',{name:'交给外部助手独立管理',exact:true}).click();await page.getByText('由外部助手管理',{exact:true}).waitFor();
    await choose(page,'MCP 客户端','Cursor');const config=JSON.parse(await page.getByRole('textbox',{name:'无密钥 MCP 客户端配置'}).inputValue());assert.match(config.mcpServers.strata.args[0],/strata_mcp\.py$/);assert.equal(config.mcpServers.strata.command,'C:\\fixture\\python.exe');
    await page.screenshot({path:resolve(output,'mcp-client-configuration.png'),fullPage:true});
    await page.getByRole('radio',{name:'通过本应用管理（推荐）',exact:true}).check();assert.equal(await page.getByRole('textbox',{name:'无密钥 MCP 客户端配置'}).count(),0);
    await page.getByRole('button',{name:'恢复本应用管理',exact:true}).click();await page.getByText('由本应用管理',{exact:true}).waitFor();
    await page.getByRole('button',{name:'检查连接',exact:true}).click();assert.match(await page.getByRole('textbox',{name:'无密钥 MCP 客户端配置'}).inputValue(),/--mcp-server/);
    assert.deepEqual(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='set_external_management').map(call=>call.args.external)),[true,false]);
  });
  await run('slots-vram-session-save-restore','resources',async page=>{
    await page.getByRole('region',{name:'逐槽监控'}).waitFor();await page.getByText('可为其他程序腾出显存，回答速度可能降低。',{exact:true}).waitFor();assert.equal(await page.locator('.runtime-operations details').count(),0);await page.locator('.runtime-operations').screenshot({path:resolve(output,'runtime-visible-controls.png')});await page.getByRole('button',{name:'更多指标',exact:true}).click();assert.equal(await page.locator('.runtime-slot-monitor tbody tr').count(),2);assert.match(await page.locator('.runtime-slot-monitor tbody tr').nth(1).innerText(),/512/);
    await page.getByRole('spinbutton',{name:'希望保留的空闲显存（MiB）'}).fill('8192');await page.getByRole('button',{name:'释放显存',exact:true}).click();await page.getByText('调整已执行，空闲目标未完全满足。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'恢复默认预留',exact:true}).click();await page.getByText('空闲目标已满足。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'检查是否可存档',exact:true}).click();await page.getByRole('button',{name:'保存会话',exact:true}).waitFor();
    await page.getByRole('textbox',{name:'存档文件名'}).fill('long-chat.bin');await page.getByRole('button',{name:'保存会话',exact:true}).click();await page.getByRole('dialog',{name:'保存引擎会话'}).getByRole('button',{name:'保存',exact:true}).click();await page.getByText('引擎会话已保存。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'恢复会话',exact:true}).click();await page.getByRole('dialog',{name:'恢复引擎会话'}).getByRole('button',{name:'恢复',exact:true}).click();await page.getByText('引擎会话已恢复；继续发送匹配的聊天历史即可复用。',{exact:true}).waitFor();
    const calls=await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='strata_request'&&call.args.path.startsWith('/slots/0')));assert.equal(calls.length,3);assert.equal(calls[0].args.body.filename,'');assert.equal(calls[2].args.body.filename,'long-chat.bin');
  });
  await run('vram-resident-mode-readable-refusal','resources',async page=>{
    const originalMessage='VRAM: not with the resident low-RAM mode (the cache holds experts RAM does not)';
    await page.evaluate(message=>{
      const originalInvoke=window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
        if(command==='strata_request'&&args.path==='/v1/vram') {
          window.__fixture.calls.push({command,args:structuredClone(args)});
          throw `HTTP 400: ${JSON.stringify({error:{message}})}`;
        }
        return originalInvoke(command,args);
      };
    },originalMessage);
    await page.getByRole('button',{name:'释放显存',exact:true}).click();
    const notice=page.getByRole('alert');await notice.waitFor();
    assert.match(await notice.innerText(),/当前模型的低内存模式不支持在线调整显存/);
    assert.equal((await notice.innerText()).includes(originalMessage),false,'Raw runtime wording is hidden until requested');
    assert.equal(await page.getByRole('button',{name:'释放显存',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'恢复默认预留',exact:true}).isDisabled(),true);
    assert.equal(await page.locator('.runtime-operations details').count(),0);
    const diagnostic=notice.getByRole('button',{name:'查看诊断',exact:true});
    await diagnostic.focus();await page.keyboard.press('Enter');
    const dialog=page.getByRole('dialog',{name:'显存与会话说明'});await dialog.waitFor();
    assert.match(await dialog.innerText(),/HTTP 400: VRAM: not with the resident low-RAM mode/);
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    assert.equal(await diagnostic.evaluate(element=>element===document.activeElement),true,'Closing the diagnostic returns focus to its trigger');
    assert.equal((await notice.innerText()).includes(originalMessage),false);
    assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='strata_request'&&call.args.path==='/v1/vram').length),1,'The unsupported operation is not retried');
  });
  await run('tuning-adaptive-candidate-options','tuning',async page=>{
    await page.getByText('高级测试设置',{exact:true}).click();
    for(const name of ['重排间隔','每轮交换上限','计数衰减']) await page.getByRole('switch',{name,exact:true}).click();
    await choose(page,'重排间隔 候选值','4');await choose(page,'每轮交换上限 候选值','192');await choose(page,'计数衰减 候选值','0.92');
    await page.getByRole('button',{name:'开始实测',exact:true}).click();
    await page.waitForFunction(()=>window.__fixture.calls.some(call=>call.command==='tuning_start'));
    const request=await page.evaluate(()=>window.__fixture.calls.find(call=>call.command==='tuning_start').args.request);assert.deepEqual(request.restartCandidates,[{adaptEvery:4},{adaptSwaps:192},{adaptDecay:0.92}]);
  });
  await run('app-catalog-setup-and-inspect','catalog',async page=>{
    const card=page.locator('.model-card').filter({has:page.getByRole('heading',{name:'Swift 1.5',exact:true})});await card.waitFor();
    await choose(page,'量化','IQ3_S',card);await card.getByTestId('setup-advanced-options').locator('summary').first().click();await choose(page,'下载来源','Hugging Face 镜像',card);
    await card.getByRole('textbox',{name:'HF 镜像地址'}).fill('https://hf-mirror.com');await choose(page,'显卡类型','NVIDIA 显卡（CUDA）',card);await card.getByRole('textbox',{name:'使用哪些显卡'}).fill('2,0');
    await card.screenshot({path:resolve(output,'app-catalog-setup-options.png')});
    await card.getByRole('button',{name:'准备模型',exact:true}).click();await page.waitForFunction(()=>window.__fixture.calls.some(call=>call.command==='run_setup'));
    const args=await page.evaluate(()=>window.__fixture.calls.find(call=>call.command==='run_setup').args);assert.equal(args.model,'swift');assert.equal(args.quant,'IQ3_S');assert.equal(args.profile.id,'a');assert.deepEqual(args.options,{source:'mirror',hfEndpoint:'https://hf-mirror.com',backend:'cuda',gpus:'2,0'});
    await page.getByRole('textbox',{name:'模型位置'}).fill('hf:owner/repo');await page.getByRole('button',{name:'检查兼容性',exact:true}).click();await page.getByText('检查完成',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__fixture.calls.find(call=>call.command==='inspect_gguf').args.request.installationId),'a');
  },true);
  await run('app-sampling-send-refreshes-capabilities','chat',async page=>{
    await pinJsonDocument(page);const before=await page.evaluate(()=>window.__fixture.calls.length);await page.locator('#input').fill('请给出 JSON 回答。');await page.locator('#send-btn').click();await page.waitForFunction(()=>window.__fixture.calls.some(call=>call.command==='strata_stream'));
    const calls=await page.evaluate(index=>window.__fixture.calls.slice(index),before),stream=calls.find(call=>call.command==='strata_stream');assert.ok(stream);assert.equal(stream.args.body.model,'Fixture A');assert.equal(stream.args.body.response_format.type,'json_schema');assert.deepEqual(stream.args.body.strata_prefix,{message:1,chars:4});assert.equal(stream.args.body.strata_mcp,undefined);
    const streamIndex=calls.indexOf(stream);for(const path of ['/v1/status','/metrics']) assert.ok(calls.findIndex(call=>call.command==='strata_request'&&call.args.path===path)>=0&&calls.findIndex(call=>call.command==='strata_request'&&call.args.path===path)<streamIndex);
    assert.ok(calls.findIndex(call=>call.command==='chat_runtime_evidence')>=0&&calls.findIndex(call=>call.command==='chat_runtime_evidence')<streamIndex);
    await page.getByText('{"answer":"fixture"}',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='strata_request'&&call.args.path==='/settings'&&call.args.method==='POST').length),0);
  },true);
  await run('app-pin-rejects-saved-config-with-shallow-running-cache','chat',async page=>{
    await pinJsonDocument(page);await page.evaluate(()=>{window.__fixture.runtimeEvidence.promptCache=2;});await page.locator('#input').fill('请继续处理这份文档。');await page.locator('#send-btn').click();await page.getByText('当前服务未确认支持 固定前缀，请刷新服务能力或移除此设置',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='strata_stream').length),0);assert.ok(await page.evaluate(()=>window.__fixture.calls.some(call=>call.command==='chat_runtime_evidence')));assert.equal(await page.evaluate(()=>window.__fixture.configs.a.args[window.__fixture.configs.a.args.indexOf('--prompt-cache')+1]),'4');
  },true);
  await run('app-stop-during-metadata-does-not-send-late-stream','chat',async page=>{
    assert.equal(await page.locator('#stop-btn').isVisible(),false);
    await pinJsonDocument(page);await page.evaluate(()=>{window.__fixture.holdCapabilities=true;});await page.locator('#input').fill('等待能力检查时取消。');await page.locator('#send-btn').click();await page.waitForFunction(()=>window.__fixture.metadataReadHeld===true);
    const before=Date.now();await page.locator('#stop-btn').click();await page.locator('#input').waitFor({state:'visible'});await page.waitForFunction(()=>!document.getElementById('input').disabled&&document.getElementById('stop-btn').hidden);assert.ok(Date.now()-before<1500,'Stop must complete while metadata remains pending');
    assert.equal(await page.locator('#stop-btn').isVisible(),false);assert.equal(await page.locator('#send-btn').isVisible(),true);
    assert.equal(await page.evaluate(()=>window.__fixture.metadataReadCompleted),undefined);assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='strata_stream').length),0);
    await page.evaluate(async()=>{window.__fixture.releaseCapabilities();await new Promise(resolve=>setTimeout(resolve,50));});assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='strata_stream').length),0);
  },true);
  await run('app-common-workspaces-mount-runtime-and-mcp-panels','config',async page=>{
    await page.setViewportSize({width:1280,height:900});
    await page.getByRole('combobox',{name:'设置分类',exact:true}).waitFor();await page.locator('.startup-tuning').screenshot({path:resolve(output,'startup-settings-category.png')});
    assert.equal(await page.locator('.mcp-integration-panel, .runtime-operations').count(),0,'Model configuration keeps its model-specific editor; shared tools have their own workspace');
    await page.getByRole('button',{name:'打开设置',exact:true}).click();await page.waitForURL(url=>url.hash==='#settings');
    await page.locator('.workspace-subnav').getByRole('button',{name:'API 与外部助手',exact:true}).click();await page.waitForURL(url=>url.hash==='#connections');await page.locator('.mcp-integration-mode').first().waitFor();
    const modeGeometry=await page.locator('.mcp-integration-mode').evaluateAll(labels=>labels.map(label=>{
      const radio=label.querySelector('input[type="radio"]').getBoundingClientRect();
      const copy=label.querySelector(':scope > span').getBoundingClientRect();
      const bounds=label.getBoundingClientRect();
      return {radioWidth:radio.width,radioHeight:radio.height,copyWidth:copy.width,labelHeight:bounds.height};
    }));
    assert.equal(modeGeometry.length,2);
    for(const bounds of modeGeometry) {
      assert.ok(bounds.radioWidth>0&&bounds.radioWidth<=24,`MCP radio must retain a compact width under the app's global input styles: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.radioHeight>0&&bounds.radioHeight<=24,`MCP radio must retain a compact height under the app's global input styles: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.copyWidth>100,`MCP mode explanation must have readable horizontal space: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.labelHeight<160,`MCP mode card must not expand into a single-character column: ${JSON.stringify(bounds)}`);
    }
    await page.locator('.mcp-integration-modes').screenshot({path:resolve(output,'app-mcp-mode-layout-1280.png')});
    await page.getByRole('button',{name:'检查连接',exact:true}).click();await page.getByRole('button',{name:'外部助手接入帮助',exact:true}).click();await page.getByRole('dialog',{name:'外部助手接入说明'}).getByText('strata_status',{exact:true}).waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'外部助手接入说明'}).waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>window.__fixture.calls.find(call=>call.command==='manager_mcp_connection').args.profileId),'a');assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='set_external_management'||call.command==='probe_official_mcp').length),0);
    await page.screenshot({path:resolve(output,'app-connections-workspace.png'),fullPage:true});
    await page.locator('.workspace-subnav').getByRole('button',{name:'显存与会话',exact:true}).click();await page.waitForURL(url=>url.hash==='#runtime-tools');
    await page.getByRole('spinbutton',{name:'希望保留的空闲显存（MiB）'}).fill('8192');await page.getByRole('button',{name:'释放显存',exact:true}).click();await page.getByText('调整已执行，空闲目标未完全满足。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'检查是否可存档',exact:true}).click();await page.getByRole('button',{name:'保存会话',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__fixture.calls.find(call=>call.command==='strata_request'&&call.args.path==='/v1/vram').args.profile.id),'a');
  },true);
  await run('app-supervisor-sync-preserves-new-gui-selection','models',async page=>{
    await supervisorSelection(page, 'a'); await activeProfile(page, 'a');
    // The service has already switched, while the backend selection query still
    // contains A. GUI activation must consume that cached snapshot once.
    await page.evaluate(async () => {
      const fixture = window.__fixture;
      fixture.serviceStatuses.a = { profileId: 'a', running: false, owned: false, phase: 'stopped' };
      fixture.serviceStatuses.b = { profileId: 'b', running: true, owned: true, pid: 99998, phase: 'ready' };
      await window.__query.invalidateQueries({ queryKey: ['service-manager-process', 'b'] });
    });
    await page.locator('.service-manager-card[data-profile-id="b"]').getByRole('button', { name: '使用此配置', exact: true }).click();
    await activeProfile(page, 'b');
    for (let index = 0; index < 2; index++) {
      await supervisorSelection(page, 'a', false);
      await activeProfile(page, 'b');
    }
    assert.equal(await page.evaluate(() => window.__query.getQueryData(['supervisor']).activeLocalInstallation), 'a', 'The stale backend selection must remain present while the new GUI selection is retained');
  },true);
  await run('app-supervisor-sync-follows-mcp-selection','models',async page=>{
    await supervisorSelection(page, 'a'); await activeProfile(page, 'a');
    await supervisorSelection(page, 'b'); await activeProfile(page, 'b');
    await supervisorSelection(page, 'a'); await activeProfile(page, 'a');
    assert.equal(await page.locator('.service-manager-card[data-profile-id="a"].is-current').count(), 1);
  },true);
  await run('app-supervisor-sync-retains-explicit-config-editor','models',async page=>{
    await supervisorSelection(page, 'a'); await activeProfile(page, 'a');
    await page.locator('.service-manager-card[data-profile-id="a"]').getByRole('button', { name: '运行配置', exact: true }).click();
    await page.locator('#view-config').waitFor();
    await page.getByRole('radio',{name:'完整 JSON',exact:true}).click();
    const editor=page.getByRole('textbox',{name:'完整本地 JSON 配置',exact:true});await editor.waitFor();
    const draft=JSON.parse(await editor.inputValue());draft.args.push('--max-context','16384');
    const draftText=JSON.stringify(draft,null,2);await editor.fill(draftText);
    assert.equal(await page.getByRole('button',{name:'保存完整配置',exact:true}).isEnabled(),true);
    await supervisorSelection(page, 'b'); await activeProfile(page, 'b');
    assert.match(await page.locator('.model-config-breadcrumb').innerText(), /Fixture A/);
    assert.equal(await editor.inputValue(),draftText,'Backend selection changes must preserve the explicit model editor and its startup JSON draft');
    assert.equal(await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='write_config').length),0,'The unsaved model draft must not be persisted while the external selection changes');
    assert.equal(await page.evaluate(()=>window.__fixture.configs.a.args.includes('16384')),false);
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command.startsWith('read_config')).at(-1).args.profile.id), 'a');
  },true);
} finally { if(browser)await browser.close();await server.close();await writeFile(resolve(output,'browser-results.json'),JSON.stringify({origin,scope:'Isolated real React components with in-memory native IO; no actual service mutations',results},null,2)); }
if(results.some(result=>!result.passed))process.exitCode=1;
