import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Trash2 } from 'lucide-react';

export interface ModelConfigurationOption {
  value: string;
  name: string;
  summary?: string;
  modifiedAt?: number | null;
  lastActivatedAt?: number | null;
  filePath: string;
  sourcePath?: string;
  state?: 'current' | 'lastUsed' | 'preparing';
  stateLabel?: string;
}

interface Props {
  value: string;
  options: ModelConfigurationOption[];
  language: AppLanguage;
  ariaLabel: string;
  modifiedLabel: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
  onDelete?: (value: string) => void;
}

function OptionContent({ option, language, modifiedLabel, compact = false }: { option: ModelConfigurationOption; language: Props['language']; modifiedLabel: string; compact?: boolean }) {
  const hasDate = typeof option.modifiedAt === 'number' && Number.isFinite(option.modifiedAt) && option.modifiedAt > 0;
  const hasActivation = typeof option.lastActivatedAt === 'number' && Number.isFinite(option.lastActivatedAt) && option.lastActivatedAt > 0;
  const lastActivated = language === 'zh-CN' ? '上次启用' : 'Last activated';
  const pathTitle = option.sourcePath && option.sourcePath !== option.filePath ? `${option.filePath}\n${language === 'zh-CN' ? '来源' : 'Source'}: ${option.sourcePath}` : option.filePath;
  return <span className="model-configuration-copy">
    <span className="model-configuration-name"><strong data-tooltip={pathTitle}>{option.name}</strong>{option.stateLabel && <em className={`model-configuration-state ${option.state ?? ''}`}>{option.stateLabel}</em>}</span>
    {option.summary && <span className="model-configuration-summary">{option.summary.split(' · ').map(stat => <span className="model-configuration-stat" key={stat}>{stat}</span>)}</span>}
    {!compact && <span className="model-configuration-times">{hasDate && <time dateTime={new Date(option.modifiedAt!).toISOString()}>{modifiedLabel} · {new Date(option.modifiedAt!).toLocaleString(language)}</time>}{hasActivation && <time dateTime={new Date(option.lastActivatedAt!).toISOString()}>{lastActivated} · {new Date(option.lastActivatedAt!).toLocaleString(language)}</time>}</span>}
  </span>;
}

/** Browsing changes only the displayed configuration. Runtime actions remain explicit. */
export function ModelConfigurationDropdown({ value, options, language, ariaLabel, modifiedLabel, disabled = false, onValueChange, onDelete }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const search = useRef({ text: '', at: 0 });
  const selectedIndex = options.findIndex(option => option.value === value);
  const selected = options[selectedIndex] ?? options[0];
  const menuId = `${id}-configurations`;
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus({ preventScroll: true }); };
  const choose = (index: number) => { const option = options[index]; if (!option || disabled) return; onValueChange(option.value); close(true); };
  const remove = (index: number) => { const option = options[index]; if (!option || disabled || !onDelete) return; close(true); onDelete(option.value); };
  const show = (last = false) => { if (!disabled && options.length) { setActive(selectedIndex >= 0 ? selectedIndex : last ? options.length - 1 : 0); setOpen(true); } };

  useEffect(() => { if (disabled || !options.length) setOpen(false); }, [disabled, options.length]);
  useEffect(() => { if (active >= options.length) setActive(Math.max(0, options.length - 1)); }, [active, options.length]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = root.current?.getBoundingClientRect(); if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
      const upside = below < 180 && above > below;
      const width = Math.min(Math.max(rect.width, 420), 680, window.innerWidth - 24);
      setPosition({ position: 'fixed', width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), ...(upside ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }), maxHeight: Math.max(40, Math.min(440, upside ? above : below)) });
    };
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!root.current?.contains(target) && !menu.current?.contains(target)) close(); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } };
    place(); document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true); window.addEventListener('resize', place); document.addEventListener('scroll', place, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => { if (open) menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active, open]);

  const keyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Tab') {
      const action = open && onDelete && !event.shiftKey ? menu.current?.querySelector<HTMLButtonElement>(`[data-delete-index="${active}"]`) : null;
      if (action) { event.preventDefault(); action.focus(); } else close();
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (!open) { show(event.key === 'ArrowUp' || event.key === 'End'); return; }
      if (event.key === 'Enter' || event.key === ' ') { choose(active); return; }
      if (event.key === 'Home') setActive(0);
      else if (event.key === 'End') setActive(options.length - 1);
      else setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now(); search.current = { text: `${now - search.current.at < 700 ? search.current.text : ''}${event.key}`.toLowerCase(), at: now };
      const index = options.findIndex(option => option.name.toLowerCase().startsWith(search.current.text));
      if (index >= 0) { setActive(index); setOpen(true); }
    }
  };
  return <div className="model-configuration-dropdown" ref={root}>
    <button className="model-configuration-trigger" type="button" role="combobox" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId} aria-activedescendant={open ? `${id}-option-${active}` : undefined} data-tooltip={language === 'zh-CN' ? '选择配置后，点击启用才会切换模型' : 'Choose a configuration, then enable it to switch models'} disabled={disabled || !options.length} ref={trigger} onKeyDown={keyboard} onClick={() => open ? close() : show()}>
      {selected && <OptionContent option={selected} language={language} modifiedLabel={modifiedLabel} compact/>}<ChevronDown size={17}/>
    </button>
    {open && createPortal(<div className="official-surface model-configuration-menu" role="listbox" id={menuId} aria-label={ariaLabel} style={position} ref={menu}>
      {options.map((option, index) => <div className={`model-configuration-row${onDelete ? ' has-delete' : ''}`} key={option.value} onPointerMove={() => setActive(index)}>
        <button type="button" className={`model-configuration-option${index === active ? ' is-active' : ''}`} role="option" aria-selected={option.value === value} id={`${id}-option-${index}`} tabIndex={-1} data-index={index} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
          <OptionContent option={option} language={language} modifiedLabel={modifiedLabel}/><span className="model-configuration-selected">{option.value === value && <Check size={16}/>}</span>
        </button>
        {onDelete && <button type="button" className="model-configuration-delete" aria-label={`${language === 'zh-CN' ? '删除配置文件' : 'Delete configuration file'} ${option.name}`} data-tooltip={language === 'zh-CN' ? '删除配置文件' : 'Delete configuration file'} data-delete-index={index} tabIndex={index === active ? 0 : -1} disabled={disabled} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); remove(index); }} onKeyDown={event => { if (event.key === 'Tab') { if (event.shiftKey) { event.preventDefault(); trigger.current?.focus(); } else close(true); } }}><Trash2 size={15}/></button>}
      </div>)}
    </div>, document.body)}
  </div>;
}
