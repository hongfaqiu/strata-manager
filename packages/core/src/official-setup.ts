import { parseRolesText, rolesText } from './gpu-roles';
/** Explicit per-task overrides for the official setup.py, never shell arguments. */
export interface OfficialSetupOptions {
  source?: 'official' | 'mirror' | 'modelscope';
  hfEndpoint?: string;
  backend?: 'auto' | 'cuda' | 'hip' | 'sycl';
  /** Empty means upstream automatic choice; accepts one index, comma-separated indices, or all. */
  gpus?: string;
  /** Strata 0.2.2 setup.py --gpu-roles (`0=helper,1=main`). When set it names the cards and replaces --gpu / --gpus. */
  gpuRoles?: string;
}
export interface ModelInspectRequest {
  installationId: string;
  target: string;
  variant?: string;
}
export const DEFAULT_SETUP_OPTIONS: Readonly<OfficialSetupOptions> = { source: 'official', backend: 'auto', gpus: '' };
const controls = /[\u0000-\u001f\u007f-\u009f]/;
export function validateHfEndpoint(value: string): string {
  if (controls.test(value) || /\\/.test(value)) throw new Error('镜像地址不能包含控制字符或反斜线 / Invalid mirror address');
  const text = value.trim();
  let url: URL;
  try { url = new URL(text); } catch { throw new Error('请输入完整 HTTPS 镜像地址 / Enter an absolute HTTPS mirror URL'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('镜像地址必须为 HTTPS，且不能包含凭据、查询参数或片段 / Mirror requires HTTPS without credentials, query or fragment');
  }
  return url.toString().replace(/\/+$/, '');
}
export function normalizeGpuSelection(value: string): string {
  if (controls.test(value)) throw new Error('GPU 编号不能包含控制字符 / GPU indices cannot contain control characters');
  const text = value.trim();
  if (!text || text === 'all') return text;
  if (!/^\d+(?:\s*,\s*\d+)*$/.test(text)) throw new Error('GPU 请输入编号、逗号分隔的编号或 all / Enter GPU indices or all');
  const indices = text.split(',').map(x => Number(x.trim()));
  if (indices.length > 8 || indices.some(x => !Number.isSafeInteger(x) || x > 255) || new Set(indices).size !== indices.length) {
    throw new Error('GPU 编号应为 0–255，最多 8 个且不能重复 / Invalid or duplicate GPU indices');
  }
  return indices.join(',');
}
export function normalizeOfficialSetupOptions(options: OfficialSetupOptions = {}): OfficialSetupOptions {
  const source = options.source ?? 'official';
  const backend = options.backend ?? 'auto';
  if (!['official', 'mirror', 'modelscope'].includes(source) || !['auto', 'cuda', 'hip', 'sycl'].includes(backend)) throw new Error('未知安装选项 / Unknown setup option');
  const gpus = normalizeGpuSelection(options.gpus ?? '');
  let gpuRoles: string | undefined;
  if (options.gpuRoles?.trim()) {
    const roles = parseRolesText(options.gpuRoles);
    if (!roles) throw new Error('显卡角色格式为 编号=main|helper|off，只能有一张主卡 / GPU roles are number=main|helper|off with one Main');
    const on = Object.keys(roles).map(Number).filter(i => roles[i] !== 'off').sort((a, b) => a - b).join(',');
    if (gpus === 'all' || (gpus && gpus.split(',').map(Number).sort((a, b) => a - b).join(',') !== on)) throw new Error('显卡角色与所选显卡不一致 / GPU roles do not match the chosen GPUs');
    gpuRoles = rolesText(roles);
  }
  return { source, backend, gpus, ...(gpuRoles ? { gpuRoles } : {}), ...(source === 'mirror' ? { hfEndpoint: validateHfEndpoint(options.hfEndpoint ?? '') } : {}) };
}
export function validateModelInspectRequest(request: ModelInspectRequest): ModelInspectRequest {
  const target = request.target.trim();
  if (!request.installationId.trim() || controls.test(request.installationId) || !target || target.length > 4096 || controls.test(request.target) || target.startsWith('-')) throw new Error('请选择运行环境并填写有效模型来源 / Select a runtime and a valid model source');
  if (/^(?:hf|ms):/.test(target)) {
    if (!/^(?:hf|ms):[\w.-]+\/[\w.-]+$/.test(target) || target.slice(3).split('/').some(part => part === '.' || part === '..')) throw new Error('仓库格式为 hf:owner/repo 或 ms:owner/repo / Invalid repository source');
  } else if (/^https?:/i.test(target)) {
    const url = new URL(target);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || target.includes('\\')) throw new Error('远程文件需使用无凭据的 HTTPS 地址 / Remote source requires HTTPS without credentials');
  } else if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(target)) {
    throw new Error('本地模型请填写绝对路径 / Use an absolute local path');
  }
  const variant = request.variant?.trim();
  if (variant && (!/^[A-Za-z0-9_.-]{1,128}$/.test(variant) || variant.startsWith('-') || variant === '.' || variant === '..')) throw new Error('量化筛选仅允许字母、数字、下划线、点和连字符 / Invalid variant');
  return { installationId: request.installationId.trim(), target, ...(variant ? { variant } : {}) };
}
