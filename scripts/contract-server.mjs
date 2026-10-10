/** Deterministic Strata protocol fixture for acceptance checks. No model inference. */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

// Source: serve/runconfig.py EDITABLE. Values absent from config are null, not invented defaults.
const editable = [
  ['sampling.temperature', 'number', 'Default temperature for requests that send none (0 = greedy, the default without a sampling block)'],
  ['sampling.top_p', 'number', 'Default top_p for requests that send none'],
  ['sampling.top_k', 'number', 'Default top_k for requests that send none (1-64)'],
  ['sampling.min_p', 'number', 'Default min_p for requests that send none'],
  ['reasoning_budget_tokens', 'number', 'Cap the thinking of every request at this many tokens (0 or empty: no cap)'],
  ['fit_max_tokens', 'bool', 'Shorten a max_tokens that does not fit the context instead of answering 400'],
  ['anthropic_thinking', 'enum', 'Anthropic requests that do not ask for thinking: think as the model does (model) or not (on_request)', ['model', 'on_request']],
  ['effort_position', 'enum', 'Where a non-default reasoning effort goes: start (the default) or end (keeps the cache when it changes)', ['start', 'end']],
  ['aliases', 'names', 'Other model names the server lists and answers to (comma-separated)'],
  ['idle_unload_s', 'number', 'Unload the model after this many seconds without requests (0 or empty: never)'],
  ['lazy_load', 'bool', 'Start without loading the model; the first request loads it (text only)'],
  ['engine_silence_s', 'number', 'End a request when the engine says nothing for this long (default 300 s, 0 = wait)'],
  ['api_monitor', 'bool', "Keep the last 100 requests' prompts and answers in memory for /api-monitor"],
  ['open_browser', 'bool', 'Open the chat page in the browser when the model is ready'],
  ['vram_reserve_mib', 'number', 'VRAM in MiB the engine leaves free for other programs (engine default 700)'],
];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const tokens = text => Array.from(text).length; // Fixture code points, NOT a model tokenizer.
const valueOf = (cfg, key) => {
  if (key.startsWith('sampling.')) return cfg.sampling?.[key.slice(9)] ?? null;
  if (key === 'vram_reserve_mib') {
    const index = cfg.args?.indexOf('--vram-reserve-mib') ?? -1;
    return index >= 0 && index < cfg.args.length - 1 ? Number(cfg.args[index + 1]) : null;
  }
  return cfg[key] ?? null;
};
export function configView(cfg) {
  return { file: 'strata-protocol-fixture.json', keys: editable.map(([key, kind, help, choices]) => ({ key, kind, help, value: valueOf(cfg, key), ...(choices ? { choices } : {}) })),
    note: 'Saved to the run config; used from the next start of the model. Fixture only: configuration is held in memory.' };
}
export function applyConfig(cfg, changes) {
  if (!object(changes) || !Object.keys(changes).length) throw new Error('send {"set": {"<key>": <value or null>, ...}}');
  const checked = Object.entries(changes).map(([key, raw]) => {
    const spec = editable.find(item => item[0] === key);
    if (!spec) throw new Error(`${key} cannot be changed here (only the keys the Settings view lists)`);
    if (raw === null) return [key, null];
    let value = raw;
    if (spec[1] === 'bool' && typeof value !== 'boolean') throw new Error(`${key}: expected true or false`);
    if (spec[1] === 'enum' && !spec[3].includes(value)) throw new Error(`${key}: expected one of ${spec[3].join(', ')}`);
    if (spec[1] === 'names') {
      if (typeof value === 'string') value = value.split(',').map(name => name.trim()).filter(Boolean);
      if (!Array.isArray(value) || !value.every(name => typeof name === 'string' && name.trim() && name.length <= 128)) throw new Error(`${key}: expected a list of model names`);
      if (!value.length) value = null;
    }
    if (spec[1] === 'number') {
      const whole = ['sampling.top_k', 'reasoning_budget_tokens', 'vram_reserve_mib'].includes(key);
      const lo = key === 'sampling.top_k' ? 1 : 0;
      const hi = key === 'sampling.top_k' ? 64 : ['sampling.top_p', 'sampling.min_p'].includes(key) ? 1 : Infinity;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi || (whole && !Number.isInteger(value)) || (key === 'sampling.top_p' && value === 0)) throw new Error(`${key}: invalid numeric value`);
    }
    if (key === 'lazy_load' && value && cfg.vision) throw new Error('lazy_load: lazy loading is text-only, and this model reads images ("vision")');
    return [key, value];
  });
  const result = structuredClone(cfg), changed = [];
  for (const [key, value] of checked) {
    if (JSON.stringify(valueOf(result, key)) === JSON.stringify(value)) continue;
    if (key.startsWith('sampling.')) {
      const sampling = { ...result.sampling };
      if (value === null) delete sampling[key.slice(9)]; else sampling[key.slice(9)] = value;
      if (Object.keys(sampling).length) result.sampling = sampling; else delete result.sampling;
    } else if (key === 'vram_reserve_mib') {
      const args = [...(result.args ?? [])], index = args.indexOf('--vram-reserve-mib');
      if (index >= 0 && index < args.length - 1) args.splice(index, 2, ...(value === null ? [] : ['--vram-reserve-mib', String(value)]));
      else if (value !== null) args.push('--vram-reserve-mib', String(value));
      result.args = args;
    } else if (value === null) delete result[key]; else result[key] = value;
    changed.push(key);
  }
  return { config: result, changed };
}

