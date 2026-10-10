import { StrataError } from './errors';
import type { JsonObject, ServiceProfile } from './types';

const absolutePath = (path: string) => /^(?:[a-z]:[\\/]|[\\/]{2}|\/)/i.test(path);
function resolvePath(path: string, base: string): string {
  const combined = (absolutePath(path) ? path : `${base}/${path}`).replace(/\\/g, '/');
  const root = combined.match(/^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/i)?.[0];
  if (!root) throw new StrataError('INVALID_CONFIG_PATH', '配置文件必须使用绝对路径');
  const parts: string[] = [];
  for (const part of combined.slice(root.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  const resolved = `${root.replace(/\/$/, '')}/${parts.join('/')}`;
  return /^[a-z]:|^\/\//i.test(root) ? resolved.replace(/\//g, '\\') : resolved;
}
const samePath = (a: string, b: string) => {
  const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/$/, '');
  const windows = /^[a-z]:|^[\\/]{2}/i.test(a);
  return windows ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b);
};

/** Read official setup.py run-config fields; the engine's exe is never a Python interpreter. */
export function profileFromConfig(configPath: string, config: JsonObject, id: string, previous?: ServiceProfile): ServiceProfile {
  if (!absolutePath(configPath) || !/\.json$/i.test(configPath)) throw new StrataError('INVALID_CONFIG_PATH', '请选择绝对路径的 Strata JSON 配置');
  if (!config || Array.isArray(config) || typeof config.exe !== 'string' || !config.exe.trim() || !Array.isArray(config.args) || !config.args.every(arg => typeof arg === 'string')) {
    throw new StrataError('INVALID_MODEL_CONFIG', 'Strata 模型配置需要 exe 和字符串数组 args');
  }
  const path = resolvePath(configPath, '');
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const parent = path.slice(0, separator + 1);
  if (config.cwd != null && typeof config.cwd !== 'string') throw new StrataError('INVALID_MODEL_CONFIG', 'cwd 必须是字符串');
  const installDir = resolvePath(typeof config.cwd === 'string' && config.cwd.trim() ? config.cwd.trim() : parent, parent);
  const port = config.port === undefined ? 8080 : config.port; // The official setup launcher uses 8080 when port is absent.
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new StrataError('INVALID_MODEL_CONFIG', 'port 必须为 1–65535');
  if (config.host != null && typeof config.host !== 'string') throw new StrataError('INVALID_MODEL_CONFIG', 'host 必须是字符串');
  let host = typeof config.host === 'string' && config.host.trim() ? config.host.trim() : '127.0.0.1';
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::' || host === '[::]') host = '::1';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  let endpoint: URL;
  try { endpoint = new URL(`http://${host}:${port}`); } catch { throw new StrataError('INVALID_MODEL_CONFIG', 'host 不是有效的服务主机名或 IP 地址'); }
  if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.port !== (port === 80 ? '' : String(port))) {
    throw new StrataError('INVALID_MODEL_CONFIG', 'host 只能包含服务主机名或 IP 地址');
  }
  const managed = endpoint.hostname === 'localhost' || endpoint.hostname === '[::1]' || /^127\./.test(endpoint.hostname);
  const name = typeof config.model_name === 'string' && config.model_name.trim() ? config.model_name.trim() : path.slice(separator + 1).replace(/\.json$/i, '');
  return {
    id, name, baseUrl: endpoint.origin, installDir, configPath: path, managed,
    // Official configs contain no Python field. Native startup detects this runtime's venv.
    pythonPath: previous && samePath(previous.installDir, installDir) ? previous.pythonPath : '',
  };
}
