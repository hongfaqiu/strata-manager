/** Refresh documentation images from current production main.tsx with isolated IO. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=join(root,'output/playwright/docs-refresh-20261014');
const destination=join(root,'docs/screenshots');
const requireDesktop=createRequire(join(root,'apps/desktop/package.json'));
const runtimeModules=process.env.CODEX_WORKSPACE_NODE_MODULES;
const dependency=name=>{try{return requireDesktop.resolve(name);}catch(error){if(runtimeModules)return join(runtimeModules,name,'index.mjs');throw error;}};
const {chromium}=await import(pathToFileURL(dependency('playwright')).href);
const {createServer}=await import(pathToFileURL(dependency('vite')).href);
const {default:react}=await import(pathToFileURL(dependency('@vitejs/plugin-react')).href);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const version=JSON.parse(await readFile(join(root,'apps/desktop/package.json'),'utf8')).version;
async function sourceSnapshot(){
  const files=[];
  async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){assert(!entry.isSymbolicLink());const file=join(directory,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())files.push(file);}}
  for(const directory of ['apps/desktop/src','packages/core/src','apps/desktop/src-tauri/src'])await walk(join(root,directory));
  files.push(join(root,'CHANGELOG.md'),join(root,'apps/desktop/package.json'));
  const sources=await Promise.all(files.sort().map(async file=>({file:relative(root,file).replaceAll('\\','/'),sha256:hash(await readFile(file))})));
  return {head:spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim(),sha256:hash(JSON.stringify(sources)),sources};
}
const before=await sourceSnapshot();
await mkdir(join(output,'png'),{recursive:true});await mkdir(join(output,'webp'),{recursive:true});
const fsUrl=file=>'/@fs/'+join(root,file).replaceAll('\\','/');
const scripts=['apps/desktop/tests/optimization/native-fixture.js','apps/desktop/tests/optimization/benchmark-native-fixture.js','scripts/screenshot-fixtures/benchmark-data.js','scripts/screenshot-fixtures/documentation-data.js','scripts/screenshot-fixtures/report-data.js','scripts/screenshot-fixtures/current-preview.js'];
const floatingDefinition={width:244,height:120,preferences:{actions:[],alwaysOnTop:true,showSampleTime:false,layout:'strip',rows:'double',fontSize:16,showGraphs:true,showLabels:true,showStatus:false,snapToEdge:false},preferencesAreCurrentDefaults:true};
await writeFile(join(output,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><script>window.__captureFloatingDefinition=${JSON.stringify(floatingDefinition)}</script>${scripts.map(file=>`<script src="${fsUrl(file)}"></script>`).join('')}</head><body><div id="root"></div><script type="module" src="${fsUrl('apps/desktop/src/main.tsx')}"></script></body></html>`);
await writeFile(join(output,'monitor.html'),`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><script src="${fsUrl('apps/desktop/tests/optimization/native-fixture.js')}"></script><script src="${fsUrl('apps/desktop/tests/optimization/floating-monitor-native-fixture.js')}"></script></head><body><div id="root"></div><script type="module" src="${fsUrl('apps/desktop/src/main.tsx')}"></script></body></html>`);
const server=await createServer({configFile:false,envFile:false,root:output,cacheDir:join(output,'.vite'),plugins:[react()],resolve:{alias:{react:join(root,'apps/desktop/node_modules/react'),'react-dom':join(root,'apps/desktop/node_modules/react-dom')}},server:{host:'127.0.0.1',port:0,hmr:false,fs:{allow:[root]}}});
await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.STRATA_BROWSER_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});
const views=[['overview','overview'],['runtime','environment'],['models','models'],['config','config'],['chat','chat'],['usage','usage'],['tuning','tuning'],['monitor','monitor'],['settings','settings'],['about','about'],['benchmark','benchmark'],['common-chat-settings','chat-defaults'],['connections','connections'],['runtime-tools','runtime-tools'],['app-updates','updates'],['service-status','overview'],['runtime-download-settings','environment'],['floating-monitor',''],['running-services','overview'],['overview-api-guide','overview'],['language-settings','settings'],['floating-monitor-settings','monitor-settings'],['scenario-benchmark','benchmark'],['benchmark-report','benchmark']];
const selected=process.env.STRATA_CAPTURE_VIEWS?.split(',');
const captures=[];
async function scrollTo(page,selector){await page.locator(selector).first().evaluate(element=>element.scrollIntoView({block:'start'}));}
try{
for(const [language,locale] of [['zh','zh-CN'],['en','en']])for(const [view,route] of views){
  if(selected&&!selected.includes(view))continue;
  const floating=view==='floating-monitor';
  const context=await browser.newContext({viewport:{width:floating?244:1440,height:floating?120:view==='benchmark-report'?1560:960},deviceScaleFactor:2,locale:locale==='en'?'en-US':locale,colorScheme:'light'});
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const record={file:`${view}.${language}.webp`,view,language,errors:[],consoleErrors:[],externalRequests:[],failedResponses:[],forbiddenCalls:[],passed:false};captures.push(record);
  page.on('pageerror',error=>record.errors.push(String(error)));page.on('console',message=>{if(message.type()==='error')record.consoleErrors.push(message.text());});page.on('response',response=>{if(response.status()>=400)record.failedResponses.push({url:response.url(),status:response.status()});});
  await context.route('**/*',request=>{if(new URL(request.request().url()).origin===origin)return request.continue();record.externalRequests.push(request.request().url());return request.abort();});
  try{
    if(floating){
      // Dedicated monitor fixture returns only synthetic snapshots and size changes.
      await page.goto(`${origin}/monitor.html?window=monitor&language=${locale}&theme=light&layout=strip&fontSize=16`);
      await page.locator('.floating-telemetry-window strong').first().waitFor();
      await page.waitForFunction(()=>window.__fixture.monitor.size);
      const size=await page.evaluate(()=>window.__fixture.monitor.size);await page.setViewportSize(size);record.logicalSize=size;
      await page.waitForTimeout(5000);
    }else{
      await page.goto(`${origin}/index.html?language=${locale}&version=${version}&view=${view}#${route}`);
      await page.locator('#pill').waitFor();await page.waitForFunction(()=>!document.querySelector('.boot'));
      if(view==='running-services')await scrollTo(page,'.running-services-panel');
      if(view==='overview-api-guide'){await page.locator('.overview-shortcut-api').first().click();await page.locator('.api-integration-dialog').first().waitFor();await page.waitForTimeout(300);}
      if(view==='common-chat-settings')await page.locator('.common-chat-settings-panel').waitFor();
      if(view==='floating-monitor-settings')await page.locator('.floating-monitor-settings').waitFor();
      if(view==='language-settings'){
        await page.getByRole('combobox',{name:language==='en'?'Interface language':'界面语言',exact:true}).click();
        await page.getByRole('option',{name:'日本語',exact:true}).waitFor();
      }
      if(view==='scenario-benchmark')await page.getByRole('radio',{name:language==='en'?'Scenario suite':'场景测试',exact:true}).click();
      if(view==='service-status'){
        await page.getByRole('button',{name:language==='en'?'Service status and quick actions':'服务状态与快捷操作',exact:true}).click();
        for(let i=0;i<6;i++){await page.getByRole('button',{name:language==='en'?'Refresh status':'刷新状态',exact:true}).click();await page.waitForTimeout(180);}
      }
      if(view==='runtime-download-settings'){
        await page.getByRole('button',{name:language==='en'?'Check for updates':'检查更新',exact:true}).first().click();
        await page.locator('.runtime-download-settings-details > summary').click();
        await scrollTo(page,'.runtime-download-settings');
      }
    }
    await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(400);
    const png=join(output,'png',`${view}.${language}.png`);
    record.layout=await page.evaluate(()=>({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,language:document.documentElement.lang,theme:document.documentElement.dataset.theme}));
    record.forbiddenCalls=await page.evaluate(()=>window.__fixture.documentation?.forbiddenCalls||[]);
    assert.equal(record.layout.documentWidth,record.layout.width,'Document horizontal overflow');
    if(floating)assert.equal(record.layout.documentHeight,record.layout.height,'Floating monitor vertical overflow');
    for(const key of ['errors','consoleErrors','externalRequests','failedResponses','forbiddenCalls'])assert.deepEqual(record[key],[],`${view}.${language}: ${key}`);
    await page.screenshot({path:png,animations:'disabled'});record.png=relative(root,png).replaceAll('\\','/');record.pngSha256=hash(await readFile(png));record.passed=true;
    console.log(`PASS ${view}.${language}`);
  }catch(error){record.failure=String(error.stack||error);await page.screenshot({path:join(output,`${view}.${language}.failure.png`)}).catch(()=>{});throw error;}finally{await context.close();}
}
const after=await sourceSnapshot();assert.equal(before.sha256,after.sha256,'Production source changed during capture');assert.equal(before.head,after.head);
const python=process.env.STRATA_PYTHON_EXECUTABLE||'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const conversion=spawnSync(python,['-c',`import json,sys,hashlib\nfrom PIL import Image\nitems=json.load(sys.stdin)\nfor item in items:\n im=Image.open(item['png']).convert('RGBA'); im.save(item['webp'],format='WEBP',lossless=True,method=6); out=Image.open(item['webp']).convert('RGBA'); assert im.size==out.size and im.tobytes()==out.tobytes()\n item.update(width=im.width,height=im.height,pixelEquality=True,sha256=hashlib.sha256(open(item['webp'],'rb').read()).hexdigest())\nprint(json.dumps(items))`],{encoding:'utf8',input:JSON.stringify(captures.map(item=>({png:join(root,item.png),webp:join(output,'webp',item.file)})))});
assert.equal(conversion.status,0,conversion.stderr);
const images=JSON.parse(conversion.stdout);
for(let i=0;i<captures.length;i++){Object.assign(captures[i],{width:images[i].width,height:images[i].height,sha256:images[i].sha256,pixelEquality:true});await copyFile(images[i].webp,join(destination,captures[i].file));}
const covers=[];
if(!selected){
  // Homepage covers keep the normal Overview state; the top-right popover stays closed.
  for(const language of ['zh','en']){const source=`overview.${language}.webp`,file=`product-cover.${language}.webp`;await copyFile(join(destination,source),join(destination,file));const record=captures.find(item=>item.file===source);covers.push({file,source,width:record.width,height:record.height,sha256:record.sha256,pixelEquality:true});}
  await copyFile(join(destination,'product-cover.en.webp'),join(destination,'product-cover.webp'));covers.push({...covers[1],file:'product-cover.webp'});
}
const helpers=await Promise.all(['scripts/capture-current-screenshots.mjs',...scripts,'apps/desktop/tests/optimization/floating-monitor-native-fixture.js'].map(async file=>({file,sha256:hash(await readFile(join(root,file)))})));
const manifest={capturedOn:'2026-10-14',capturedAt:new Date().toISOString(),appVersion:version,releaseStatus:'unreleased',source:'Current production main.tsx and styles; isolated synthetic native IO',scope:'No real model, GPU benchmark, native window acceptance, installation, update or user configuration changes.',sourceBaseCommit:before.head,sourceTreeSha256:before.sha256,sourceUnchangedDuringCapture:true,sources:before.sources,screens:captures,browserVersion:browser.version(),conversion:'Lossless WebP with decoded RGBA equality'};
Object.assign(manifest,{covers,helpers,helperTreeSha256:hash(JSON.stringify(helpers))});
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
if(!selected)await writeFile(join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
else{
  const full=JSON.parse(await readFile(join(destination,'manifest.json'),'utf8'));
  assert.equal(full.sourceTreeSha256,before.sha256,'Supplemental capture must use the same production source');
  full.screens=full.screens.map(item=>captures.find(updated=>updated.file===item.file)||item);
  Object.assign(full,{helpers,helperTreeSha256:hash(JSON.stringify(helpers)),supplementalCapturedAt:manifest.capturedAt});
  await writeFile(join(destination,'manifest.json'),JSON.stringify(full,null,2)+'\n');
}
console.log(JSON.stringify({success:true,captures:captures.length,sourceUnchanged:true}));
}finally{await browser.close();await server.close();}
