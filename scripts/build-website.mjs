import { cp, mkdir, readdir, rm, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documents, renderWebsiteDocs, verifyStaticWebsite } from './render-website-docs.mjs';
import { renderWebsiteSeo } from './website-seo.mjs';

// Publish static assets and pre-rendered docs, without a browser-side runtime.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'website');
const output = join(root, 'dist', 'website');
const existing = await lstat(output).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
if (output !== resolve(root, 'dist', 'website') || existing?.isSymbolicLink()) {
  throw new Error('Refusing to replace an unexpected website output path.');
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
await mkdir(join(output, 'assets', 'screenshots'), { recursive: true });
await cp(join(root, 'assets', 'icon.svg'), join(output, 'assets', 'icon.svg'));
const screenshots = await readdir(join(root, 'docs', 'screenshots'));
for (const filename of screenshots.filter((name) => name.endsWith('.webp'))) {
  await cp(join(root, 'docs', 'screenshots', filename), join(output, 'assets', 'screenshots', filename));
}
await writeFile(join(output, '.nojekyll'), '');
const documentCount = await renderWebsiteDocs(output);
await renderWebsiteSeo(output, documents);
const checked = await verifyStaticWebsite(output);
console.log(`Static website ready: ${output} (${documentCount} documents; ${checked.localTargets} local links/assets verified)`);
