import type { StartupStatus } from '@strata-manager/core';

const messages: Record<string, { 'zh-CN': string; en: string }> = {
  disabled_entry: { 'zh-CN': '系统已禁用此启动项。请在系统启动设置中启用，或在应用中重新开启。', en: 'The system disabled this startup entry. Enable it in system startup settings, or turn it on again here.' },
  restricted_entry: { 'zh-CN': '启动项含桌面环境限制或额外启动条件。请核对系统启动设置后重新启用。', en: 'This entry has desktop restrictions or extra startup conditions. Review system startup settings before enabling it again.' },
  missing_executable: { 'zh-CN': '已配置的后台文件不存在。请重新开启此项以修复；若仍失败，请修复应用安装。', en: 'The registered background executable is missing. Enable this entry again to repair it. If that fails, repair the app installation.' },
  corrupt_executable: { 'zh-CN': '已配置的后台文件校验失败。请修复应用安装，再重新开启此启动项。', en: 'The registered background executable failed its integrity check. Repair the app installation, then enable this startup entry again.' },
  wrong_data: { 'zh-CN': '此启动项使用其它数据目录。请在系统启动设置中移除同名项，再在本应用中启用。', en: 'This entry uses another data directory. Remove the entry with the same name in system startup settings, then enable it here.' },
  foreign_entry: { 'zh-CN': '同名启动项不属于本应用的独立后台。请在系统启动设置中核对并移除，再启用本应用。', en: 'The entry with this name does not belong to this app’s background service. Review and remove it in system startup settings before enabling this app.' },
  unreadable_entry: { 'zh-CN': '启动项无法读取。请检查系统启动设置和文件权限后重试。', en: 'The startup entry cannot be read. Check system startup settings and file permissions, then retry.' },
  invalid_entry: { 'zh-CN': '启动项内容无效。请在系统启动设置中移除同名项，再在本应用中重新启用。', en: 'The startup entry is invalid. Remove the entry with the same name in system startup settings, then enable it again here.' },
  unsupported: { 'zh-CN': '当前平台尚未配置独立后台登录启动。', en: 'Background startup on login is not configured for this platform.' },
};

export function startupStatusHint(status: StartupStatus | undefined, language: string, fallback: string): string {
  const translated = status?.reasonCode ? messages[status.reasonCode] : undefined;
  return translated?.[language.startsWith('zh') ? 'zh-CN' : 'en'] ?? status?.reason ?? fallback;
}
