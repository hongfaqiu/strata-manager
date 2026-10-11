import { isDesktop } from './bridge';
import { normalizeError, StrataError } from './errors';
import type { ServiceProfile } from './types';

export type OfficialMcpClient = 'codex' | 'cursor' | 'claude-desktop' | 'vscode';
export interface OfficialMcpTool { name: string; readOnly: boolean }
export interface OfficialMcpProbe {
  protocolVersion: string;
  serverName: string;
  tools: OfficialMcpTool[];
  scriptPath: string;
  pythonPath: string;
  installDir: string;
  readOnlyProbe: true;
}
export interface ExternalManagementStatus { profileId: string; external: boolean; scope: 'installation'; canHandoff?: boolean; canResume?: boolean; reason?: string | null; installDir?: string }
async function ownership<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new StrataError('DESKTOP_REQUIRED', '管理归属操作需要桌面应用');
  try { const { invoke } = await import('@tauri-apps/api/core'); return await invoke<T>(command, args); }
  catch (error) { throw normalizeError(error); }
}
export const externalManagementStatus = (profileId: string): Promise<ExternalManagementStatus> => ownership('external_management_status', { profileId });
export const setExternalManagement = (profileId: string, external: boolean): Promise<ExternalManagementStatus> => ownership('set_external_management', { profileId, external });
export async function probeOfficialMcp(profileId: string): Promise<OfficialMcpProbe> {
  if (!isDesktop()) throw new StrataError('DESKTOP_REQUIRED', 'MCP 自检需要桌面应用');
  try { const { invoke } = await import('@tauri-apps/api/core'); return await invoke<OfficialMcpProbe>('probe_official_mcp', { profileId }); }
  catch (error) { throw normalizeError(error); }
}
function absolutePath(value: string): boolean { return /^(?:[A-Za-z]:[\\/]|\/)/.test(value) && !/[\r\n\0]/.test(value) && !value.split(/[\\/]/).includes('..'); }
/** Generates text only: never writes a client configuration or embeds a key. */
export function officialMcpClientConfiguration(profile: Pick<ServiceProfile, 'pythonPath' | 'installDir'>, client: OfficialMcpClient): string {
  if (!absolutePath(profile.pythonPath) || !absolutePath(profile.installDir)) throw new StrataError('INVALID_MCP_PATH', '请先自检并确认 Python 与 Strata 安装目录为有效绝对路径');
  const separator = /^[A-Za-z]:/.test(profile.installDir) ? '\\' : '/';
  const root = profile.installDir.replace(/[\\/]+$/, '');
  const script = [root, 'tools', 'strata_mcp.py'].join(separator);
  const args = [script, '--root', profile.installDir];
  if (client === 'codex') return `[mcp_servers.strata]\ncommand = ${JSON.stringify(profile.pythonPath)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 180\n`;
  const entry = { command: profile.pythonPath, args };
  if (client === 'vscode') return JSON.stringify({ servers: { strata: { type: 'stdio', ...entry } } }, null, 2);
  if (client === 'cursor' || client === 'claude-desktop') return JSON.stringify({ mcpServers: { strata: entry } }, null, 2);
  throw new StrataError('INVALID_MCP_CLIENT', '不支持的 MCP 客户端');
}
