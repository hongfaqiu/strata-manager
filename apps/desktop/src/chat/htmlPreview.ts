/**
 * HTML that a model wrote in an answer, shown as a page (upstream Strata's "Open preview" on ```html blocks).
 *
 * Security model (see also src-tauri/src/html_preview.rs):
 * - the page runs in <iframe sandbox="allow-scripts"> without allow-same-origin, so it gets an opaque origin: no access to the
 *   parent page, the app's storage, cookies, Tauri globals, forms, popups or top-level navigation;
 * - in the desktop app it is served from the separate `strata-preview` scheme with PREVIEW_CSP as a response header: no network,
 *   which also blocks the `ipc:` protocol behind Tauri commands;
 * - outside the desktop app (browser/server mode) it falls back to `srcdoc` with the same policy as a <meta> tag (srcdoc also
 *   inherits the host page's CSP, which can only make it stricter);
 * - nothing runs until the user opens the preview panel, and never while the answer is still streaming.
 */
export const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'";
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

/** A file name from the page's <title>, safe on every desktop file system. */
export function htmlFileName(html: string): string {
  const title = htmlTitle(html);
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${safe || 'preview'}.html`;
}
