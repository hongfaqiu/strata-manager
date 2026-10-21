/**
 * One formula of an answer (upstream Strata #3268). Until the KaTeX chunk has loaded, and if it cannot load, the formula shows as
 * its source text.
 */
import { useEffect, useState } from 'react';
import { DISPLAY_MARK } from './chatMath';
import './chat-render.css';

type Render = (tex: string, display: boolean) => string;
let loading: Promise<Render> | null = null;
let ready: Render | null = null;
export function loadMath(): Promise<Render> {
  loading ??= import('./katexRender').then(module => (ready = module.renderMath));
  return loading;
}

export function MathView({ tex: raw, block }: { tex: string; block?: boolean }) {
  const display = block || raw.startsWith(DISPLAY_MARK), tex = raw.startsWith(DISPLAY_MARK) ? raw.slice(DISPLAY_MARK.length) : raw;
  const [html, setHtml] = useState<string | null>(() => ready ? ready(tex, display) : null);
  useEffect(() => {
    let live = true;
    if (ready) { setHtml(ready(tex, display)); return; }
    loadMath().then(render => { if (live) setHtml(render(tex, display)); }).catch(() => { /* stays as source text */ });
    return () => { live = false; };
  }, [tex, display]);
  const cls = `st-math${display ? ' st-math--display' : ''}${block ? ' st-math--block' : ''}`;
  if (html === null) return <code className={`${cls} st-math--source`}>{display ? `$$${tex}$$` : `$${tex}$`}</code>;
  return <span className={cls} dangerouslySetInnerHTML={{ __html: html }}/>;
}
