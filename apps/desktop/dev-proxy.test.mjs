import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
import http from 'node:http';

const source = await readFile(new URL('./dev-proxy.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { isStrataProxyRoute, strataProxy } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('only slot 0 save/restore POST queries are allowed', () => {
  for (const path of ['/slots/0?action=save', '/slots/0?action=restore']) {
    assert.equal(isStrataProxyRoute(path, 'POST'), true);
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal(isStrataProxyRoute(path, method), false);
  }
  for (const path of ['/slots/0', '/slots/1?action=save', '/slots/00?action=restore', '/slots/0/?action=save', '/slots/0?action=erase', '/slots/0?action=save&action=restore', '/slots/0?%61ction=save', '/slots/0?action=%73ave', '/slots/0?action=save&path=outside', '/slots/0?action=save?', '//localhost/slots/0?action=save', '/slots/../slots/0?action=save', '/slots/0?action=save#x']) assert.equal(isStrataProxyRoute(path, 'POST'), false, path);
  assert.equal(isStrataProxyRoute('/metrics?requests=all'), true);
  assert.equal(isStrataProxyRoute('/api/requests?id=req-123'), true);
  assert.equal(isStrataProxyRoute('/metrics?format=prometheus'), false);
  assert.equal(isStrataProxyRoute('/health?url=https://evil'), false);
  assert.equal(isStrataProxyRoute('/v1/messages/count_tokens', 'POST'), true);
  assert.equal(isStrataProxyRoute('/v1/messages/count_tokens?url=https://evil', 'POST'), false);
});

test('fixture proxy preserves the exact action and JSON body without forwarding an Origin', async () => {
  let seen;
  const upstream = http.createServer(async (incoming, outgoing) => {
    let body = ''; for await (const chunk of incoming) body += chunk;
    seen = { url: incoming.url, method: incoming.method, body: JSON.parse(body), origin: incoming.headers.origin };
    outgoing.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id_slot: 0, filename: 'fixture.bin', n_restored: 12, n_read: 128 }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let middleware;
  strataProxy().configureServer({ middlewares: { use: (_path, handler) => { middleware = handler; } } });
  const preview = http.createServer((incoming, outgoing) => middleware(incoming, outgoing));
  await new Promise(resolve => preview.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`, path = '/slots/0?action=restore';
    const proxy = `http://127.0.0.1:${preview.address().port}/?baseUrl=${encodeURIComponent(baseUrl)}&path=${encodeURIComponent(path)}`;
    const response = await fetch(proxy, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'fixture.bin' }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).n_restored, 12);
    assert.deepEqual(seen, { url: path, method: 'POST', body: { filename: 'fixture.bin' }, origin: undefined });
    const refused = await fetch(proxy.replace(encodeURIComponent(path), encodeURIComponent('/slots/1?action=restore')), { method: 'POST' });
    assert.equal(refused.status, 400);
  } finally {
    preview.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => preview.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
});
