// Extracts user-visible strings, controls and handlers per page so a redesign can be checked for removed features.
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../../apps/desktop/src/', import.meta.url).pathname;
const app = readFileSync(root + 'App.tsx', 'utf8');
const slice = (start, end) => { const a = app.indexOf(start); const b = end ? app.indexOf(end, a + 1) : -1; return a < 0 ? '' : app.slice(a, b < 0 ? a + 4000 : b); };
export const pages = {
  '我的模型 (models/profiles)': { files: ['pages/ServiceManagerPage.tsx', 'pages/ConfigurationList.tsx'], app: slice('const ProfilesPage', 'const ModelsPage') },
  '下载模型 (catalog)': { files: ['pages/ModelDownloadPage.tsx', 'pages/ModelDownloadSettingsDialog.tsx', 'pages/ModelInspectPanel.tsx', 'pages/ResourceAssessmentPanel.tsx'], app: slice('const ModelsPage', 'const renderChatPage') },
  '运行配置 (config)': { files: ['pages/RuntimeConfigPage.tsx', 'pages/ConfigurationList.tsx'], app: slice('const renderRuntimeConfig', 'const renderTuningPage') },
  'Strata 运行环境 (environment)': { files: ['pages/InstallRuntimePage.tsx'], app: slice('const EnvironmentPage', 'const changeSettings') },
  '参数调优 (tuning)': { files: ['pages/TuningPage.tsx'], app: slice('const renderTuningPage', 'const pages:') },
  '任务与日志 (tasks)': { files: [], app: slice('const TasksPage', 'const EnvironmentPage') },
  'Benchmark': { files: ['pages/BenchmarkPage.tsx', 'pages/ContextBenchmarkPage.tsx', 'pages/ScenarioBenchmarkPage.tsx', 'pages/BenchmarkComparisonPanel.tsx'], app: '' },
  '公共设置 (settings)': { files: ['pages/DesktopLifecycleSettings.tsx'], app: slice('const SettingsPage', 'const MonitorSettingsPage') },
  'API 与外部助手 (connections)': { files: ['ServiceConnectionPanel.tsx', 'ServiceCapabilityPanel.tsx', 'McpIntegrationPanel.tsx', 'ServiceSharingPanel.tsx'], app: slice('const renderConnectionsPage', 'const renderRuntimeToolsPage') },
  '显存与会话 (runtime-tools)': { files: ['RuntimeOperationsPanel.tsx'], app: slice('const renderRuntimeToolsPage', 'const restartSelectedService') },
  '应用更新 (updates)': { files: ['pages/DesktopLifecycleSettings.tsx'], app: slice('const UpdatesPage', 'const setInterfaceLanguage') },
  '关于 (about)': { files: ['OfficialAbout.tsx'], app: slice('const renderAboutPage', 'const enableRequestViewer') },
};
const rx = { text: /text\(\s*'((?:[^'\\]|\\.)*)'/g, zh: /zh\s*\?\s*'((?:[^'\\]|\\.)*)'/g, zhq: /==='zh-CN'\s*\?\s*'((?:[^'\\]|\\.)*)'/g, t: /\bt\('([A-Za-z0-9_]+)'/g, aria: /aria-?[lL]abel=\{?['"]([^'"{}]+)['"]/g, handler: /\b(on[A-Z][A-Za-z]+)=\{/g, control: /<(Toggle|Dropdown|Segmented|NumberField|Radio|Field|input|textarea|details|dialog|ConfirmDialog|Dialog|ErrorBlock|Empty)\b/g, role: /role="(alert|status|log|dialog)"/g };
export function inventory() { const out = {}; for (const [name, p] of Object.entries(pages)) { const src = p.files.map(f => readFileSync(root + f, 'utf8')).join('\n') + '\n' + p.app; const sets = {};
  for (const [k, r] of Object.entries(rx)) sets[k] = [...new Set([...src.matchAll(r)].map(m => m[1]))].sort(); out[name] = sets; } return out; }
if (process.argv[2] === 'write') { writeFileSync(process.argv[3], JSON.stringify(inventory(), null, 1)); console.log('written'); }
if (process.argv[2] === 'check') { const before = JSON.parse(readFileSync(process.argv[3], 'utf8')), now = inventory(); let missing = 0;
  for (const [page, sets] of Object.entries(before)) for (const [k, list] of Object.entries(sets)) { const cur = new Set(Object.values(now).flatMap(s => s[k] ?? [])); for (const item of list) if (!cur.has(item)) { missing++; console.log(`MISSING ${page} ${k}: ${item}`); } }
  console.log(missing ? `${missing} missing` : 'all inventory items present'); process.exitCode = missing ? 1 : 0; }
// md <baseline.json> <out.md> [notes.md]: checklist of every baseline item, ticked when still present, with the file that now carries it.
if (process.argv[2] === 'md') {
  const before = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const where = (page, kind, item) => { const p = pages[page]; const hits = []; for (const f of p.files) { const src = readFileSync(root + f, 'utf8'); if ([...src.matchAll(rx[kind])].some(m => m[1] === item)) hits.push(f); } if (p.app && [...p.app.matchAll(rx[kind])].some(m => m[1] === item)) hits.push('App.tsx'); if (!hits.length) for (const [other, q] of Object.entries(pages)) for (const f of q.files) { const src = readFileSync(root + f, 'utf8'); if ([...src.matchAll(rx[kind])].some(m => m[1] === item)) hits.push(f); } return [...new Set(hits)]; };
  const label = { text: '文案 text()', zh: '文案 zh ?', zhq: "文案 ==='zh-CN'", t: 'i18n key t()', aria: '无障碍标签', handler: '交互处理器', control: '控件 / 状态组件', role: '状态角色 (alert/status/log)' };
  let out = (process.argv[5] ? readFileSync(process.argv[5], 'utf8') : '') + '\n## 自动核对清单（基线：feature-inventory.baseline.json，改版前从 main 抽取）\n\n每一项为改版前该页面源代码中的一个可见文案、i18n 键、控件、交互处理器或状态。`[x]` 表示改版后仍存在，后面是它现在所在的文件。\n';
  let total = 0, kept = 0;
  for (const [page, sets] of Object.entries(before)) { out += `\n### ${page}\n`;
    for (const [kind, list] of Object.entries(sets)) { if (!list.length) continue; out += `\n**${label[kind]}**（${list.length}）\n\n`;
      for (const item of list) { total++; const hits = where(page, kind, item); if (hits.length) kept++; out += `- [${hits.length ? 'x' : ' '}] \`${item.replace(/`/g, "'")}\` → ${hits.join(', ') || '**缺失**'}\n`; } } }
  out = out.replace('{{TOTAL}}', `${kept} / ${total}`);
  writeFileSync(process.argv[4], out); console.log(`md written ${kept}/${total}`);
}