const port = Number(process.env.STRATA_CONTRACT_PORT ?? 18091);
let loaded = false;
let active = 0;
let cancelled = 0;
let generation = 0;
let config = { context: 32768, parallel: 1, lazy_load: true, api_monitor: false };
let defaults = null;
const retained = [];
const history = [];
const inFlight = new Set();
const started = Date.now() / 1000;
let lastRequestAt = null;
const totals = { since: started, requests: 0, prompt_tokens: 0, reused: 0, output_tokens: 0, prompt_ms: 0, decode_ms: 0, drafts_offered: 0, drafts_accepted: 0 };
const publicRecord = entry => Object.fromEntries(Object.entries(entry).filter(([key]) => !key.startsWith('_')));
const json = (response, status, data) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
};
export const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  let body = {};
  if (request.method === 'POST') {
    let text = '';
    for await (const chunk of request) text += chunk;
    try { body = text ? JSON.parse(text) : {}; } catch { return json(response, 400, { error: { message: 'Invalid JSON' } }); }
    if (!object(body)) return json(response, 400, { error: { type: 'invalid_request_error', message: 'Expected a JSON object' } });
  }
  if (url.pathname === '/__contract/state') return json(response, 200, { loaded, active, cancelled, generation, token_unit: 'Unicode code points (fixture only; not model tokens)' });
  if (url.pathname === '/health' || url.pathname === '/api/health') {
    return json(response, 200, { status: 'ok', service: 'strata', loaded, model: 'protocol-fixture', images: true, max_context: 32768 });
  }
  if (url.pathname === '/v1/status') return json(response, 200, {
    service: 'strata', loaded, auto_load: true, model: 'protocol-fixture', engine: 'contract-fixture',
    started: Math.floor(started), uptime_s: Math.floor(Date.now() / 1000 - started),
    cache_max_tokens: 32768, context: { native: 32768, max_positions: 32768 },
    concurrency: { serving: 1, requested: 1 }, dialects: ['/v1/chat/completions'],
    vision: { enabled: true, available: true, error: null },
    activity: { requests: totals.requests + active, in_flight: active, last_request_at: lastRequestAt == null ? null : Math.floor(lastRequestAt) },
    last_timings: null, machine: { at: Math.floor(Date.now() / 1000), gpu: null, ram: null },
  });
  if (url.pathname === '/props') return json(response, 200, { n_ctx: 32768, total_slots: 1, is_sleeping: !loaded, default_generation_settings: defaults ?? {} });
  if (url.pathname === '/v1/models' || url.pathname === '/models') return json(response, 200, { data: [{ id: 'protocol-fixture', object: 'model', status: loaded ? 'loaded' : 'unloaded' }] });
  if (url.pathname === '/metrics') {
    const current = [...inFlight].at(-1);
    return json(response, 200, {
      live: { state: !loaded ? 'unloaded' : current ? current.first_token_s === null ? 'reading' : 'generating' : 'idle', queued: 0,
        prompt_tokens: current?._promptTokens ?? null, generated: current ? tokens(current.output + current.reasoning) : null,
        max_tokens: current?._maxTokens ?? null, elapsed_s: current ? (performance.now() - current._clock) / 1000 : null,
        prompt_read: null, prompt_total: null, tok_s: null, tok_s_mean: null, prefill_tok_s_mean: null },
      engine: { model: 'protocol-fixture', images: true, max_context: 32768, version: 'contract-fixture', fixture_token_unit: 'Unicode code points; no model inference' },
      hardware: {}, hardware_static: {}, history: {},
      requests: history.slice(0, url.searchParams.get('requests') === 'all' ? undefined : 12),
      requests_kept: history.length, totals, time: Date.now() / 1000,
    });
  }
  if (url.pathname === '/mcp') return json(response, 200, { servers: [], tools: 0 });
  if (url.pathname === '/settings') {
    if (request.method === 'POST') {
      if (body.defaults !== null && !object(body.defaults)) return json(response, 400, { error: { type: 'invalid_request_error', message: 'defaults must be an object or null' } });
      defaults = body.defaults ?? null;
    }
    return json(response, 200, { shared: defaults !== null && Object.keys(defaults).length > 0, defaults: defaults ?? {} });
  }
  if (url.pathname === '/config') {
    if (request.method !== 'POST') return json(response, 200, configView(config));
    try {
      const applied = applyConfig(config, body.set);
      config = applied.config;
      return json(response, 200, { ...configView(config), changed: applied.changed });
    } catch (error) { return json(response, 400, { error: { type: 'invalid_request_error', message: error.message } }); }
  }
  if (['/load', '/unload', '/v1/load', '/v1/unload'].includes(url.pathname)) {
    if (active) return json(response, 409, { error: { message: 'Model is busy', code: 'model_busy' } });
    loaded = !url.pathname.endsWith('unload');
    return json(response, 200, { loaded, status: loaded ? 'loaded' : 'unloaded' });
  }
  if (url.pathname === '/api/requests') {
    if (!config.api_monitor) return json(response, 404, { error: { message: 'API monitor disabled' } });
    const id = url.searchParams.get('id');
    if (id) {
      const record = retained.find(item => item.id === id);
      return record ? json(response, 200, publicRecord(record)) : json(response, 404, { error: { message: 'request no longer retained' } });
    }
    const records = retained.map(entry => Object.fromEntries(Object.entries(publicRecord(entry)).filter(([key]) => !['input', 'output', 'reasoning', 'response'].includes(key))));
    return json(response, 200, { requests: records.map(record => ({ ...record, wallclock_s: record.wallclock_s ?? (Date.now() / 1000 - record.started_at) })), retention: 100, persistent: false, loaded, auto_load: true });
  }
  if (url.pathname === '/v1/chat/completions' || url.pathname === '/chat') {
    generation++;
    const input = JSON.stringify(body, null, 2);
    const prompt = JSON.stringify(body.messages ?? []);
    const entry = { id: `fixture-${generation}`, started_at: Date.now() / 1000, state: 'queued', path: url.pathname, model: body.model ?? 'protocol-fixture', stream: true,
      response_format: object(body.response_format) ? body.response_format.type ?? null : null,
      input: input.slice(0, 262144), input_truncated: input.length > 262144,
      output: '', reasoning: '', output_truncated: false, reasoning_truncated: false,
      queue_s: 0, load_s: 0, first_token_s: null, _clock: performance.now(), _promptTokens: tokens(prompt), _maxTokens: body.max_tokens ?? null };
    if (config.api_monitor) { retained.unshift(entry); retained.splice(100); }
    lastRequestAt = entry.started_at;
    if (prompt.includes('/error')) {
      const error = { message: 'Deliberate protocol test failure', code: 'fixture_error' };
      Object.assign(entry, { state: 'error', error, http_status: 502, response: JSON.stringify({ error }), response_truncated: false, wallclock_s: (performance.now() - entry._clock) / 1000, finished_at: Date.now() / 1000 });
      return json(response, 502, { error });
    }
    loaded = true;
    active++;
    inFlight.add(entry);
    entry.state = 'generating'; entry.http_status = 200;
    let finished = false;
    const finish = outcome => {
      if (finished) return;
      finished = true; active--; inFlight.delete(entry);
      const elapsed = (performance.now() - entry._clock) / 1000;
      entry.state = outcome === 'stop' ? 'completed' : 'disconnected';
      entry.outcome = entry.state; entry.wallclock_s = elapsed; entry.finished_at = Date.now() / 1000;
      const count = tokens(entry.output + entry.reasoning);
      entry.usage = { prompt_tokens: entry._promptTokens, completion_tokens: count, total_tokens: entry._promptTokens + count };
      const record = { time: entry.started_at, duration_s: Math.round(elapsed * 10) / 10, finish: outcome, projection: null,
        prompt_tokens: entry.usage.prompt_tokens, prompt_total: entry.usage.prompt_tokens, prompt_read: null, reused: 0, output_tokens: count,
        prompt_ms: null, decode_ms: null, engine_generated: null, decode_tok_s: null, hit_rate: null, pcie_share: null,
        ram_blobs: null, file_blobs: null, file_mb: null, drafts_offered: null, drafts_accepted: null };
      history.unshift(record); history.splice(500);
      totals.requests++; totals.prompt_tokens += record.prompt_tokens; totals.reused += record.reused; totals.output_tokens += record.output_tokens;
      // Upstream aggregates only reported engine timing/drafts; this fixture has no engine.
      totals.prompt_ms += record.prompt_ms ?? 0; totals.decode_ms += record.decode_ms ?? 0;
      lastRequestAt = entry.finished_at;
    };
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const chunks = [
      { choices: [{ delta: { role: 'assistant', reasoning_content: '这是协议验收，' } }] },
      { choices: [{ delta: { reasoning_content: '并未运行真实模型。' } }] },
      { choices: [{ delta: { content: '连接与流式输出正常。\n\n' } }] },
      { choices: [{ delta: { content: '**Strata Manager** 已收到中文内容和独立思考字段。\n\n' } }] },
      { choices: [{ delta: { content: '```ts\nconst ready = true;\n```' } }] },
    ];
    let index = 0;
    const timer = setInterval(() => {
      if (index < chunks.length) {
        const chunk = chunks[index++];
        entry.output += chunk.choices[0].delta.content ?? '';
        entry.reasoning += chunk.choices[0].delta.reasoning_content ?? '';
        entry.first_token_s ??= (performance.now() - entry._clock) / 1000;
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      } else {
        finish('stop');
        clearInterval(timer);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: entry.usage })}\n\n`);
        response.end('data: [DONE]\n\n');
      }
    }, 220);
    response.on('close', () => {
      clearInterval(timer);
      if (!finished) { cancelled++; finish('disconnect'); }
    });
    return;
  }
  json(response, 404, { error: { message: `Unknown fixture route: ${url.pathname}` } });
});
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Protocol fixture (no inference; code-point tokens): http://127.0.0.1:${port}\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
