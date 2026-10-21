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
 * - nothing runs until the user switches to Preview, and never while the answer is still streaming.
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

/** A file name from the page's <title>, safe on every desktop file system. */
export function htmlFileName(html: string): string {
  const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${safe || 'preview'}.html`;
}
