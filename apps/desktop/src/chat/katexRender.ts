/**
 * Loaded on demand by MathView: KaTeX, its stylesheet and (through the stylesheet) its woff2 fonts are bundled with the app as a
 * separate chunk, so an answer without math never downloads them and nothing is fetched from the network.
 */
import katex from 'katex';
import 'katex/dist/katex.min.css';

const drawn = new Map<string, string>();
/** trust stays off (no \href, \url, \includegraphics, \htmlClass…); a broken formula renders as its red source, never throws. */
export function renderMath(tex: string, display: boolean): string {
  const key = (display ? 'D' : 'I') + tex, known = drawn.get(key);
  if (known !== undefined) return known;
  const html = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, maxSize: 30, maxExpand: 500, output: 'htmlAndMathml' });
  if (drawn.size > 400) drawn.clear();
  drawn.set(key, html);
  return html;
}
