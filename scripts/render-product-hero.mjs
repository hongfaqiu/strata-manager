import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
function dependency(name) {
  try { return require(name); } catch (error) {
    if (process.env.CODEX_WORKSPACE_NODE_MODULES) {
      return require(join(process.env.CODEX_WORKSPACE_NODE_MODULES, name));
    }
    throw new Error(`Rendering needs ${name}. Use the bundled workspace dependencies or install it locally.`, { cause: error });
  }
}
const sharp = dependency('sharp');
const { chromium } = dependency('playwright');
const outputDir = join(root, 'docs/screenshots');
const proofDir = join(root, 'output/playwright/product-hero');
await mkdir(proofDir, { recursive: true });

// This source is background art only. All product UI and typography below are
// deterministic; examples come from the real App component screenshots.
if (process.env.STRATA_HERO_GENERATED_BACKGROUND) {
  await sharp(process.env.STRATA_HERO_GENERATED_BACKGROUND)
    .webp({ quality: 96, effort: 6 })
    .toFile(join(root, 'docs/brand/hero-background.webp'));
}

const asDataUrl = async (file) => `data:image/webp;base64,${(await readFile(file)).toString('base64')}`;
const background = await asDataUrl(join(root, 'docs/brand/hero-background.webp'));
const logo = (await readFile(join(root, 'assets/icon.svg'), 'utf8')).replace(/<svg /, '<svg aria-label="Strata Manager" ');
const font = (await readFile(join(root, 'apps/desktop/src/fonts/outfit-latin-wght.woff2'))).toString('base64');
const variants = {
  zh: {
    locale: 'zh-CN', eyebrow: 'STRATA 本地大模型管理工具',
    first: '让 Strata', second: '更容易上手',
    intro: '本地大模型的管理与监控，<br>一个工作台完成。',
    features: ['安装与配置', '模型与服务管理', '资源与 API 用量监控'],
    example: '界面示例 · 展示数据',
  },
  en: {
    locale: 'en', eyebrow: 'A DESKTOP WORKSPACE FOR STRATA LLM',
    first: 'Make Strata', second: 'easier to use',
    intro: 'Manage and monitor local LLMs<br>in one workspace.',
    features: ['Setup & configuration', 'Models & services', 'Resources & API usage'],
    example: 'Example interface · Demonstration data',
  },
};

function html(lang, model, chart) {
  const v = variants[lang];
  return `<!doctype html><html lang="${v.locale}"><head><meta charset="utf-8"><title>Strata Manager product hero ${lang}</title><style>
  @font-face{font-family:Outfit;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:100 900;font-display:block}
  *{box-sizing:border-box}html,body{margin:0;width:1800px;height:1000px;overflow:hidden}
  body{font-family:Outfit,'Microsoft YaHei','Noto Sans CJK SC',sans-serif;color:#173d33;background:#fafcf9}
  main{position:relative;isolation:isolate;width:1800px;height:1000px;background:url('${background}') center/cover no-repeat}
  main::before{content:'';position:absolute;inset:0;z-index:-1;background:linear-gradient(90deg,#fafcf959 0%,#fafcf94d 42%,transparent 70%)}
  .brand{position:absolute;left:78px;top:73px;display:flex;gap:17px;align-items:center}
  .brand svg{width:59px;height:59px;border-radius:14px;box-shadow:0 8px 20px #153b3312}
  .name{font-size:33px;font-weight:650;letter-spacing:-.9px}.name span{font-weight:400}
  .platform{position:absolute;right:78px;top:90px;font-size:21px;letter-spacing:.4px;color:#315e50}
  .copy{position:absolute;left:78px;top:278px;width:700px}
  .eyebrow{display:flex;gap:11px;align-items:center;margin:0 0 25px;color:#238368;font-size:17px;font-weight:520;letter-spacing:${lang === 'zh' ? '1.5' : '1.3'}px}
  .eyebrow::before{content:'';width:8px;height:8px;border-radius:50%;background:#12b68b}
  h1{margin:0;font-size:${lang === 'zh' ? '78' : '82'}px;line-height:1.17;font-weight:640;letter-spacing:${lang === 'zh' ? '-2' : '-2.8'}px}
  h1 span{display:block;color:#0b8668}
  .intro{margin:32px 0 0;color:#49695d;font-size:29px;line-height:1.5;font-weight:400;letter-spacing:-.25px}
  ul{list-style:none;padding:0;margin:40px 0 0;display:grid;gap:19px;font-size:23px;color:#315f4f}
  li{display:flex;align-items:center;gap:13px}
  .check{display:flex;align-items:center;justify-content:center;width:25px;height:25px;border-radius:50%;color:#118465;background:#d8f3e7;font-size:16px;font-weight:550}
  .product{position:absolute;left:792px;top:266px;width:930px;margin:0}
  .caption{margin:0 0 14px 7px;font-size:17px;font-weight:420;color:#4b7565}
  .screen{border:1px solid #d5e6dc;border-radius:18px;overflow:hidden;background:#fff;box-shadow:0 28px 65px -20px #153d332a,0 0 0 7px #ffffff65}
  .screen img{display:block;width:100%;height:auto}
  .chart{position:absolute;left:1222px;top:570px;width:500px;margin:0;box-shadow:0 25px 65px -18px #163e333b,0 0 0 6px #ffffff65;border-radius:17px;overflow:hidden;border:1px solid #d6e7dc;background:#fff}
  .chart img{display:block;width:100%;height:auto}
  .footer{position:absolute;left:78px;bottom:70px;display:flex;align-items:center;gap:13px;color:#527261;font-size:20px;font-weight:410}
  .footer svg{width:20px;height:20px;color:#4f7968}
  </style></head><body><main aria-label="Strata Manager ${lang === 'zh' ? '产品介绍' : 'product introduction'}">
  <div class="brand">${logo}<div class="name">Strata <span>Manager</span></div></div>
  <div class="platform">Windows / Linux</div>
  <section class="copy"><p class="eyebrow">${v.eyebrow}</p><h1>${v.first}<span>${v.second}</span></h1><p class="intro">${v.intro}</p><ul>${v.features.map(t=>`<li><span class="check">✓</span>${t}</li>`).join('')}</ul></section>
  <figure class="product"><figcaption class="caption">${v.example}</figcaption><div class="screen"><img src="${model}" alt="${lang === 'zh' ? '真实模型管理界面' : 'Real model management interface'}"></div></figure>
  <figure class="chart"><img src="${chart}" alt="${lang === 'zh' ? '真实 API 请求趋势界面' : 'Real API request trend interface'}"></figure>
  <div class="footer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18 3 12l6-6M15 6l6 6-6 6"/></svg><span>Open source</span></div>
  </main></body></html>`;
}

