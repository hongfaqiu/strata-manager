import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const hook = read('./useWindowClose.tsx');
const app = read('./App.tsx');
const lib = read('../src-tauri/src/lib.rs');
const server = read('../../server/src/rpc.rs');

test('closing minimizes to the tray by default and repairs the beta false default', () => {
  assert.match(app, /closeToTray: true, closeToTrayRevision: core\.CLOSE_TO_TRAY_REVISION/);
  assert.match(app, /const s = core\.migrateWindowCloseSettings\(savedSettings\);/);
  assert.match(lib, /let close = saved_close_to_tray\(&saved_settings\);/);
});

test('the exit dialog offers minimize to tray in both dialog languages', () => {
  assert.match(hook, /tray: 'Minimize to tray'/);
  assert.match(hook, /tray: '最小化到托盘'/);
  const footer = hook.slice(hook.indexOf('dialog-footer'));
  const order = ['text.cancel', 'text.tray', 'text.exit'].map(key => footer.indexOf(key));
  assert.ok(order.every(index => index > 0) && order[0] < order[1] && order[1] < order[2], 'cancel, tray, exit order');
});

test('"do not ask again" with minimize remembers closeToTray: true and hides without stopping services', () => {
  const body = hook.slice(hook.indexOf('const minimizeToTray'), hook.indexOf('const confirm ='));
  assert.match(body, /if \(remember && ready\)/);
  assert.match(body, /closeToTray: true/);
  assert.match(body, /core\.applySettings\(next\)/);
  assert.match(body, /invoke\('hide_main_window'\)/);
  assert.doesNotMatch(body, /confirm_window_close|skipExitConfirmation/);
  assert.match(lib, /fn hide_main_window\(window: tauri::WebviewWindow\)/);
  assert.match(lib, /confirm_window_close,\s*hide_main_window,/);
  assert.match(server, /"hide_main_window",/);
});
