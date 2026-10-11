import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { apiConnection, apiCodeExample, bashLiteral, claudeCodeLaunch, openCodeConfig, powerShellLiteral } from './apiIntegration.ts';

const specialModel = 'local/模型 "quoted" \'single\' \\path\n$(danger); `code`';

test('copied /v1 addresses produce exactly one OpenAI prefix and an Anthropic root', () => {
  for (const address of ['http://127.0.0.1:8123', 'http://127.0.0.1:8123/v1', 'http://127.0.0.1:8123/v1/']) {
    const connection = apiConnection(address, 'local-model');
    assert.equal(connection.rootUrl, 'http://127.0.0.1:8123');
    assert.equal(JSON.parse(openCodeConfig(connection)).provider.strata.options.baseURL, 'http://127.0.0.1:8123/v1');
    assert.match(claudeCodeLaunch(connection, 'powershell'), /ANTHROPIC_BASE_URL = 'http:\/\/127\.0\.0\.1:8123'/);
    assert.doesNotMatch(apiCodeExample(connection, 'curl'), /\/v1\/v1/);
  }
});

test('missing models and invalid or credential-bearing service addresses cannot generate configs', () => {
  for (const model of [undefined, '', ' \n ']) assert.equal(apiConnection('http://localhost:8080', model), null);
  for (const address of ['https://example.com', 'http://user:secret@localhost:8080', 'http://localhost:8080?token=secret', 'http://localhost:8080/other']) assert.equal(apiConnection(address, 'model'), null);
  assert.throws(() => apiCodeExample({ rootUrl: 'http://localhost:8080', model: '' }, 'python'));
});

test('OpenCode JSON preserves special model IDs without inserting credentials', () => {
  const config = JSON.parse(openCodeConfig(apiConnection('http://localhost:9000/v1', specialModel, true)));
  assert.equal(config.model, 'strata/local-model');
  assert.equal(config.provider.strata.models['local-model'].id, specialModel);
  assert.equal(config.provider.strata.options.apiKey, '{env:STRATA_API_KEY}');
});

test('JavaScript example executes with a stub client and preserves the exact model', async () => {
  const calls = [];
  const source = apiCodeExample(apiConnection('http://localhost:9000', specialModel), 'javascript').replace('import OpenAI from "openai";', '');
  class OpenAI {
    constructor(options) { calls.push(options); this.chat = { completions: { create: async body => { calls.push(body); return { choices: [{ message: { content: 'ok' } }] }; } } }; }
  }
  await runInNewContext(`(async () => { ${source} })()`, { OpenAI, process: { env: {} }, console: { log() {} } });
  assert.equal(calls[0].baseURL, 'http://localhost:9000/v1');
  assert.equal(calls[1].model, specialModel);
});

test('Python and shell examples keep dynamic values in correctly quoted literals', () => {
  const connection = apiConnection('http://localhost:9000', specialModel, false);
  const python = apiCodeExample(connection, 'python');
  assert.equal(JSON.parse(python.match(/^    model=(.+),$/m)[1]), specialModel);
  assert.equal(JSON.parse(python.match(/base_url=("[^"]+")/)[1]), 'http://localhost:9000/v1');
  const powershell = apiCodeExample(connection, 'powershell');
  const payload = powershell.split("$body = @'\n")[1].split("\n'@")[0];
  assert.equal(JSON.parse(payload).model, specialModel);
  assert.match(powershell, /STRATA_API_KEY = 'strata-local'/);
  assert.ok(powerShellLiteral(specialModel).includes("''single''"));
  assert.ok(bashLiteral(specialModel).includes(`'"'"'single'"'"'`));
  for (const line of apiCodeExample(connection, 'curl').split('\n').slice(1, 4)) assert.equal(line.match(/\\+$/)?.[0], '\\');
});
