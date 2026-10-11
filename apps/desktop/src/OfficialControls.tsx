import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { OfficialIcon } from './OfficialIcon';

export interface DropdownOption { value: string; label: string; disabled?: boolean; icon?: ReactNode }
export interface DropdownProps {
  value: string; options: DropdownOption[]; onValueChange: (value: string) => void; ariaLabel: string;
  disabled?: boolean; placeholder?: string; compact?: boolean; editable?: boolean; className?: string; id?: string;
  editableDisplayValue?: string; onInputChange?: (value: string) => void;
}

/** A custom listbox: no native select, option, datalist or hidden select is mounted. */
export function Dropdown({ value, options, onValueChange, ariaLabel, disabled = false, placeholder, compact = false, editable = false, className = '', id, editableDisplayValue, onInputChange }: DropdownProps) {
  const { t } = useTranslation();
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>({});
  const search = useRef({ text: '', at: 0 });
  const selected = options.find(option => option.value === value);
  const inputValue = editableDisplayValue ?? value;
  const visible = editable && inputValue && !selected ? options.filter(option => (editableDisplayValue === undefined ? `${option.label} ${option.value}` : option.label).toLowerCase().includes(inputValue.toLowerCase())) : options;
  const enabled = visible.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
  const selectedIndex = visible.findIndex(option => option.value === value && !option.disabled);
  const openMenu = (last = false) => { if (!disabled) { setActive(selectedIndex >= 0 ? selectedIndex : (last ? enabled.at(-1) : enabled[0]) ?? -1); setOpen(true); } };
  const closeMenu = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus({ preventScroll: true }); };
  const choose = (index: number) => { const option = visible[index]; if (option && !option.disabled) { onValueChange(option.value); closeMenu(true); } };
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = root.current?.getBoundingClientRect(); if (!rect) return;
      const below = innerHeight - rect.bottom - 12, above = rect.top - 12;
      const upside = below < 160 && above > below;
      const width = Math.min(Math.max(rect.width, compact ? 200 : rect.width), innerWidth - 24);
      setPosition({ position: 'fixed', width, left: Math.max(12, Math.min(rect.left, innerWidth - width - 12)), ...(upside ? { bottom: innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }), maxHeight: Math.max(80, Math.min(320, upside ? above : below)) });
    };
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!root.current?.contains(target) && !menu.current?.contains(target)) closeMenu(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); } };
    place(); document.addEventListener('pointerdown', outside); window.addEventListener('resize', place); document.addEventListener('scroll', place, true); document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); document.removeEventListener('keydown', escape, true); };
  }, [open, compact]);
  useEffect(() => { if (open && !enabled.includes(active)) setActive(enabled[0] ?? -1); }, [open, active, enabled.join(',')]);
  useEffect(() => { if (open) menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active, open]);
  const keyboard = (event: React.KeyboardEvent) => {
    if (event.key === 'Tab') { closeMenu(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key) && !(editable && (event.key === ' ' || (!open && event.key === 'Enter')))) {
      event.preventDefault();
      if (!open) { openMenu(event.key === 'ArrowUp' || event.key === 'End'); return; }
      if (event.key === 'Enter' || event.key === ' ') { choose(active); return; }
      const current = enabled.indexOf(active);
      if (event.key === 'Home') setActive(enabled[0] ?? -1);
      else if (event.key === 'End') setActive(enabled.at(-1) ?? -1);
      else setActive(enabled[(current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length] ?? -1);
    } else if (!editable && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now(); search.current.text = now - search.current.at < 700 ? search.current.text + event.key : event.key; search.current.at = now;
      const match = visible.findIndex(option => !option.disabled && option.label.toLowerCase().startsWith(search.current.text.toLowerCase()));
      if (match >= 0) { setOpen(true); setActive(match); }
    }
  };
  const aria = { id, role: 'combobox', 'aria-label': ariaLabel, 'aria-haspopup': 'listbox' as const, 'aria-expanded': open, 'aria-controls': `${uid}-listbox`, 'aria-activedescendant': open && active >= 0 ? `${uid}-option-${active}` : undefined };
  const target = root.current?.closest('[role="dialog"]') ?? document.body;
  return <div className={`official-dropdown ${compact ? 'compact' : ''} ${editable ? 'editable' : ''} ${className}`} ref={root}>
    {editable ? <div className="official-combobox-input"><input {...aria} ref={element => { trigger.current = element; }} autoComplete="off" value={inputValue} placeholder={placeholder} disabled={disabled} onKeyDown={keyboard} onFocus={() => openMenu()} onChange={event => { (onInputChange ?? onValueChange)(event.target.value); setActive(0); setOpen(true); }} /><button type="button" tabIndex={-1} className="official-combobox-arrow" aria-label={ariaLabel} disabled={disabled} onClick={() => { if (open) closeMenu(true); else openMenu(); }}><OfficialIcon name="chevron" size={16} /></button></div> : <button type="button" {...aria} className="official-dropdown-trigger" ref={element => { trigger.current = element; }} disabled={disabled} onKeyDown={keyboard} onClick={() => open ? closeMenu() : openMenu()}><span>{selected?.icon}{selected?.label ?? placeholder ?? value}</span><OfficialIcon name="chevron" size={16} /></button>}
    {open && createPortal(<div ref={menu} className="official-dropdown-menu" role="listbox" id={`${uid}-listbox`} aria-label={ariaLabel} style={position} onKeyDown={keyboard}>{visible.length ? visible.map((option, index) => <div id={`${uid}-option-${index}`} key={option.value} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined} data-index={index} className={`official-dropdown-option ${active === index ? 'highlighted' : ''} ${option.value === value ? 'selected' : ''}`} onPointerDown={event => event.preventDefault()} onPointerMove={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(index)}><span>{option.icon}{option.label}</span>{option.value === value && <OfficialIcon name="check" size={16} />}</div>) : <div className="official-dropdown-empty">{t('empty')}</div>}</div>, target)}
  </div>;
}

