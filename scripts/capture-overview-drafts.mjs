// Local-only: capture Overview design drafts (?overviewDraft=a|b|c) with the isolated screenshot fixtures.
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=join(root,'output/playwright/overview-drafts');
const dest=process.env.DRAFT_OUT||'/workspace/docs-preview/overview-drafts';
const req=createRequire(join(root,'apps/desktop/package.json'));
const {chromium}=await import('/workspace/.pwtool/node_modules/playwright-core/index.mjs');
const {createServer}=await import(pathToFileURL(req.resolve('vite')).href);
const {default:react}=await import(pathToFileURL(req.resolve('@vitejs/plugin-react')).href);
await mkdir(output,{recursive:true});await mkdir(dest,{recursive:true});
const fsUrl=f=>'/@fs/'+join(root,f);
const scripts=['apps/desktop/tests/optimization/native-fixture.js','apps/desktop/tests/optimization/benchmark-native-fixture.js','scripts/screenshot-fixtures/benchmark-data.js','scripts/screenshot-fixtures/documentation-data.js','scripts/screenshot-fixtures/report-data.js','scripts/screenshot-fixtures/current-preview.js'];
const themeScript=`<script>(()=>{const q=new URLSearchParams(location.search);window.__fixture.store.settings.theme=q.get('theme')||'light';})()</script>`;
await writeFile(join(output,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><script>window.__captureFloatingDefinition={width:244,height:120,preferences:{actions:[],alwaysOnTop:true,showSampleTime:false,showInTray:false,layout:'twoRow',fontSize:16,showGraphs:true,showLabels:true,showStatus:false,snapToEdge:false},preferencesAreCurrentDefaults:true};</script>${scripts.map(f=>`<script src="${fsUrl(f)}"></script>`).join('')}${themeScript}</head><body><div id="root"></div><script type="module" src="${fsUrl('apps/desktop/src/main.tsx')}"></script></body></html>`);
const server=await createServer({configFile:false,envFile:false,root:output,cacheDir:join(output,'.vite'),plugins:[react()],resolve:{alias:{react:join(root,'apps/desktop/node_modules/react'),'react-dom':join(root,'apps/desktop/node_modules/react-dom')}},server:{host:'127.0.0.1',port:0,hmr:false,fs:{allow:[root]}}});
await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.STRATA_BROWSER_EXECUTABLE||'/usr/bin/google-chrome'});
const drafts=(process.env.DRAFTS||'a,b,c').split(',');
const shots=(process.env.SHOTS||'zh-light,zh-dark,zh-narrow,en-light').split(',');
try{for(const d of drafts)for(const s of shots){
  const [lang,mode]=s.split('-');const narrow=mode==='narrow';const theme=mode==='dark'?'dark':'light';const locale=lang==='en'?'en':'zh-CN';
  const ctx=await browser.newContext({viewport:{width:narrow?1100:1440,height:960},deviceScaleFactor:2,locale:lang==='en'?'en-US':'zh-CN',colorScheme:theme});
  const page=await ctx.newPage();const errs=[];page.on('pageerror',e=>errs.push(String(e)));
  await page.goto(`${origin}/index.html?language=${locale}&view=overview&theme=${theme}${d==='base'?'':`&overviewDraft=${d}`}#overview`);
  await page.locator('#pill').waitFor({timeout:20000});await page.waitForFunction(()=>!document.querySelector('.boot'));
  await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(900);
  const ov=await page.evaluate(()=>{const o=[];document.querySelectorAll('.ovd *').forEach(el=>{if(el.scrollWidth>el.clientWidth+2&&getComputedStyle(el).overflowX!=='visible'&&!el.closest('svg'))o.push(el.className+'');});return {doc:document.documentElement.scrollWidth-innerWidth,o:o.slice(0,8)};});
  const file=join(dest,`${d}-${s}.png`);await page.screenshot({path:file,animations:'disabled'});
  // full-height variant for review
  console.log('OK',file,JSON.stringify(ov),errs.join('|'));await ctx.close();
}}finally{await browser.close();await server.close();}
