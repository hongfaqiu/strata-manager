/**
 * HTML that a model wrote in an answer, shown as a page (upstream Strata's "Open preview" on ```html blocks).
 *
 * Security model (see also src-tauri/src/html_preview.rs):
 * - the page runs in <iframe sandbox="allow-scripts"> without allow-same-origin, so it gets an opaque origin: no access to the
 *   parent page, the app's storage, cookies, Tauri globals, forms, popups or top-level navigation;
 * - it may use the internet, but only over https:/wss: (CDNs, web fonts, APIs). Plain http: and ipc: stay blocked, which keeps
 *   Tauri's IPC endpoints (ipc://localhost, http://ipc.localhost on Windows) and local http services out of reach; IPC also
 *   rejects the opaque `Origin: null` and needs an invoke key that only the main frame has;
 * - in the desktop app it is served from the separate `strata-preview` scheme with PREVIEW_CSP (+ `sandbox allow-scripts`) as a
 *   response header; outside the desktop app (browser/server mode) it falls back to `srcdoc` with the same policy as a <meta>
 *   tag (srcdoc also inherits the host page's CSP, which can only make it stricter);
 * - nothing runs until the user opens the preview panel, and never while the answer is still streaming;
 * - "Open in browser" leaves the app: the desktop app writes a copy to its cache and hands it to the default browser; browser
 *   mode opens a tab whose only content is the same sandboxed srcdoc frame (a bare blob: page would share the app's origin).
 */
export const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:; style-src 'unsafe-inline' https: data:; img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src https: wss: data: blob:; worker-src blob:; frame-src 'none'; child-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'";
export const PREVIEW_SANDBOX = 'allow-scripts';
export const PREVIEW_SCHEME = 'strata-preview';
export const MAX_PREVIEW_CHARS = 4 * 1024 * 1024;

export const isHtmlLanguage = (language: string) => /^(html|htm|xhtml)$/i.test(language.trim());

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The document for a srcdoc frame: the no-network policy goes first (after a doctype, so standards mode is kept). */
export function withPreviewPolicy(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(PREVIEW_CSP)}"><meta name="referrer" content="no-referrer">`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + meta + html.slice(doctype[0].length) : meta + html;
}

/** The page's own <title>, if it has a short one. */
export const htmlTitle = (html: string): string => (/<title[^>]*>([^<]{1,120})<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();

/** Lines in a code block, as shown in its collapsed header. */
export const lineCount = (code: string): number => code ? code.split('\n').length : 0;

/** Preview panel width: what the user dragged to, kept within the space next to a usable chat. */
export const PREVIEW_WIDTH = { min: 320, fallback: 520, chatMin: 380, storageKey: 'strata-manager.chat.htmlPreviewWidth' } as const;
export function clampPreviewWidth(width: number, available: number): number {
  const max = Math.max(PREVIEW_WIDTH.min, available - PREVIEW_WIDTH.chatMin);
  return Math.round(Math.min(Math.max(Number.isFinite(width) ? width : PREVIEW_WIDTH.fallback, PREVIEW_WIDTH.min), max));
}

/**
 * Browser mode "Open in browser": a script-free page whose only content is the sandboxed preview, filling the tab.
 * No CSP on this wrapper on purpose: a srcdoc frame inherits its parent's policy, and the frame carries PREVIEW_CSP itself.
 */
export function sandboxedTabDocument(html: string): string {
  const title = htmlTitle(html).replace(/&/g, '&amp;').replace(/</g, '&lt;') || 'Preview';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${title}</title><style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe sandbox="${PREVIEW_SANDBOX}" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(withPreviewPolicy(html))}"></iframe></body></html>`;
}

/** A file name from the page's <title>, safe on every desktop file system. */
export function htmlFileName(html: string): string {
  const title = htmlTitle(html);
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${safe || 'preview'}.html`;
}
