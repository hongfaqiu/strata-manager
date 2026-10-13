export interface ServiceSharingStatus {
  profileId: string;
  configRevision: string;
  host: string;
  port: number;
  hasServerKey: boolean;
  keyCount: number;
  running: boolean;
  owned: boolean;
  restartRequired: boolean;
  liveHost: string | null;
  livePort: number | null;
  lanAddresses: string[];
  managementUrl: string;
}
export interface SetServiceAuthRequest {
  expectedRevision: string;
  host: string;
  port: number;
  keyAction: 'keep' | 'set' | 'clear';
  serverKey?: string;
}
export interface ServiceAuthResult {
  status: ServiceSharingStatus;
  restartRequired: boolean;
  clientCredentialNeedsUpdate: boolean;
}
export interface SharingPreview {
  hostChanged: boolean;
  portChanged: boolean;
  authChanged: boolean;
  lan: boolean;
  keyCountAfterSave: number;
  urls: string[];
  restartRequired: boolean;
}
const loopback = (host: string) => host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
const urlFor = (host: string, port: number) => `http://${host.includes(':') ? `[${host}]` : host}:${port}/v1`;
/** No credentials enter the preview or client snippet. Existing arrays stay intact on keep. */
export function buildSharingPreview(status: ServiceSharingStatus, request: SetServiceAuthRequest): SharingPreview {
  if (!/^[a-f\d]{64}$/i.test(request.expectedRevision)) throw new Error('CONFIG_REVISION_INVALID');
  if (!Number.isSafeInteger(request.port) || request.port < 1 || request.port > 65535) throw new Error('SHARING_PORT_INVALID');
  if (!request.host.trim() || /[\s/\\?#@]/.test(request.host) || !['keep', 'set', 'clear'].includes(request.keyAction)) throw new Error('SHARING_OPTIONS_INVALID');
  if (request.keyAction === 'set' && (!request.serverKey?.trim() || request.serverKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(request.serverKey))) throw new Error('SHARING_KEY_INVALID');
  if (request.keyAction !== 'set' && request.serverKey !== undefined) throw new Error('SHARING_OPTIONS_INVALID');
  const lan = !loopback(request.host), keyCountAfterSave = request.keyAction === 'set' ? 1 : request.keyAction === 'clear' ? 0 : status.keyCount;
  if (lan && !keyCountAfterSave) throw new Error('SHARING_KEY_REQUIRED');
  const addresses = request.host === '0.0.0.0' ? status.lanAddresses.filter(host => !host.includes(':')) : request.host === '::' ? status.lanAddresses.filter(host => host.includes(':')) : lan ? status.lanAddresses.filter(host => host === request.host) : [];
  return { hostChanged: status.host !== request.host, portChanged: status.port !== request.port, authChanged: request.keyAction !== 'keep', lan, keyCountAfterSave,
    urls: addresses.map(host => urlFor(host, request.port)), restartRequired: status.running && (status.host !== request.host || status.port !== request.port || request.keyAction !== 'keep' || status.restartRequired) };
}
/** Client-side setup example, deliberately separate from server credentials and control URLs. */
export function sharingClientExample(url: string, model?: string): string {
  const base = new URL(url);
  if (base.protocol !== 'http:' || base.username || base.password || base.search || base.hash || base.pathname !== '/v1' || ['0.0.0.0', '[::]'].includes(base.hostname)) throw new Error('SHARING_URL_INVALID');
  return ['# 在同一局域网的客户端终端设置服务端密钥 / Set the server key in the client terminal', 'export STRATA_API_KEY="YOUR_STRATA_API_KEY"',
    `curl '${`${base.origin}/v1/chat/completions`.replaceAll("'", "'\"'\"'")}' \\`, '  -H "Authorization: Bearer $STRATA_API_KEY" \\', "  -H 'Content-Type: application/json' \\",
    `  --data-raw '${JSON.stringify({ model: model || 'MODEL_ID', messages: [{ role: 'user', content: 'Hello!' }], max_tokens: 256 }).replaceAll("'", "'\"'\"'")}'`].join('\n');
}