const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>Strata Manager hero renderer</title>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.STRATA_BROWSER_EXECUTABLE ? { executablePath: process.env.STRATA_BROWSER_EXECUTABLE } : {}) });
const results = [];
try {
  for (const lang of ['zh', 'en']) {
    // Crop only unused lower canvas from the models screen; no product UI is
    // fabricated, retouched, translated or changed. The second insert is a
    // complete request trend card from the matching language's API usage page.
    const model = await sharp(join(outputDir, `models.${lang}.webp`))
      .extract({ left: 0, top: 0, width: 2880, height: 1180 })
      .webp({ lossless: true }).toBuffer();
    const chart = await sharp(join(outputDir, `usage.${lang}.webp`))
      .extract({ left: 503, top: 747, width: 1140, height: 860 })
      .webp({ lossless: true }).toBuffer();
    const source = html(lang, `data:image/webp;base64,${model.toString('base64')}`, `data:image/webp;base64,${chart.toString('base64')}`);
    await writeFile(join(proofDir, `product-cover.${lang}.html`), source);
    const context = await browser.newContext({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'light' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.setContent(source, { waitUntil: 'load' });
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode())); });
    const layout = await page.evaluate(() => ({
      width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      overflow: document.documentElement.scrollWidth > innerWidth,
      fontsLoaded: document.fonts.check('82px Outfit'),
      imagesLoaded: [...document.images].every(i => i.complete && i.naturalWidth > 0),
      copyBounds: document.querySelector('.copy').getBoundingClientRect().toJSON(),
      chartBounds: document.querySelector('.chart').getBoundingClientRect().toJSON(),
    }));
    if (errors.length || layout.overflow || !layout.fontsLoaded || !layout.imagesLoaded || layout.copyBounds.bottom > 900 || layout.chartBounds.bottom > 980) {
      throw new Error(JSON.stringify({ lang, layout, errors }));
    }
    const png = join(proofDir, `product-cover.${lang}.png`);
    await page.screenshot({ path: png, animations: 'disabled', scale: 'device' });
    const file = join(outputDir, `product-cover.${lang}.webp`);
    await sharp(png).webp({ quality: 95, effort: 6 }).toFile(file);
    const data = await readFile(file);
    const metadata = await sharp(data).metadata();
    results.push({ lang, file: `product-cover.${lang}.webp`, width: metadata.width, height: metadata.height, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), layout, errors });
    await context.close();
  }
  // Compatibility alias for existing external links and README consumers.
  await copyFile(join(outputDir, 'product-cover.en.webp'), join(outputDir, 'product-cover.webp'));
  await writeFile(join(proofDir, 'validation.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
