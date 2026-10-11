import { afterEach, describe, expect, it, vi } from 'vitest';
import { managerMcpClientConfiguration, managerMcpConnection, officialMcpClientConfiguration, type ManagerMcpConnection, type OfficialMcpClient } from '../src/mcp-integration';
import { StrataError } from '../src/errors';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
afterEach(() => { vi.unstubAllGlobals(); invoke.mockReset(); });
const connection: ManagerMcpConnection = {
  serverName: 'strata-manager', protocolVersion: '2025-03-26', tools: [{ name: 'strata_status', readOnly: true }],
  command: 'D:\\Program Files\\Strata Manager\\strata-supervisor.exe',
  args: ['--mcp-server', '--data-dir', 'C:\\Users\\user\\AppData\\Roaming\\Strata Manager', '--profile-id', 'profile-1'],
  profileId: 'profile-1', installDir: 'D:\\AI\\Strata',
};

describe('MCP managed connection', () => {
  it('requests only the Manager connection without probing Python or changing ownership', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue(connection);
    expect(await managerMcpConnection(connection.profileId)).toBe(connection);
    expect(invoke.mock.calls).toEqual([['manager_mcp_connection', { profileId: 'profile-1' }]]);
  });
  it('requires the desktop app and surfaces backend failures', async () => {
    vi.stubGlobal('window', {});
    await expect(managerMcpConnection('profile-1')).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });
    expect(invoke).not.toHaveBeenCalled();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    invoke.mockRejectedValue('后台未运行，请启动本应用');
    await expect(managerMcpConnection('profile-1')).rejects.toThrow('后台未运行');
  });
  it.each(['cursor', 'claude-desktop'] as const)('exports the fixed shared-backend command for %s', client => {
    const settings = JSON.parse(managerMcpClientConfiguration(connection, client));
    expect(settings).toEqual({ mcpServers: { strata: { command: connection.command, args: connection.args } } });
  });
  it('exports VS Code stdio and Codex TOML without secrets', () => {
    expect(JSON.parse(managerMcpClientConfiguration(connection, 'vscode'))).toEqual({ servers: { strata: { type: 'stdio', command: connection.command, args: connection.args } } });
    const config = managerMcpClientConfiguration({ ...connection, env: { OPENAI_API_KEY: 'secret' } } as ManagerMcpConnection, 'codex');
    expect(config).toContain(`command = ${JSON.stringify(connection.command)}`);
    expect(config).toContain(`args = ${JSON.stringify(connection.args)}`);
    expect(config).toContain('tool_timeout_sec = 600');
    expect(config).not.toMatch(/secret|API_KEY|api_key|Bearer|^env\s*=/m);
  });
  it('supports Unix and packaged platform-suffixed Supervisor paths', () => {
    const unix = { ...connection, command: '/opt/Strata Manager/strata-supervisor-x86_64-unknown-linux-gnu', installDir: '/srv/strata', args: ['--mcp-server', '--data-dir', '/home/user/strata manager', '--profile-id', connection.profileId] };
    expect(JSON.parse(managerMcpClientConfiguration(unix, 'cursor')).mcpServers.strata.command).toBe(unix.command);
    expect(managerMcpClientConfiguration({ ...connection, command: 'D:\\bin\\strata-supervisor-x86_64-pc-windows-msvc.exe' }, 'codex')).toContain('strata-supervisor-x86_64-pc-windows-msvc.exe');
  });
  it.each([
    { command: 'strata-supervisor.exe' },
    { command: 'D:\\bin\\cmd.exe' },
    { command: 'D:\\bin\\..\\strata-supervisor.exe' },
    { command: 'D:\\bin\\.. \\strata-supervisor.exe' },
    { command: 'D:\\bin\\strata-supervisor.exe\nargs=[]' },
    { installDir: '..\\Strata' },
    { installDir: 'D:\\AI\\Strata\0' },
    { args: [...connection.args, '--run', 'shell'] },
    { args: ['--mcp-server', '--data-dir', '.', '--profile-id', connection.profileId] },
    { args: ['--mcp-server', '--data-dir', 'D:\\data\\..\\other', '--profile-id', connection.profileId] },
    { args: ['--data-dir', '--mcp-server', connection.args[2]!, '--profile-id', connection.profileId] },
    { args: ['--mcp-server', '--data-dir', connection.args[2]!, '--profile-id', 'other-profile'] },
    { profileId: '--run-command', args: ['--mcp-server', '--data-dir', connection.args[2]!, '--profile-id', '--run-command'] },
  ])('rejects invalid paths, commands and altered fixed arguments (%j)', altered => {
    expect(() => managerMcpClientConfiguration({ ...connection, ...altered }, 'codex')).toThrowError(StrataError);
  });
  it('rejects unsupported clients in both modes', () => {
    const client = 'shell' as OfficialMcpClient;
    expect(() => managerMcpClientConfiguration(connection, client)).toThrow('不支持');
    expect(() => officialMcpClientConfiguration({ pythonPath: 'D:\\python.exe', installDir: 'D:\\Strata' }, client)).toThrow('不支持');
  });
});

describe('optional independent MCP settings', () => {
  it('keeps the official Python invocation separate from the Supervisor bridge', () => {
    const profile = { pythonPath: 'D:\\AI\\Strata\\.venv\\Scripts\\python.exe', installDir: 'D:\\AI\\Strata' };
    for (const client of ['cursor', 'claude-desktop'] as const) {
      expect(JSON.parse(officialMcpClientConfiguration(profile, client)).mcpServers.strata).toEqual({ command: profile.pythonPath, args: ['D:\\AI\\Strata\\tools\\strata_mcp.py', '--root', profile.installDir] });
    }
    expect(JSON.parse(officialMcpClientConfiguration(profile, 'vscode')).servers.strata.type).toBe('stdio');
    expect(officialMcpClientConfiguration(profile, 'codex')).toContain('--root');
    expect(officialMcpClientConfiguration(profile, 'codex')).not.toContain('--mcp-server');
  });
  it('rejects relative and traversing official paths', () => {
    expect(() => officialMcpClientConfiguration({ pythonPath: 'python', installDir: 'D:\\Strata' }, 'codex')).toThrow('绝对');
    expect(() => officialMcpClientConfiguration({ pythonPath: 'D:\\python.exe', installDir: 'D:\\Strata\\..\\other' }, 'codex')).toThrow('绝对');
  });
});
