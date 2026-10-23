import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const strip = read('./FloatingTelemetryWindow.tsx');
const content = read('./FloatingMonitorContent.tsx');
const css = read('./floating-monitor-content.css');
const settings = read('./pages/FloatingMonitorSettings.tsx');
const app = read('./App.tsx');
const bridge = read('./floatingMonitor.ts');
const native = read('../src-tauri/src/floating_monitor.rs');
const policy = read('../src-tauri/src/invoke_policy.rs');
const server = read('../../server/src/rpc.rs');

test('the strip context menu offers 文字行数 single / double as check items (no auto)', () => {
  assert.match(strip, /text: text\('文字行数', 'Text rows'\), enabled: preferences\.layout !== 'panel'/);
  assert.match(strip, /const rowChoices = \[\['single', text\('单行', 'One row'\)\], \['double', text\('两行', 'Two rows'\)\]\] as const;/);
  assert.doesNotMatch(strip, /\['auto', text\('自动'/);
  assert.match(strip, /checked: rows === id/);
  assert.match(strip, /void setMonitorRows\(id\)/);
  assert.match(bridge, /export const setMonitorRows = \(rows: FloatingMonitorRows\): Promise<void> => invoke\('set_monitor_rows', \{ rows \}\)/);
});

test('the menu choice is saved by the main window like any settings edit', () => {
  assert.match(native, /pub fn set_monitor_rows\(app: AppHandle, window: WebviewWindow, rows: String\)/);
  assert.match(native, /require_label\(window\.label\(\), LABEL\)\?;\s*require_rows\(&rows\)\?;/);
  assert.match(native, /if matches!\(rows, "single" \| "double"\) \{/);
  assert.match(native, /emit_to\("main", "monitor-preferences-patch", json!\(\{ "rows": rows \}\)\)/);
  assert.match(app, /if \(patch\.rows === 'single' \|\| patch\.rows === 'double'\) allowed\.rows = patch\.rows;/);
  assert.match(policy, /\| "set_monitor_rows"/);
  assert.match(server, /"set_monitor_rows",/);
});

test('a single row lays labels beside values and the window follows the measured width', () => {
  assert.match(content, /data-inline=\{dimensions\.inline \|\| undefined\}/);
  assert.match(content, /'--monitor-gap': `\$\{dimensions\.gap\}px`/);
  assert.match(css, /\[data-inline="true"\] \.floating-monitor-reading \{ flex-direction: row;/);
  assert.doesNotMatch(css, /data-layout="compact"/);
  assert.match(strip, /floatingMonitorDimensions\(preferences, [^)]*maxWidth\)/);
  assert.match(strip, /<FloatingMonitorContent preferences=\{preferences\} maxWidth=\{maxWidth\}/);
  assert.match(strip, /resizeMonitorWindow\(dimensions\.width, dimensions\.height\)/);
});

test('settings offer two presets (条形 / 详细面板) and a separate 文字行数 that presets keep', () => {
  assert.match(settings, /\{ id: 'strip', label: zh \? '条形' : 'Strip', hint: zh \? '默认推荐' : 'Recommended' \}/);
  assert.match(settings, /\{ id: 'panel', label: zh \? '详细面板' : 'Panel'/);
  assert.doesNotMatch(settings, /紧凑单行|清晰双行|'compact'|'twoRow'/);
  assert.match(settings, /<h3 id=\{`\$\{id\}-rows`\}>\{zh \? '文字行数' : 'Text rows'\}/);
  assert.match(settings, /value=\{value\.rows\} options=\{\(\[\s*\{ value: 'single'/);
  assert.doesNotMatch(settings, /value: 'auto'/);
  assert.match(settings, /disabled: !desktop \|\| value\.layout === 'panel'/);
  assert.match(settings, /showStatus: preset\.showStatus \}\);/);
  assert.match(settings, /singleRowFallback \? \(zh \? '单行放不下，已改为两行'/);
  assert.match(settings, /rows: FLOATING_MONITOR_DEFAULTS\.rows/);
});
