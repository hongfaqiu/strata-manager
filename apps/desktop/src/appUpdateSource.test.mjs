import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appUpdateMirrorProblem, appUpdateSourceChoice, appUpdateUsesSource, withAppUpdateSource } from './appUpdateSource.ts';

test('custom app update mirrors follow the native {url} rules', () => {
  assert.equal(appUpdateMirrorProblem('https://mirror.example.com/{url}'), null);
  assert.equal(appUpdateMirrorProblem(' https://ghproxy.net/{url} '), null);
  assert.equal(appUpdateMirrorProblem('http://mirror.example.com/{url}'), 'https');
  assert.equal(appUpdateMirrorProblem('https://user:pw@mirror.example.com/{url}'), 'https');
  assert.equal(appUpdateMirrorProblem('https://mirror.example.com/{url}#x'), 'https');
  assert.equal(appUpdateMirrorProblem('https://mirror.example.com/{url}#'), 'https');
  assert.equal(appUpdateMirrorProblem('mirror.example.com/{url}'), 'https');
  assert.equal(appUpdateMirrorProblem('https://mirror.example.com/app.exe'), 'url');
  assert.equal(appUpdateMirrorProblem('https://mirror.example.com/{version}/{asset}'), 'engineOnly');
  assert.equal(appUpdateMirrorProblem('https://mirror.example.com/{url}?v={version}'), 'placeholder');
  assert.equal(appUpdateMirrorProblem('https://mirror.example.com/{url}/{name}'), 'placeholder');
});

test('choices map the shared engine preferences without dropping the engine package choice', () => {
  assert.equal(appUpdateSourceChoice({ mode: 'official' }), 'official');
  assert.equal(appUpdateSourceChoice({ mode: 'local', localArchivePath: '/x.tar.gz' }), 'local');
  assert.equal(appUpdateSourceChoice({ mode: 'mirror', sourceId: 'gh-proxy' }), 'gh-proxy');
  assert.equal(appUpdateSourceChoice({ mode: 'mirror', mirrorUrl: 'https://m.example/{url}' }), 'custom');
  const saved = { mode: 'mirror', sourceId: 'gh-proxy', assetName: 'engine-cuda12.tar.gz', releaseVersion: '0.2.8' };
  assert.deepEqual(withAppUpdateSource(saved, 'official'), { mode: 'official', assetName: 'engine-cuda12.tar.gz' });
  assert.deepEqual(withAppUpdateSource(saved, 'ghproxy'), { mode: 'mirror', assetName: 'engine-cuda12.tar.gz', releaseVersion: '0.2.8', sourceId: 'ghproxy' });
  assert.deepEqual(withAppUpdateSource(saved, 'custom', ' https://m.example/{url} '), { mode: 'mirror', assetName: 'engine-cuda12.tar.gz', releaseVersion: '0.2.8', mirrorUrl: 'https://m.example/{url}' });
});

test('only built-in mirrors and {url} templates reach the app updater', () => {
  assert.equal(appUpdateUsesSource({ mode: 'mirror', sourceId: 'ghproxy' }), true);
  assert.equal(appUpdateUsesSource({ mode: 'mirror', mirrorUrl: 'https://m.example/{url}' }), true);
  assert.equal(appUpdateUsesSource({ mode: 'mirror', mirrorUrl: 'https://m.example/{version}/{asset}' }), false);
  assert.equal(appUpdateUsesSource({ mode: 'local', localArchivePath: '/x.tar.gz' }), false);
  assert.equal(appUpdateUsesSource({ mode: 'official' }), false);
});
