import type { ServiceKeyCopyOutcome, ServiceSharingStatus } from '@strata-manager/core';
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

export type ServiceKeyCopyAvailability = {
  enabled: boolean;
  outcome: ServiceKeyCopyOutcome;
  hintZh: string;
  hintEn: string;
};

/** Whether the Connect API dialog can copy the hosted service key. Never includes the key itself. */
export function serviceKeyCopyAvailability(input: {
  keyRequired?: boolean;
  sharing?: Pick<ServiceSharingStatus, 'hasServerKey' | 'keyCount' | 'noKeyChosen' | 'restartRequired' | 'running'> | null;
  sharingError?: boolean;
  loading?: boolean;
}): ServiceKeyCopyAvailability {
  const hint = (hintZh: string, hintEn: string, outcome: ServiceKeyCopyOutcome, enabled = false): ServiceKeyCopyAvailability => ({ enabled, outcome, hintZh, hintEn });
  if (input.keyRequired === false) {
    return hint('当前服务不需要密钥。客户端必填时写 strata-local。', 'The current service does not require a key. Use strata-local if a client asks for one.', 'keyless');
  }
  if (input.loading) {
    return hint('正在确认服务密钥状态…', 'Checking whether a service key is available…', 'unavailable');
  }
  if (input.sharingError) {
    return hint('仅本应用托管的服务可以复制当前服务密钥。', 'The current service key can be copied only for a service this app is hosting.', 'not_owned');
  }
  const sharing = input.sharing;
  if (!sharing) {
    return hint('尚未确认是否有可复制的服务密钥。', 'It is not yet confirmed whether a service key can be copied.', 'unavailable');
  }
  if (!sharing.running) {
    return hint('服务未运行，没有正在使用的服务密钥。请先启动托管服务，再复制。', 'The service is not running, so there is no key in use. Start the hosted service, then copy.', 'not_running');
  }
  if (sharing.restartRequired) {
    return hint('配置在启动后已更改，无法确认运行中服务仍使用这份密钥。请先重启服务，再复制。', 'The configuration changed after start, so this key may not be the one the running service is using. Restart the service, then copy.', 'stale');
  }
  if (sharing.noKeyChosen) {
    return hint('当前配置明确不使用服务端密钥（api_key 为 none）。', 'This configuration serves without a key on purpose (api_key is none).', 'none_chosen');
  }
  if (!sharing.hasServerKey || sharing.keyCount === 0) {
    return hint(input.keyRequired === true
      ? '服务需要密钥，但当前托管配置里没有可复制的密钥。'
      : '当前托管配置里没有可复制的服务密钥。', input.keyRequired === true
      ? 'The service requires a key, but the hosted configuration has none to copy.'
      : 'The hosted configuration has no service key to copy.', 'no_key');
  }
  if (sharing.keyCount > 1) {
    return hint('当前配置有多个服务密钥，无法自动选择要复制哪一个。请在局域网共享设置中确认。', 'This configuration has more than one service key, so none is copied automatically. Confirm which key to use under LAN sharing.', 'multiple');
  }
  return hint('复制当前托管服务正在使用的密钥。密钥不会显示在此对话框中。', 'Copy the key the hosted service is currently using. The key is not shown in this dialog.', 'ready', true);
}

export function serviceKeyCopyFeedback(outcome: ServiceKeyCopyOutcome): { hintZh: string; hintEn: string } {
  if (outcome === 'copied') {
    return { hintZh: '已复制当前服务密钥（不会在此显示）。', hintEn: 'Copied the current service key (it is not shown here).' };
  }
  if (outcome === 'clipboard_failed') return { hintZh: '复制失败，请检查系统剪贴板权限。', hintEn: 'Copy failed. Check system clipboard permission.' };
  const availability = serviceKeyCopyAvailability({
    sharing: outcome === 'none_chosen' ? { hasServerKey: false, keyCount: 0, noKeyChosen: true, restartRequired: false, running: true }
      : outcome === 'multiple' ? { hasServerKey: true, keyCount: 2, restartRequired: false, running: true }
      : outcome === 'no_key' ? { hasServerKey: false, keyCount: 0, restartRequired: false, running: true }
      : outcome === 'stale' ? { hasServerKey: true, keyCount: 1, restartRequired: true, running: true }
      : outcome === 'not_running' ? { hasServerKey: true, keyCount: 1, restartRequired: false, running: false }
      : undefined,
    sharingError: outcome === 'not_owned',
    keyRequired: outcome === 'keyless' ? false : undefined,
  });
  return { hintZh: availability.hintZh, hintEn: availability.hintEn };
}
