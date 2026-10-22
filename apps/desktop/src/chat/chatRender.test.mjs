// Chat rendering: LaTeX (upstream Strata #3268), ```html previews and their sandbox policy.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import katex from 'katex';

const root = fileURLToPath(new URL('../..', import.meta.url));
const server = await createServer({ configFile: false, root, server: { middlewareMode: true }, clearScreen: false, logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } });
const math = await server.ssrLoadModule('/src/chat/chatMath.ts');
const html = await server.ssrLoadModule('/src/chat/htmlPreview.ts');
test.after(() => server.close());

const { prepareMathMarkdown: prep, hasMath, displayBlock, DISPLAY_MARK } = math;

test('inline and display forms become remark-math syntax', () => {
  assert.equal(prep('a sphere of radius $r \\le R$ here'), 'a sphere of radius $$r \\le R$$ here');
  assert.equal(prep('so \\(x^2\\) and \\[y^2\\]'), `so $$x^2$$ and $$${DISPLAY_MARK}y^2$$`);
  assert.equal(prep('then $$g = -k r$$ done'), `then $$${DISPLAY_MARK}g = -k r$$ done`);
  assert.equal(prep('$$\n\\oint g = 1\n$$\nafter'), '$$\n\\oint g = 1\n$$\nafter');
  assert.equal(prep('$$ a = b $$'), '$$\na = b\n$$');
  assert.equal(prep('\\[\nx\n\\]'), '$$\nx\n$$');
  assert.equal(prep('  - item\n    $$x$$'), '  - item\n    $$\n    x\n    $$');
  assert.equal(prep('plain words'), 'plain words');
});

test('money, escaped dollars and unclosed math stay text', () => {
  for (const text of ['it costs $5 and $10 in total', 'only $5 here', 'a \\$5 and a \\$7 fee', 'between $5-$10', 'price $ 5 $ each']) assert.equal(prep(text), text, text);
  assert.equal(prep('an open $$ x + y'), 'an open \\$\\$ x + y');
  assert.equal(prep('start $a\nb$ end'), 'start $a\nb$ end');
  assert.equal(displayBlock(['$$', 'x'], 0), null);
  assert.equal(displayBlock(['$$a$$ and more'], 0), null);
  assert.equal(hasMath('no math here'), false);
});

test('code spans and fenced code are never searched', () => {
  assert.equal(prep('run `echo $HOME and $PATH` then $x$'), 'run `echo $HOME and $PATH` then $$x$$');
  const fenced = '```bash\necho "$a" "$b"\n$$ not math $$\n```\nand $y$';
  assert.equal(prep(fenced), '```bash\necho "$a" "$b"\n$$ not math $$\n```\nand $$y$$');
  assert.equal(prep('~~~\n$x$\n~~~'), '~~~\n$x$\n~~~');
});

test('every streaming prefix converts without throwing', () => {
  const answer = 'Gauss: $r \\le R$\n\n$$\n\\oint \\vec g \\cdot d\\vec A = -4\\pi G M\n$$\n\ncosts $5, `$x$`, \\(a\\) and \\[b\\]';
  for (let i = 0; i <= answer.length; i++) assert.equal(typeof prep(answer.slice(0, i)), 'string');
});

test('the formulas found draw with KaTeX, and trust stays off', () => {
  const found = ['r \\le R', '\\oint \\vec{g}\\cdot d\\vec{A} = -4\\pi G\\, M_{\\text{enc}}(r)', '\\boxed{g(r) = -\\frac{4\\pi G\\rho}{3}\\,r}'];
  for (const tex of found) {
    const out = katex.renderToString(tex, { throwOnError: false, strict: 'ignore', trust: false });
    assert.ok(out.includes('class="katex') && !out.includes('katex-error'), tex);
  }
  assert.ok(!katex.renderToString('\\href{https://example.com}{x}', { throwOnError: false, strict: 'ignore', trust: false }).includes('<a '));
});

