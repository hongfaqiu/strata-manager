import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const rust = file => readFileSync(new URL(`../src-tauri/src/${file}`, import.meta.url), 'utf8');
const taskbar = rust('taskbar_monitor.rs').split('#[cfg(test)]\nmod tests')[0];
const fnBody = (source, signature) => {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found`);
  return source.slice(start, source.indexOf('\n}\n', start));
};

// Regression: the desktop strip popped up by itself. On Windows the taskbar
// monitor is restored 2 s after launch; when its host failed to start, missed
// the first frame, crashed or lost its sampler, the code fell back to
// floating_monitor::open_window. Closing the strip never changed
// taskbarEnabled, so it came back on every launch / Explorer restart.
test('taskbar host failures stop the widget without opening the strip', () => {
  const start = fnBody(taskbar, 'async fn start(');
  assert.doesNotMatch(start, /open_window/);
  assert.match(start, /stop\(app, failure_message\(&reason, false\)\)/);
  assert.match(start, /recover\(&event_app, &event_session, message, false\)/);
  assert.match(start, /"任务栏辅助进程输入已断开"\.into\(\),\s*false,/);
  // The widget menu's own "切换到桌面浮条" is the one explicit switch left.
  assert.match(start, /recover\(&event_app, &event_session, "已切换到桌面浮条"\.into\(\), true\)/);
  assert.equal(start.match(/, true\)\.await/g)?.length, 1);
  const recover = fnBody(taskbar, 'async fn recover(');
  assert.match(recover, /if show \{\s*if let Err\(error\) = crate::floating_monitor::open_window/);
  assert.match(recover, /if show \{\s*let _ = app\.emit_to\(/);
});

test('strip opens only from explicit user requests', () => {
  assert.equal(taskbar.match(/floating_monitor::open_window\(app\)/g)?.length, 2);
  assert.match(fnBody(taskbar, 'async fn open_floating_locked('), /open_window\(app\)\.await\?/);
  assert.doesNotMatch(fnBody(taskbar, 'pub(crate) fn restore_on_launch('), /open_window|open_floating/);
  const setMode = fnBody(taskbar, 'async fn set_mode_locked(');
  assert.doesNotMatch(setMode, /open_window/);
  assert.match(setMode, /#\[cfg\(not\(windows\)\)\]\s*\{[^}]*Err\("任务栏监控仅支持 Windows"\.into\(\)\)/);
  // No built-in global shortcut: nothing is registered until the user records one.
  assert.match(fnBody(rust('monitor_shortcut.rs'), 'pub(crate) fn wanted('), /unwrap_or_default|""/);
});
