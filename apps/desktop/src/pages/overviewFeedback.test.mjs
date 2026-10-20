import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const overview = readFileSync(new URL('./OverviewDashboard.tsx', import.meta.url), 'utf8');
const startup = readFileSync(new URL('./StartupProgress.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

// Xiaohongshu feedback: the startup card and the running card named the same model differently.
test('the running card uses the picked model name; the API name is a labeled detail', () => {
  assert.match(overview, /const model = profile\.name \|\| servedModel;/);
  assert.match(overview, /t\('ovApiModel'\)/);
  assert.match(app, /modelName=\{startupTarget\?\.name\}/, 'startup card uses the same profile name');
});

test('expected polling failures during a cold start are not shown as errors', () => {
  assert.match(app, /healthError=\{overviewHealthError\} metricsError=\{overviewMetricsError\}/);
  assert.match(app, /core\.visibleServiceError\(\{ kind: 'health'/);
  assert.match(app, /core\.visibleServiceError\(\{ kind: 'metrics'/);
});

test('engine output is collapsed unless it contains a real error', () => {
  assert.match(startup, /<details className="startup-progress-logs" open=\{hasError \|\| undefined\}>/);
  assert.match(startup, /engineLogTone\(log\.message\) === 'error' \? 'is-error'/);
});

test('custom startup parameters are one click from the running card', () => {
  assert.match(overview, /data-testid="overview-startup-params"[^>]*onClick=\{\(\) => onNavigate\('config'\)\}/);
  assert.match(app, /if\(target==='config'&&profile&&!overviewMock\)openModelConfig\(profile\)/);
});
