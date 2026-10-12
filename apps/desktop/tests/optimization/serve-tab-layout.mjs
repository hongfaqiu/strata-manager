import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Reserve an OS-assigned port so this replay never shares another agent's Vite server.
const probe = createNetServer();
await new Promise((accept, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', accept); });
const port = probe.address().port;
await new Promise((accept, reject) => probe.close(error => error ? reject(error) : accept()));
const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root] } }, clearScreen: false });
await server.listen();
console.log(JSON.stringify({ origin: `http://127.0.0.1:${port}`, fixture: '/benchmark-app.html', scope: 'Real React App with synthetic native IO; no real service, GPU, or updater mutations.' }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
