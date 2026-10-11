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
export interface ManagerMcpConnection {
  serverName: string;
  protocolVersion: string;
  tools: OfficialMcpTool[];
  command: string;
  args: string[];
  profileId: string;
  installDir: string;
}
export interface ExternalManagementStatus { profileId: string; external: boolean; scope: 'installation'; canHandoff?: boolean; canResume?: boolean; reason?: string | null; installDir?: string }
async function ownership<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new StrataError('DESKTOP_REQUIRED', '管理归属操作需要桌面应用');
  try { const { invoke } = await import('@tauri-apps/api/core'); return await invoke<T>(command, args); }
  catch (error) { throw normalizeError(error); }
}
export const externalManagementStatus = (profileId: string): Promise<ExternalManagementStatus> => ownership('external_management_status', { profileId });
export const setExternalManagement = (profileId: string, external: boolean): Promise<ExternalManagementStatus> => ownership('set_external_management', { profileId, external });
export const managerMcpConnection = (profileId: string): Promise<ManagerMcpConnection> => ownership('manager_mcp_connection', { profileId });
export async function probeOfficialMcp(profileId: string): Promise<OfficialMcpProbe> {
  if (!isDesktop()) throw new StrataError('DESKTOP_REQUIRED', 'MCP 自检需要桌面应用');
  try { const { invoke } = await import('@tauri-apps/api/core'); return await invoke<OfficialMcpProbe>('probe_official_mcp', { profileId }); }
  catch (error) { throw normalizeError(error); }
}
function absolutePath(value: string): boolean {
  return typeof value === 'string' && /^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(value)
    && !/[\x00-\x1f\x7f]/.test(value)
    && !value.split(/[\\/]/).some(part => /^\.{1,2}[ .]*$/.test(part));
}
function clientConfiguration(command: string, args: string[], client: OfficialMcpClient, toolTimeoutSeconds = 180): string {
  if (client === 'codex') return `[mcp_servers.strata]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = ${toolTimeoutSeconds}\n`;
  const entry = { command, args };
  if (client === 'vscode') return JSON.stringify({ servers: { strata: { type: 'stdio', ...entry } } }, null, 2);
  if (client === 'cursor' || client === 'claude-desktop') return JSON.stringify({ mcpServers: { strata: entry } }, null, 2);
  throw new StrataError('INVALID_MCP_CLIENT', '不支持的 MCP 客户端');
}
/** Only exports the fixed Supervisor bridge invocation; no shell, environment or credentials. */
export function managerMcpClientConfiguration(connection: ManagerMcpConnection, client: OfficialMcpClient): string {
  const executable = typeof connection.command === 'string' ? connection.command.split(/[\\/]/).at(-1) ?? '' : '';
  if (!absolutePath(connection.command) || !/^strata-supervisor(?:-[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)?(?:\.exe)?$/i.test(executable)
    || !absolutePath(connection.installDir) || !Array.isArray(connection.args) || connection.args.length !== 5
    || connection.args[0] !== '--mcp-server' || connection.args[1] !== '--data-dir'
    || !absolutePath(connection.args[2] ?? '') || connection.args[3] !== '--profile-id'
    || typeof connection.profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(connection.profileId)
    || connection.args[4] !== connection.profileId) {
    throw new StrataError('INVALID_MCP_CONNECTION', '本应用 MCP 配置无效：需要 Supervisor 绝对路径、固定连接参数和一致的模型档案 ID，请重新检查连接');
  }
  // Loading a local model may use the backend's full 420-second operation window.
  return clientConfiguration(connection.command, connection.args, client, 600);
}
/** Generates text only: never writes a client configuration or embeds a key. */
export function officialMcpClientConfiguration(profile: Pick<ServiceProfile, 'pythonPath' | 'installDir'>, client: OfficialMcpClient): string {
  if (!absolutePath(profile.pythonPath) || !absolutePath(profile.installDir)) throw new StrataError('INVALID_MCP_PATH', '请先自检并确认 Python 与 Strata 安装目录为有效绝对路径');
  const separator = /^[A-Za-z]:/.test(profile.installDir) ? '\\' : '/';
  const root = profile.installDir.replace(/[\\/]+$/, '');
  const script = [root, 'tools', 'strata_mcp.py'].join(separator);
  const args = [script, '--root', profile.installDir];
  return clientConfiguration(profile.pythonPath, args, client);
}
