import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const overview = readFileSync(new URL('./OverviewDashboard.tsx', import.meta.url), 'utf8');
const strips = readFileSync(new URL('./D2PageStrips.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

test('multi-GPU headline is the counted set name with a per-card breakdown', () => {
  // Upstream joins names ("A + A"); showing it raw and then "×2" repeated and truncated the name.
  assert.match(overview, /<strong title=\{[^}]*hwStatic\.gpu_name[^}]*\}>\{gpuName\}<\/strong>/);
  assert.doesNotMatch(overview, /×\{gpuCount\}/);
  assert.match(overview, /data-testid="overview-gpu-cards"/);
  assert.match(overview, /GPU \{card\.index\}/);
  assert.doesNotMatch(strips, /\+\$\{gpus\.length - 1\}/, 'environment strip no longer hides extra cards as "+1"');
  assert.match(strips, /gpuSummary\(gpus\)/);
});

test('a slow model load is shown as loading and stored failures never reach the UI as raw JSON', () => {
  assert.match(overview, /loadNotice\?\.kind === 'loading'\) issues\.push\(\{ tone: 'idle'/);
  assert.match(app, /core\.readableServiceError\(supervisor\.data\?\.preparationFailures/);
  assert.doesNotMatch(app, /preparationFailures\?\.find\([^)]*\)\?\.lastError\)\}/);
  assert.match(app, /failureResolvedByReady/);
});
