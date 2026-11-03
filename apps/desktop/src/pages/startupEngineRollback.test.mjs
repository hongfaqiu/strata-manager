import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Upstream 0.2.10: when a new engine crashes, falling back to the previous one (e.g. 0.1.55) is the fix.
test('an engine crash offers falling back to the previous engine on the fault card', () => {
  const card = source('./StartupDiagnosticCard.tsx');
  assert.match(card, /engineRollback && startupEngineCrashed\(diagnostic\) && <div className="startup-diagnostic-rollback"/);
  const rollback = source('./StartupEngineRollback.tsx');
  assert.match(rollback, /core\.installedRollbackTarget\(inventory\.data, releases\)/);
  assert.match(rollback, /switcher\.open\(target\)/);
  assert.match(rollback, /<RuntimeSwitchDialog /);
  for (const copy of ['回退到上一版引擎再试', "'回退到' : 'Fall back to'", '选择其他引擎版本', 'Choose another engine version']) assert.ok(rollback.includes(copy), copy);
  const app = source('../App.tsx');
  assert.match(app, /engineRollback=\{desktop \? <StartupEngineRollback /);
});
