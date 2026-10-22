import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye } from 'lucide-react';
import { OfficialCopyButton } from '../OfficialCopyButton';
import { OfficialIcon } from '../OfficialIcon';
import './chat-render.css';
import { htmlTitle, lineCount } from './htmlPreview';
import { useHtmlPreviewHost } from './htmlPreviewContext';

/**
 * A ```html block: collapsed to one header row (language, page title, line count, copy, Preview); the code opens on click.
 * Preview hands the page to the chat's side panel, which runs it sandboxed, and only once the answer is complete.
 */
export function HtmlCodeBlock({ id, code, language, streaming, children, onCopy }: {
  id: string; code: string; language: string; streaming: boolean; children: React.ReactNode;
  onCopy: (value: string) => void | Promise<boolean | void>;
}) {
  const { t } = useTranslation();
  const host = useHtmlPreviewHost();
  const [expanded, setExpanded] = useState(false);
  const body = useId();
  const title = htmlTitle(code), lines = lineCount(code), active = host?.activeId === id;
  return <div className="st-code st-code--html" data-expanded={expanded} data-previewing={active || undefined}>
    <div className="st-code__head">
      <button type="button" className="st-code__toggle" aria-expanded={expanded} aria-controls={body} data-tooltip={expanded ? t('htmlCollapseCode') : t('htmlExpandCode')} onClick={() => setExpanded(value => !value)}>
        <OfficialIcon name="chevron" size={16} className="st-code__chev"/>
        <span className="st-code__lang">{language}</span>
        {title && <span className="st-code__title" data-tooltip={title}>{title}</span>}
        <span className="st-code__lines">{t('htmlLineCount', { count: lines })}</span>
      </button>
      <div className="st-code__tools">
        <OfficialCopyButton value={code} onCopy={onCopy} label={t('copyCode')} size={16}/>
        {host && <span className="st-html-toggle" data-tooltip={streaming ? t('htmlPreviewStreaming') : undefined}>
          <button type="button" className="st-code__preview" aria-pressed={active} disabled={streaming} onClick={() => host.open({ id, code, title })}><Eye size={14} aria-hidden="true"/>{t('htmlPreviewTab')}</button>
        </span>}
      </div>
    </div>
    <pre id={body} hidden={!expanded}>{children}</pre>
  </div>;
}