test('the message view draws math and keeps money as text (server render)', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = await import('react');
  await server.ssrLoadModule('/src/i18n.ts');
  const { ChatMessageView } = await server.ssrLoadModule('/src/ChatMessageView.tsx');
  const view = (content, streaming = false) => renderToStaticMarkup(React.createElement(ChatMessageView, { message: { id: 'm', role: 'assistant', content, createdAt: 0 }, language: 'en', showReasoning: false, streaming, stateLabel: s => s, onCopy: () => {} }));
  assert.match(view('Radius $r = 2$ here'), /st-math st-math--source">\$r = 2\$/);
  assert.match(view('$$\nx = 1\n$$'), /st-math-block/);
  assert.ok(!view('costs $5 and $10').includes('st-math'));
  // a ```html block starts collapsed to its header; nothing runs on the server, and Preview waits for the finished answer
  const page = view('```html\n<title>Demo page</title>\n<p>hi</p><script>alert(1)</script>\n```');
  assert.match(page, /st-code--html" data-expanded="false"/); assert.match(page, /aria-expanded="false"/);
  assert.match(page, /<pre id="[^"]+" hidden="">/); assert.match(page, /Demo page/); assert.match(page, /2 lines/);
  assert.ok(!page.includes('<iframe')); assert.ok(!page.includes('<script>'));
  const { HtmlPreviewContext } = await server.ssrLoadModule('/src/chat/htmlPreviewContext.ts');
  const hosted = (content, streaming, activeId) => renderToStaticMarkup(React.createElement(HtmlPreviewContext.Provider, { value: { activeId, open: () => {} } }, React.createElement(ChatMessageView, { message: { id: 'm', role: 'assistant', content, createdAt: 0 }, language: 'en', showReasoning: false, streaming, stateLabel: s => s, onCopy: () => {} })));
  assert.match(hosted('```html\n<p>hi</p>', true), /class="st-code__preview" aria-pressed="false" disabled=""/);
  assert.match(hosted('```html\n<p>hi</p>\n```', false, 'm:0'), /class="st-code__preview" aria-pressed="true">/);
  assert.ok(!page.includes('st-code__preview'), 'no Preview button without the chat page hosting the panel');
});

test('the preview policy forbids the network and parent access, and matches the native scheme', async () => {
  const { PREVIEW_CSP, PREVIEW_SANDBOX, withPreviewPolicy, htmlFileName, isHtmlLanguage } = html;
  assert.equal(PREVIEW_SANDBOX, 'allow-scripts');
  for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "base-uri 'none'"]) assert.ok(PREVIEW_CSP.includes(directive), directive);
  assert.ok(!/https?:|ipc:|'self'|\*/.test(PREVIEW_CSP));
  const native = await readFile(new URL('../../src-tauri/src/html_preview.rs', import.meta.url), 'utf8');
  assert.ok(native.includes(`"${PREVIEW_CSP}; sandbox allow-scripts"`), 'native CSP = PREVIEW_CSP + sandbox');
  const conf = JSON.parse(await readFile(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.match(conf.app.security.csp, /frame-src strata-preview: http:\/\/strata-preview\.localhost/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(conf.app.security.csp), 'the app itself still forbids inline scripts');
  assert.ok(withPreviewPolicy('<!DOCTYPE html><html><body>x</body></html>').startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"'));
  assert.ok(withPreviewPolicy('<p>x</p>').startsWith('<meta http-equiv="Content-Security-Policy"'));
  assert.equal(htmlFileName('<title>My: page / 1</title>'), 'My page 1.html');
  assert.equal(htmlFileName('<p>none</p>'), 'preview.html');
  assert.ok(isHtmlLanguage('HTML') && isHtmlLanguage('htm') && !isHtmlLanguage('xml'));
});

// Regression (#114 follow-up): Preview snapped back to Code. ChatMessageView passed `components={{pre:()=>…}}` to ReactMarkdown, a new
// component type on every render, and App's `notify` was a new function each render, so every metric poll remounted each code
// block and reset its state. The element types must be module-level and the callbacks stable.
test('code blocks keep their state across re-renders (stable Markdown components, stable callbacks)', async () => {
  const view = await server.ssrLoadModule('/src/ChatMessageView.tsx');
  const again = await server.ssrLoadModule('/src/ChatMessageView.tsx');
  assert.equal(typeof view.chatMarkdownComponents.pre, 'function');
  assert.equal(view.chatMarkdownComponents, again.chatMarkdownComponents);
  const source = await readFile(new URL('../ChatMessageView.tsx', import.meta.url), 'utf8');
  assert.ok(!/components=\{\{/.test(source), 'no inline components object for ReactMarkdown');
  assert.match(source, /components=\{chatMarkdownComponents\}/);
  const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.match(app, /const notify = useCallback\(/, 'the chat onMessage callback is stable');
  assert.match(app, /const copy = useCallback\(/, 'the chat onCopy callback is stable');
});

test('preview panel width stays between its minimum and a usable chat', () => {
  const { clampPreviewWidth, PREVIEW_WIDTH, htmlTitle, lineCount } = html;
  assert.equal(clampPreviewWidth(100, 1400), PREVIEW_WIDTH.min);
  assert.equal(clampPreviewWidth(5000, 1400), 1400 - PREVIEW_WIDTH.chatMin);
  assert.equal(clampPreviewWidth(600, 1400), 600);
  assert.equal(clampPreviewWidth(Number.NaN, 1400), PREVIEW_WIDTH.fallback);
  assert.equal(clampPreviewWidth(600, 500), PREVIEW_WIDTH.min);
  assert.equal(htmlTitle('<title> My\n page </title>'), 'My page'); assert.equal(htmlTitle('<p>x</p>'), '');
  assert.equal(lineCount('a\nb\nc'), 3); assert.equal(lineCount(''), 0);
});
