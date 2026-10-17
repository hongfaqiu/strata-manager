import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, publicPath, site } from './website-seo.mjs';

// The website moved from GitHub Pages (hongfaqiu.github.io/strata-manager/) to Cloudflare. GitHub Pages
// cannot send HTTP redirects, so this publishes one small page per old URL: a canonical link and a meta
// refresh to the new clean URL, plus a script that keeps the query and fragment (?lang=en, #get-started).
// 404.html catches every other old path and maps it the same way.
export const legacyPrefix = '/strata-manager/';

export function redirectPage(target, { title = 'Strata Manager', mapPath = false } = {}) {
  const href = escapeHtml(target);
  const script = mapPath
    ? `var p=location.pathname;if(p.indexOf(${JSON.stringify(legacyPrefix)})===0)p=p.slice(${legacyPrefix.length - 1});location.replace(${JSON.stringify(site.slice(0, -1))}+p.replace(/(^|\\/)index\\.html$/,'$1').replace(/\\.html$/,'')+location.search+location.hash);`
    : `location.replace(${JSON.stringify(target)}+location.search+location.hash);`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} · 已迁移 / Moved</title>
<link rel="canonical" href="${href}">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${href}">
<script>${script}</script>
</head>
<body>
<p>官网已迁移到 <a href="${href}">${href}</a>。The website moved to <a href="${href}">${href}</a>.</p>
</body>
</html>
`;
}

async function htmlFiles(directory, base = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await htmlFiles(path, base));
    else if (entry.name.endsWith('.html') && entry.name !== '404.html') result.push(relative(base, path).split(sep).join(posix.sep));
  }
  return result.sort();
}

/** Writes one redirect per page of the built site (dist/website) into `output`. */
export async function buildLegacyRedirects(website, output) {
  await rm(output, { recursive: true, force: true });
  const pages = await htmlFiles(website);
  for (const page of pages) {
    await mkdir(dirname(join(output, page)), { recursive: true });
    await writeFile(join(output, page), redirectPage(new URL(publicPath(page), site).href));
  }
  await writeFile(join(output, '404.html'), redirectPage(site, { mapPath: true }));
  await writeFile(join(output, '.nojekyll'), '');
  await writeFile(join(output, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${site}sitemap.xml\n`);
  return pages;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pages = await buildLegacyRedirects(join(root, 'dist', 'website'), join(root, 'dist', 'legacy-redirects'));
  console.log(`Legacy redirects: ${pages.length} pages + 404 → ${site}`);
}
