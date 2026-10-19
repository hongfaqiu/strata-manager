import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const settings = read('./FloatingMonitorSettings.tsx');
const core = read('../../../../packages/core/src/floating-monitor.ts');
const types = read('../../../../packages/core/src/types.ts');
const native = read('../../src-tauri/src/tray_live.rs');
const lib = read('../../src-tauri/src/lib.rs');

const choices = ['none', 'status', 'generation', 'vram', 'gpu'];

test('#71: the preference lives in floatingMonitor and defaults to the status color', () => {
  assert.match(types, /export type TrayIconDisplay = 'none' \| 'status' \| 'generation' \| 'vram' \| 'gpu';/);
  assert.match(types, /trayIconDisplay\?: TrayIconDisplay;/);
  assert.match(core, /trayIconDisplay: 'status',\r?\n\};/);
  assert.match(core, /TRAY_ICON_DISPLAYS: readonly TrayIconDisplay\[\] = \['none', 'status', 'generation', 'vram', 'gpu'\]/);
});

test('#71: the monitor settings offer 无 / 状态色 / 生成速度 / 显存占用 / GPU 负载 in zh and en', () => {
  assert.match(settings, /zh \? '在托盘图标显示' : 'Show on the tray icon'/);
  assert.match(settings, /options=\{TRAY_ICON_DISPLAYS\.map\(option =>/);
  assert.match(settings, /onValueChange=\{next => update\(\{ trayIconDisplay: next as TrayIconDisplay \}\)\}/);
  for (const [id, zh, en] of [
    ['none', '无', 'None'], ['status', '状态色', 'Status color'], ['generation', '生成速度', 'Generation speed'],
    ['vram', '显存占用', 'VRAM usage'], ['gpu', 'GPU 负载', 'GPU load'],
  ]) assert.match(settings, new RegExp(`${id}: \\{ 'zh-CN': '${zh}', en: '${en}' \\}`));
});

test('#71: every UI choice is understood by the native tray renderer', () => {
  for (const id of choices.filter(id => id !== 'status')) assert.match(native, new RegExp(`Some\\("${id}"\\) => Self::`));
  assert.match(native, /settings\["floatingMonitor"\]\["trayIconDisplay"\]/);
  assert.match(native, /_ => Self::Status,/, 'missing or unknown values fall back to the status color');
});

test('#71: settings changes reach the live loop, which owns the main tray tooltip', () => {
  assert.match(lib, /tray_live::apply\(&app, &settings\);/);
  assert.match(lib, /tray_live::start\(app\.handle\(\), &saved_settings\);/);
  assert.match(lib, /if !tray_live::owns_tooltip\(app\) \{/);
  assert.match(native, /\.clamp\(1000, 2000\)/, 'samples every 1–2 s');
  assert.match(native, /if shown\.as_ref\(\) != Some\(&key\) \{/, 'no redraw when the icon is unchanged');
});