export function Toggle({ checked, onCheckedChange, ariaLabel, disabled = false, title, id }: { checked: boolean; onCheckedChange: (checked: boolean) => void; ariaLabel: string; disabled?: boolean; title?: string; id?:string }) {
  return <button id={id} className="st-toggle official-toggle" type="button" role="switch" aria-label={ariaLabel} aria-checked={checked} disabled={disabled} title={title} onClick={() => onCheckedChange(!checked)} />;
}

export function Segmented({ value, options, onValueChange, ariaLabel, id }: { value: string; options: DropdownOption[]; onValueChange: (value: string) => void; ariaLabel: string; id?:string }) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (event: React.KeyboardEvent, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const available = options.map((option, i) => option.disabled ? -1 : i).filter(i => i >= 0); const position = available.indexOf(index);
    const next = event.key === 'Home' ? available[0] : event.key === 'End' ? available.at(-1) : available[(position + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length];
    if (next !== undefined) { onValueChange(options[next]!.value); ref.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus(); }
  };
  return <div id={id} className="seg official-segmented" role="radiogroup" aria-label={ariaLabel} ref={ref}>{options.map((option, index) => <button type="button" role="radio" aria-label={option.label} aria-checked={option.value === value} tabIndex={option.value === value || (!options.some(o => o.value === value) && index === 0) ? 0 : -1} key={option.value} disabled={option.disabled} onClick={() => onValueChange(option.value)} onKeyDown={event => move(event, index)}>{option.icon}{option.label}</button>)}</div>;
}

export function Slider({ value, min, max, step, onValueChange, ariaLabel, disabled, id }: { value: number; min: number; max: number; step: number; onValueChange: (value: number) => void; ariaLabel: string; disabled?: boolean; id?:string }) {
  const percent = Math.max(0, Math.min(100, (value - min) / (max - min) * 100));
  return <input id={id} className="st-slider official-slider" type="range" aria-label={ariaLabel} min={min} max={max} step={step} value={value} disabled={disabled} onChange={event => onValueChange(Number(event.target.value))} style={{ '--range-progress': `${percent}%` } as CSSProperties} />;
}

