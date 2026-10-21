/**
 * Finding the LaTeX in an answer, following upstream Strata #3268. Pure text work, no rendering.
 *
 * Recognised, as models write them:
 *   $$ ... $$ and \[ ... \]   display math (a block when it fills its lines, otherwise shown as display inside the paragraph)
 *   $ ... $  and \( ... \)    inline math (one line)
 * A dollar that is money stays text: "costs $5 and $10" has no math, because an opening $ must be followed by a non-space and a
 * closing $ must follow a non-space and must not be followed by a digit. `\$` stays a literal dollar sign.
 * Code (fenced blocks and backtick spans) is never searched. An unclosed formula (for example while the answer is still
 * streaming) stays text.
 *
 * The result is Markdown for remark-math with `singleDollarTextMath: false`: every formula we recognise is rewritten as `$$..$$`
 * (inline) or a `$$` fenced block, and every other `$$` is escaped, so remark-math can only ever see the formulas found here.
 */
export const DISPLAY_MARK = '\\displaystyle ';

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** True when the text might hold math, so a plain answer is passed through untouched. */
export function hasMath(text: string): boolean {
  return text.includes('$') || text.includes('\\(') || text.includes('\\[');
}

/** Where the unescaped `close` starts at or after `from` (one line), or -1. */
function findClose(text: string, from: number, close: string): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') return -1;
    if (close.startsWith('\\')) { if (c === '\\' && text.startsWith(close, i)) return i; if (c === '\\') i++; continue; }
    if (c === '\\') { i++; continue; }
    if (text.startsWith(close, i)) {
      if (close === '$' && text[i + 1] === '$') return -1; // "$a$$" is not a closed inline formula
      return i;
    }
  }
  return -1;
}

const inlineMath = (tex: string, display: boolean) => `$$${display ? DISPLAY_MARK : ''}${tex}$$`;
const usable = (tex: string) => !!tex.trim() && !tex.includes('$$') && !/^\$|\$$/.test(tex);

/** One stretch of prose (no code inside): formulas become `$$..$$`, stray `$$` are escaped, other text is kept verbatim. */
function convertProse(text: string): string {
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '\\') {
      const next = text[i + 1];
      if (next === '(' || next === '[') {
        const end = findClose(text, i + 2, next === '(' ? '\\)' : '\\]'), tex = end > 0 ? text.slice(i + 2, end) : '';
        if (end > 0 && usable(tex)) { out += inlineMath(tex, next === '['); i = end + 2; continue; }
      }
      out += next === undefined ? c : c + next; i += 2; continue;
    }
    if (c === '$') {
      if (text[i + 1] === '$') {
        const end = findClose(text, i + 2, '$$'), tex = end > 0 ? text.slice(i + 2, end) : '';
        if (end > 0 && usable(tex)) { out += inlineMath(tex, true); i = end + 2; continue; }
        out += '\\$\\$'; i += 2; continue;
      }
      if (!isSpace(text[i + 1])) {
        const end = findClose(text, i + 1, '$'), tex = end > 0 ? text.slice(i + 1, end) : '';
        if (end > i + 1 && !isSpace(text[end - 1]) && !isDigit(text[end + 1]) && usable(tex)) { out += inlineMath(tex, false); i = end + 1; continue; }
      }
    }
    out += c; i++;
  }
  return out;
}

/** A line with its backtick code spans kept as they are (a span closes on a run of the same length). */
function convertLine(line: string): string {
  if (!hasMath(line)) return line;
  let out = '', last = 0;
  for (let i = 0; i < line.length;) {
    if (line[i] !== '`') { i++; continue; }
    let n = i; while (line[n] === '`') n++;
    const run = n - i;
    let close = -1;
    for (let j = n; j < line.length;) {
      if (line[j] !== '`') { j++; continue; }
      let k = j; while (line[k] === '`') k++;
      if (k - j === run) { close = k; break; }
      j = k;
    }
    if (close < 0) { i = n; continue; }
    out += convertProse(line.slice(last, i)) + line.slice(i, close); last = i = close;
  }
  return out + convertProse(line.slice(last));
}

/**
 * Display math that fills its lines: `$$ x $$` alone on a line, or `$$` / `\[` opening a line up to the line that closes it.
 * Returns the formula lines and how many source lines it used, or null (unclosed, or text after the closing delimiter).
 */
export function displayBlock(lines: string[], at: number): { indent: string; tex: string[]; used: number } | null {
  const line = lines[at]!, trimmed = line.trimStart(), indent = line.slice(0, line.length - trimmed.length);
  const first = trimmed.trimEnd();
  const opens = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : '';
  if (!opens) return null;
  const closes = opens === '$$' ? '$$' : '\\]';
  const rest = first.slice(2), same = rest.indexOf(closes);
  if (same >= 0) return rest.slice(same + closes.length).trim() || !usable(rest.slice(0, same)) ? null : { indent, tex: [rest.slice(0, same).trim()], used: 1 };
  const tex = rest.trim() ? [rest.trim()] : [];
  for (let j = at + 1; j < lines.length && j < at + 200; j++) {
    const t = lines[j]!.trim(), end = t.indexOf(closes);
    if (end >= 0) {
      if (t.slice(end + closes.length).trim()) return null;
      if (t.slice(0, end).trim()) tex.push(t.slice(0, end).trim());
      return tex.some(part => part.includes('$$')) || !tex.join('').trim() ? null : { indent, tex, used: j - at + 1 };
    }
    tex.push(lines[j]!.trim());
  }
  return null;
}

/** Rewrite an answer's math for remark-math (see the module comment). Text without math comes back unchanged. */
export function prepareMathMarkdown(text: string): string {
  if (!hasMath(text)) return text;
  const lines = text.split('\n'), out: string[] = [];
  let fence: { char: string; size: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, marker = /^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+|>\s*)*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.size && !line.slice(marker[0].length).trim()) fence = null;
      out.push(line); continue;
    }
    if (marker) { fence = { char: marker[1]![0]!, size: marker[1]!.length }; out.push(line); continue; }
    const block = displayBlock(lines, i);
    if (block) { out.push(`${block.indent}$$`, ...block.tex.map(part => block.indent + part), `${block.indent}$$`); i += block.used - 1; continue; }
    out.push(convertLine(line));
  }
  return out.join('\n');
}
