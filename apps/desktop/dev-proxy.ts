import type { Plugin } from 'vite';
import http from 'node:http';
import https from 'node:https';

const ALLOWED_PATHS = new Set([
  '/health', '/api/health', '/v1/status', '/status', '/slots', '/slots/0', '/props',
  '/metrics', '/models', '/v1/models', '/mcp', '/config', '/settings',
  '/load', '/unload', '/v1/load', '/v1/unload', '/v1/vram',
  '/v1/chat/completions', '/v1/messages', '/v1/responses', '/chat', '/api/requests',
]);

/** Mirrors the production bridge's exact relative routes and accepted query shapes. */
export function isStrataProxyRoute(path: string, method = 'GET'): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#%]/.test(path) || path.split('?')[0]!.split('/').some(part => part === '.' || part === '..')) return false;
  const [pathname, query] = path.split('?');
  if (path.split('?').length > 2 || !ALLOWED_PATHS.has(pathname!)) return false;
  if (pathname === '/slots/0') return method === 'POST' && (query === 'action=save' || query === 'action=restore');
  if (pathname === '/v1/vram' && method !== 'POST') return false;
  if (query === undefined) return true;
  if (pathname === '/metrics') return query === 'requests=all';
  if (pathname === '/api/requests') return /^id=[A-Za-z0-9_.:-]{1,256}$/.test(query);
  return false;
}

/** Only used by localhost Vite preview. Production uses the Rust bridge. */
export function strataProxy(): Plugin {
  return {
    name: 'strata-development-proxy',
    configureServer(server) {
      server.middlewares.use('/__strata_proxy', (incoming, outgoing) => {
        try {
          const origin = incoming.headers.origin;
          if (origin && !['http://127.0.0.1:1427', 'http://localhost:1427'].includes(origin)) {
            outgoing.writeHead(403).end(JSON.stringify({ error: { message: 'Origin rejected' } }));
            return;
          }
          const query = new URL(incoming.url ?? '/', 'http://127.0.0.1:1427');
          const base = new URL(query.searchParams.get('baseUrl') ?? '');
          const path = query.searchParams.get('path') ?? '';
          const route = new URL(path, 'http://strata.invalid');
          if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
            || !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
            || !['', '/', '/v1', '/v1/'].includes(base.pathname)
            || query.searchParams.size !== 2 || !query.searchParams.has('baseUrl') || !query.searchParams.has('path')
            || route.origin !== 'http://strata.invalid' || !isStrataProxyRoute(path, incoming.method)) {
            outgoing.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({
              error: { message: 'Browser preview only proxies loopback Strata API routes.' },
            }));
            return;
          }
          const target = new URL(base.toString());
          target.pathname = route.pathname;
          target.search = route.search;
          const transport = target.protocol === 'https:' ? https : http;
          const headers: http.OutgoingHttpHeaders = { Accept: incoming.headers.accept ?? 'application/json' };
          if (incoming.headers.authorization) headers.Authorization = incoming.headers.authorization;
          if (incoming.headers['content-type']) headers['Content-Type'] = incoming.headers['content-type'];
          const upstream = transport.request(target, { method: incoming.method, headers }, response => {
            const responseHeaders: http.OutgoingHttpHeaders = {
              'Content-Type': response.headers['content-type'] ?? 'application/json',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            };
            outgoing.writeHead(response.statusCode ?? 502, responseHeaders);
            response.pipe(outgoing);
          });
          const longControl = ['/load', '/v1/load', '/v1/vram', '/slots/0'].includes(route.pathname);
          upstream.setTimeout(longControl ? 300_000 : 120_000, () => upstream.destroy(new Error('Strata request timed out; the operation outcome is unconfirmed')));
          upstream.on('error', error => {
            if (!outgoing.headersSent) {
              outgoing.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({
                error: { message: error.message },
              }));
            } else outgoing.destroy(error);
          });
          outgoing.on('close', () => upstream.destroy());
          incoming.pipe(upstream);
        } catch {
          outgoing.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            error: { message: 'Invalid Strata connection URL.' },
          }));
        }
      });
    },
  };
}
