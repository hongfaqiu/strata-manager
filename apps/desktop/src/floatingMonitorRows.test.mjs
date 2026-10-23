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

test('the strip context menu offers 文字行数 auto / single / double as check items', () => {
  assert.match(strip, /text: text\('文字行数', 'Text rows'\), enabled: preferences\.layout !== 'panel'/);
  assert.match(strip, /\['auto', text\('自动', 'Auto'\)\], \['single', text\('单行', 'One row'\)\], \['double', text\('两行', 'Two rows'\)\]/);
  assert.match(strip, /checked: rows === id/);
  assert.match(strip, /void setMonitorRows\(id\)/);
  assert.match(bridge, /export const setMonitorRows = \(rows: MonitorRows\): Promise<void> => invoke\('set_monitor_rows', \{ rows \}\)/);
});

test('the menu choice is saved by the main window like any settings edit', () => {
  assert.match(native, /pub fn set_monitor_rows\(app: AppHandle, window: WebviewWindow, rows: String\)/);
  assert.match(native, /require_label\(window\.label\(\), LABEL\)\?;\s*require_rows\(&rows\)\?;/);
  assert.match(native, /emit_to\("main", "monitor-preferences-patch", json!\(\{ "rows": rows \}\)\)/);
  assert.match(app, /if \(patch\.rows === 'auto' \|\| patch\.rows === 'single' \|\| patch\.rows === 'double'\) allowed\.rows = patch\.rows;/);
  assert.match(policy, /\| "set_monitor_rows"/);
  assert.match(server, /"set_monitor_rows",/);
});

test('a single row lays labels beside values and the window follows the measured width', () => {
  assert.match(content, /data-inline=\{dimensions\.inline \|\| undefined\}/);
  assert.match(content, /'--monitor-gap': `\$\{dimensions\.gap\}px`/);
  assert.match(css, /\[data-inline="true"\] \.floating-monitor-reading \{ flex-direction: row;/);
  assert.match(strip, /floatingMonitorDimensions\(preferences, [^)]*maxWidth\)/);
  assert.match(strip, /<FloatingMonitorContent preferences=\{preferences\} maxWidth=\{maxWidth\}/);
  assert.match(strip, /resizeMonitorWindow\(dimensions\.width, dimensions\.height\)/);
});

test('settings show 文字行数 next to the layout presets; presets go back to auto', () => {
  assert.match(settings, /<h3 id=\{`\$\{id\}-rows`\}>\{zh \? '文字行数' : 'Text rows'\}/);
  assert.match(settings, /value=\{value\.rows \?\? 'auto'\}/);
  assert.match(settings, /disabled: !desktop \|\| value\.layout === 'panel'/);
  assert.match(settings, /showStatus: preset\.showStatus, rows: undefined \}\)/);
  assert.match(settings, /if \(!\('rows' in normalized\)\) delete next\.rows;/);
});
