/** Pull requests may skip only what their changed paths cannot affect; everything else runs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, decide, pullRequestFiles, main } from './ci-changes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pr = files => decide({event: 'pull_request', labels: [], headRef: 'feature/x', files});
const scope = d => ({code: d.code, native: d.native});

test('main, manual and unknown events always run every job', () => {
  for (const event of ['push', 'workflow_dispatch', 'schedule', undefined, '']) {
    assert.deepEqual(scope(decide({event, files: ['README.md']})), {code: true, native: true});
  }
});

test('full-ci labels, release branches and malformed metadata run every job', () => {
  assert.deepEqual(scope(decide({event: 'pull_request', labels: ['full-ci'], headRef: 'x', files: ['README.md']})), {code: true, native: true});
  assert.deepEqual(scope(decide({event: 'pull_request', labels: [], headRef: 'release/next', files: ['README.md']})), {code: true, native: true});
  assert.deepEqual(scope(decide({event: 'pull_request', labels: null, headRef: 'x', files: ['README.md']})), {code: true, native: true});
  assert.deepEqual(scope(decide({event: 'pull_request', labels: [], headRef: null, files: ['README.md']})), {code: true, native: true});
});

test('website and repository documentation skip every app job', () => {
  for (const file of ['README.md', 'README.en.md', 'README.zh-CN.md', 'website/index.html', 'website/vendor/gsap.min.js',
    'design/pages-d2/feature-inventory.md', 'design-qa.md', '.github/workflows/website.yml',
    'scripts/build-website.mjs', 'scripts/website-seo.mjs', 'scripts/website-seo.test.mjs', 'scripts/render-website-docs.test.mjs']) {
    assert.deepEqual(scope(pr([file])), {code: false, native: false}, file);
  }
});

test('frontend, bundled documentation and frontend-only scripts skip only the native jobs', () => {
  for (const file of ['apps/desktop/src/App.tsx', 'apps/desktop/src/i18n/zh-CN.json', 'apps/desktop/tests/a.test.mjs',
    'apps/desktop/public/icon.svg', 'apps/desktop/index.html', 'apps/desktop/vite.config.ts', 'packages/core/src/a.ts',
    'tsconfig.base.json', 'CHANGELOG.md', 'docs/screenshots/benchmark.zh.webp', 'docs/DOWNLOAD.md',
    'scripts/contract-server.mjs', 'scripts/release-notes.test.mjs', 'scripts/capture-current-screenshots.mjs',
    'scripts/screenshot-fixtures/a.json', 'scripts/render-product-hero.mjs']) {
    assert.deepEqual(scope(pr([file])), {code: true, native: false}, file);
  }
  assert.deepEqual(scope(pr(['README.md', 'apps/desktop/src/App.tsx'])), {code: true, native: false});
});

test('Rust, native setup, CI and every unknown path run the native jobs', () => {
  for (const file of ['crates/runtime-core/src/lib.rs', 'apps/desktop/src-tauri/src/lib.rs', 'apps/desktop/src-tauri/tauri.conf.json',
    'apps/desktop/src-tauri/capabilities/default.json', 'apps/desktop/package.json', 'apps/supervisor/resources/strata_observer.py',
    'apps/supervisor/tests/lifecycle.rs', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'package.json', 'pnpm-lock.yaml',
    'pnpm-workspace.yaml', '.github/workflows/ci.yml', '.github/workflows/release-from-ci.yml', '.github/actions/x/action.yml',
    'scripts/ci-linux-native-tests.mjs', 'scripts/ci-changes.mjs', 'scripts/build-linux-test-keyring.sh',
    'scripts/patches/gnome-keyring-40.0-client-registration.patch', 'scripts/prepare-sidecar.mjs', 'scripts/release-linux-tests.sh',
    'scripts/tests/release-linux-tests-contract.py', 'scripts/release-from-ci.mjs', 'assets/icon.svg', 'LICENSE', '.gitignore',
    'new-directory/file.txt', 'apps/desktop/srcx/a.ts', 'apps/desktop/src-tauri']) {
    assert.deepEqual(scope(pr([file])), {code: true, native: true}, file);
  }
  assert.deepEqual(scope(pr(['README.md', 'apps/desktop/src/App.tsx', 'crates/local-ipc/src/lib.rs'])), {code: true, native: true});
});

test('empty, malformed or traversing change sets fail closed', () => {
  for (const files of [[], undefined, null, 'README.md', [''], ['/etc/passwd'], ['website/../crates/a.rs'], ['./README.md'],
    ['docs//a.md'], ['docs\\a.md'], ['docs/a\nb.md'], [42]]) {
    assert.deepEqual(scope(classify(files)), {code: true, native: true}, JSON.stringify(files));
  }
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'strata-ci-changes-'));
  const git = (...args) => execFileSync('git', args, {cwd: dir, encoding: 'utf8', env: {...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid'}}).trim();
  git('init', '-q', '-b', 'main');
  const write = (file, text) => { mkdirSync(dirname(join(dir, file)), {recursive: true}); writeFileSync(join(dir, file), text); };
  return {dir, git, write};
}

test('a real pull request merge commit lists only the changes relative to its base parent', t => {
  const {dir, git, write} = repo(); t.after(() => rmSync(dir, {recursive: true, force: true}));
  write('crates/a.rs', '1'); write('README.md', '1'); git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature'); write('apps/desktop/src/App.tsx', 'x'); write('docs/old name.md', 'y');
  git('add', '.'); git('commit', '-qm', 'feature');
  git('checkout', '-q', 'main'); write('crates/a.rs', '2'); git('commit', '-qam', 'base moved');
  git('merge', '-q', '--no-ff', '-m', 'merge', 'feature');
  const sha = git('rev-parse', 'HEAD'); const cwd = process.cwd();
  process.chdir(dir);
  try {
    assert.deepEqual(pullRequestFiles(sha).sort(), ['apps/desktop/src/App.tsx', 'docs/old name.md']);
    assert.throws(() => pullRequestFiles('0'.repeat(40)), /workflow commit/);
    const output = join(dir, 'out.txt'); writeFileSync(output, '');
    const decision = main({GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: sha, CI_PR_LABELS: '[]', CI_HEAD_REF: 'feature', GITHUB_OUTPUT: output});
    assert.deepEqual(scope(decision), {code: true, native: false});
    assert.equal(readFileSync(output, 'utf8'), 'code=true\nnative=false\n');
    // A non-merge checkout (for example a shallow or rewritten ref) runs everything.
    git('checkout', '-q', 'HEAD^1');
    assert.deepEqual(scope(main({GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: git('rev-parse', 'HEAD'), CI_PR_LABELS: '[]', GITHUB_OUTPUT: output})), {code: true, native: true});
    assert.deepEqual(scope(main({GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: sha, CI_PR_LABELS: 'not json', GITHUB_OUTPUT: output})), {code: true, native: true});
  } finally { process.chdir(cwd); }
});

test('CI wiring: only native jobs use the native scope, desktop uses code, and the gate is this script', async () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8').replaceAll('\r\n', '\n');
  const jobs = Object.fromEntries(workflow.split('\njobs:\n')[1].split(/\n(?=  [a-z][a-z0-9-]*:\n)/).map(block => [block.match(/^ {2}([a-z0-9-]+):/)[1], block]));
  assert.deepEqual(Object.keys(jobs).sort(), ['changes', 'desktop', 'native-coverage', 'native-linux', 'native-windows', 'observer-compatibility']);
  assert.match(jobs.changes, /name: Detect app code changes/);
  assert.match(jobs.changes, /run: node scripts\/ci-changes\.mjs/);
  assert.doesNotMatch(workflow, /paths-filter/);
  assert.match(jobs.changes, /code: \$\{\{ steps\.set\.outputs\.code \}\}/);
  assert.match(jobs.changes, /native: \$\{\{ steps\.set\.outputs\.native \}\}/);
  for (const name of ['observer-compatibility', 'native-windows', 'native-linux', 'native-coverage']) {
    assert.match(jobs[name], /\n    if: needs\.changes\.outputs\.native == 'true'\n/, name);
  }
  assert.match(jobs.desktop, /\n    if: needs\.changes\.outputs\.code == 'true'\n/);
});
