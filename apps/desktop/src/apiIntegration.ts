export interface ApiConnection {
  rootUrl: string;
  model: string;
  keyRequired?: boolean;
}

export type ApiCodeExample = 'powershell' | 'curl' | 'python' | 'javascript';
export type ApiShell = 'powershell' | 'bash';

export const apiIntegrationDocs = {
  cherry: 'https://cherryai.com/docs/en/pre-basic/settings/providers/',
  opencode: 'https://opencode.ai/docs/providers/#custom-provider',
  claude: 'https://code.claude.com/docs/en/env-vars',
  cursor: 'https://docs.cursor.com/guides/using-models',
  codex: 'https://github.com/openai/codex',
} as const;

export const powerShellLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const bashLiteral = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const json = (value: unknown) => JSON.stringify(value);
const keyPlaceholder = (connection: ApiConnection) => connection.keyRequired === false ? 'strata-local' : 'YOUR_STRATA_API_KEY';
const body = (connection: ApiConnection) => ({ model: connection.model, messages: [{ role: 'user', content: 'Hello!' }], max_tokens: 512 });

export function apiConnection(baseUrl: string, model: string | undefined, keyRequired?: boolean): ApiConnection | null {
  if (!model?.trim()) return null;
  let url: URL;
  try { url = new URL(baseUrl.trim()); } catch { return null; }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname)) return null;
  return { rootUrl: url.origin, model, keyRequired };
}

function serviceRoot(connection: ApiConnection): string {
  const validated = apiConnection(connection.rootUrl, connection.model, connection.keyRequired);
  if (!validated) throw new Error('A valid local service address and model ID are required.');
  return validated.rootUrl;
}

/** Generated examples contain placeholders only, never stored profile credentials. */
export function apiCodeExample(connection: ApiConnection, example: ApiCodeExample): string {
  const baseUrl = `${serviceRoot(connection)}/v1`;
  const payload = body(connection);
  if (example === 'powershell') return [
    `$env:STRATA_API_KEY = ${powerShellLiteral(keyPlaceholder(connection))}`,
    `$body = @'`, JSON.stringify(payload, null, 2), `'@`,
    `Invoke-RestMethod -Uri ${powerShellLiteral(`${baseUrl}/chat/completions`)} -Method Post -ContentType 'application/json' -Headers @{ Authorization = "Bearer $env:STRATA_API_KEY" } -Body ([Text.Encoding]::UTF8.GetBytes($body))`,
  ].join('\n');
  if (example === 'curl') return [
    `export STRATA_API_KEY=${bashLiteral(keyPlaceholder(connection))}`,
    `curl ${bashLiteral(`${baseUrl}/chat/completions`)} \\`,
    `  -H "Authorization: Bearer $STRATA_API_KEY" \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  --data-raw ${bashLiteral(json(payload))}`,
  ].join('\n');
  if (example === 'python') return [
    '# pip install openai', 'import os', 'from openai import OpenAI', '',
    `client = OpenAI(base_url=${json(baseUrl)}, api_key=os.environ.get("STRATA_API_KEY", ${json(keyPlaceholder(connection))}))`,
    'response = client.chat.completions.create(',
    `    model=${json(connection.model)},`, '    messages=[{"role": "user", "content": "Hello!"}],', '    max_tokens=512,', ')',
    'print(response.choices[0].message.content)',
  ].join('\n');
  return [
    '// npm install openai', '// Save as strata-api.mjs; run: node strata-api.mjs', 'import OpenAI from "openai";', '',
    'const client = new OpenAI({', `  baseURL: ${json(baseUrl)},`, `  apiKey: process.env.STRATA_API_KEY ?? ${json(keyPlaceholder(connection))},`, '});',
    'const response = await client.chat.completions.create({', `  model: ${json(connection.model)},`, '  messages: [{ role: "user", content: "Hello!" }],', '  max_tokens: 512,', '});',
    'console.log(response.choices[0].message.content);',
  ].join('\n');
}

export function openCodeConfig(connection: ApiConnection): string {
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: 'strata/local-model',
    provider: {
      strata: {
        npm: '@ai-sdk/openai-compatible', name: 'Strata (local)',
        options: { baseURL: `${serviceRoot(connection)}/v1`, apiKey: '{env:STRATA_API_KEY}' },
        models: { 'local-model': { id: connection.model, name: connection.model } },
      },
    },
  }, null, 2);
}

export function openCodeLaunch(connection: ApiConnection, shell: ApiShell): string {
  serviceRoot(connection);
  return shell === 'powershell'
    ? `$env:STRATA_API_KEY = ${powerShellLiteral(keyPlaceholder(connection))}\nopencode`
    : `export STRATA_API_KEY=${bashLiteral(keyPlaceholder(connection))}\nopencode`;
}

export function claudeCodeLaunch(connection: ApiConnection, shell: ApiShell): string {
  const values: Record<string, string> = {
    ANTHROPIC_BASE_URL: serviceRoot(connection),
    ANTHROPIC_AUTH_TOKEN: keyPlaceholder(connection),
    ANTHROPIC_MODEL: connection.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: connection.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: connection.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: connection.model,
  };
  const lines = Object.entries(values).map(([key, value]) => shell === 'powershell' ? `$env:${key} = ${powerShellLiteral(value)}` : `export ${key}=${bashLiteral(value)}`);
  return [...lines, 'claude'].join('\n');
}

export function cursorEnvConfig(connection: ApiConnection, shell: ApiShell): string {
  const root = serviceRoot(connection);
  const values: Record<string, string> = {
    OPENAI_BASE_URL: `${root}/v1`,
    OPENAI_API_KEY: keyPlaceholder(connection),
    OPENAI_MODEL: connection.model,
  };
  return Object.entries(values)
    .map(([key, value]) => shell === 'powershell' ? `$env:${key} = ${powerShellLiteral(value)}` : `export ${key}=${bashLiteral(value)}`)
    .concat(['cursor .'])
    .join('\n');
}

export function codexConfigToml(connection: ApiConnection): string {
  const root = serviceRoot(connection);
  return [
    '# ~/.codex/config.toml — merge carefully; keep existing sections',
    'model_provider = "strata"',
    `model = ${json(connection.model)}`,
    '',
    '[model_providers.strata]',
    'name = "Strata (local)"',
    `base_url = ${json(`${root}/v1`)}`,
    'env_key = "STRATA_API_KEY"',
    'wire_api = "chat"',
  ].join('\n');
}

export function codexLaunch(connection: ApiConnection, shell: ApiShell): string {
  serviceRoot(connection);
  return shell === 'powershell'
    ? `$env:STRATA_API_KEY = ${powerShellLiteral(keyPlaceholder(connection))}\ncodex`
    : `export STRATA_API_KEY=${bashLiteral(keyPlaceholder(connection))}\ncodex`;
}