/** Native numeric semantics and keyboard increments, with entirely custom text-field appearance. */
export function NumberField(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return <input {...props} type="number" className={`official-number-field ${props.className ?? ''}`} />;
}

const dialogRootIsolation = new WeakMap<HTMLElement, { count: number; originalInert: boolean; originalAriaHidden: string | null; originalFocus: HTMLElement | null }>();
const dialogPanels: HTMLElement[] = [];

/** Nested dialogs share one root lock; only the last cleanup restores its original state. */
function isolateDialogRoot(app: HTMLElement, previous: HTMLElement | null): () => HTMLElement | null {
  let state = dialogRootIsolation.get(app);
  if (!state) {
    state = { count: 0, originalInert: app.inert, originalAriaHidden: app.getAttribute('aria-hidden'), originalFocus: previous };
    dialogRootIsolation.set(app, state);
  }
  const acquired = state;
  acquired.count++;
  app.inert = true;
  app.setAttribute('aria-hidden', 'true');
  let released = false;
  return () => {
    if (released) return null;
    released = true;
    acquired.count--;
    if (acquired.count !== 0) return null;
    app.inert = acquired.originalInert;
    if (acquired.originalAriaHidden === null) app.removeAttribute('aria-hidden');
    else app.setAttribute('aria-hidden', acquired.originalAriaHidden);
    dialogRootIsolation.delete(app);
    return acquired.originalFocus;
  };
}

export function OfficialDialog({ title, children, onClose, wide = false, drawer = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; drawer?: boolean }) {
  const { t } = useTranslation(); const uid = useId(); const panel = useRef<HTMLDivElement>(null); const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null; const app = document.getElementById('root');
    const releaseRoot = app ? isolateDialogRoot(app, previous) : undefined;
    const currentPanel = panel.current;
    if (currentPanel) dialogPanels.push(currentPanel);
    const focusable = () => [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])') ?? [])].filter(element => element.getClientRects().length && !element.closest('[aria-disabled="true"]'));
    const initial = panel.current?.querySelector<HTMLElement>('input:not(:disabled),textarea:not(:disabled),[autofocus]'); (initial ?? focusable()[0] ?? panel.current)?.focus();
    const keys = (event: KeyboardEvent) => {
      if (!currentPanel || dialogPanels.at(-1) !== currentPanel) return;
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') { const items = focusable(), first = items[0], last = items.at(-1); if (!first) { event.preventDefault(); panel.current?.focus(); } else if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); } }
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('keydown', keys);
      const wasActive = !!currentPanel && dialogPanels.at(-1) === currentPanel;
      const index = currentPanel ? dialogPanels.indexOf(currentPanel) : -1;
      if (index !== -1) dialogPanels.splice(index, 1);
      const originalFocus = releaseRoot?.();
      if (wasActive) {
        const activePanel = dialogPanels.at(-1);
        const restoreFocus = [previous, originalFocus].find(element => element?.isConnected && !element.closest('[inert]') && (!activePanel || activePanel.contains(element)));
        (restoreFocus ?? activePanel)?.focus({ preventScroll: true });
      }
    };
  }, []);
  if (drawer) return createPortal(<div className="official-surface"><aside ref={panel} id="drawer" className="st-drawer" data-open="true" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} tabIndex={-1}><div className="st-drawer__head"><span className="card-title" id={`${uid}-title`}>{title}</span><button type="button" className="st-btn st-btn--icon" id="drawer-close" aria-label={t('close')} onClick={onClose}><OfficialIcon name="chevron" /></button></div><div className="st-drawer__body">{children}</div></aside><div className="scrim" id="scrim" onPointerDown={() => close.current()} /></div>, document.body);
  return createPortal(<div className="official-dialog-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) close.current(); }}><div ref={panel} className={`dialog official-dialog-panel ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} tabIndex={-1}><header className="dialog-header"><h2 id={`${uid}-title`}>{title}</h2><button type="button" className="icon-button" aria-label={t('close')} onClick={onClose}><X size={20} /></button></header><div className="dialog-body">{children}</div></div></div>, document.body);
}
