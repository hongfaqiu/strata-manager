import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import './tooltip.css';

type Hint = { target: HTMLElement; described: HTMLElement; text: string };
const hiddenPosition: CSSProperties = { left: 0, top: 0, visibility: 'hidden' };

/** One delegated layer keeps hints on disabled controls and Portal content without layout wrappers. */
export function TooltipLayer() {
  const id = useId();
  const [hint, setHint] = useState<Hint | null>(null);
  const [position, setPosition] = useState<CSSProperties>(hiddenPosition);
  const tooltip = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef<HTMLElement | null>(null);
  const shown = useRef<Hint | null>(null);

  useEffect(() => {
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    let focusedControl: HTMLElement | null = null;
    const clearTimers = () => { clearTimeout(showTimer.current); clearTimeout(hideTimer.current); };
    const hide = () => { clearTimers(); active.current = null; shown.current = null; setHint(null); };
    const find = (target: EventTarget | null) => {
      let element = target instanceof Element ? target.closest<HTMLElement>('[data-tooltip]') : null;
      if (!element && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
        element = Array.from(target.labels ?? []).find(label => label.dataset.tooltip?.trim()) ?? null;
      }
      return element?.dataset.tooltip?.trim() && !element.closest('[inert]') ? element : null;
    };
    const show = (target: HTMLElement, delay: number, described = target) => {
      clearTimers();
      if (shown.current?.target === target && shown.current.described === described) return;
      active.current = target;
      shown.current = null;
      setHint(null);
      showTimer.current = setTimeout(() => {
        if (!target.isConnected || !target.getClientRects().length || target.closest('[inert]')) { hide(); return; }
        const text = target.dataset.tooltip?.trim();
        if (text) { const next = { target, described, text }; shown.current = next; setPosition(hiddenPosition); setHint(next); }
        else hide();
      }, delay);
    };
    const leave = () => {
      clearTimers();
      if (focused) show(focused, 0, focusedControl ?? focused);
      else hideTimer.current = setTimeout(hide, 120);
    };
    const pointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const target = find(event.target);
      if (target && target !== hovered) { hovered = target; show(target, 400, focused === target ? focusedControl ?? target : target); }
    };
    const pointerOut = (event: PointerEvent) => {
      if (!hovered || (event.relatedTarget instanceof Node && hovered.contains(event.relatedTarget))) return;
      const next = find(event.relatedTarget);
      if (next === hovered) return;
      hovered = null;
      if (event.relatedTarget instanceof Node && tooltip.current?.contains(event.relatedTarget)) clearTimers();
      else leave();
    };
    const focusIn = (event: FocusEvent) => {
      const target = find(event.target);
      focusedControl = event.target instanceof HTMLElement && event.target.matches(':focus-visible') ? event.target : null;
      focused = focusedControl ? target : null;
      if (focused) show(focused, 0, focusedControl ?? focused);
    };
    const focusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && focused?.contains(event.relatedTarget)) return;
      focused = null;
      focusedControl = null;
      if (hovered) show(hovered, 400); else hide();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !active.current) return;
      if (shown.current) { event.preventDefault(); event.stopImmediatePropagation(); }
      hide();
    };
    const scroll = (event: Event) => { if (event.target instanceof Node && tooltip.current?.contains(event.target)) return; hide(); };
    document.addEventListener('pointerover', pointerOver);
    document.addEventListener('pointerout', pointerOut);
    document.addEventListener('focusin', focusIn);
    document.addEventListener('focusout', focusOut);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', escape, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      clearTimers(); active.current = null; shown.current = null;
      document.removeEventListener('pointerover', pointerOver);
      document.removeEventListener('pointerout', pointerOut);
      document.removeEventListener('focusin', focusIn);
      document.removeEventListener('focusout', focusOut);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!hint || !tooltip.current) return;
    const target = hint.target.getBoundingClientRect();
    const box = tooltip.current.getBoundingClientRect();
    const margin = 8, gap = 8;
    const below = innerHeight - target.bottom - gap - margin;
    const above = target.top - gap - margin;
    const top = below >= box.height || below >= above ? target.bottom + gap : target.top - gap - box.height;
    setPosition({ left: Math.max(margin, Math.min(target.left + (target.width - box.width) / 2, innerWidth - box.width - margin)), top: Math.max(margin, Math.min(top, innerHeight - box.height - margin)) });
    const element = hint.described;
    const tokens = element.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
    if (!tokens.includes(id)) element.setAttribute('aria-describedby', [...tokens, id].join(' '));
    return () => {
      const remaining = element.getAttribute('aria-describedby')?.split(/\s+/).filter(token => token && token !== id) ?? [];
      if (remaining.length) element.setAttribute('aria-describedby', remaining.join(' '));
      else element.removeAttribute('aria-describedby');
    };
  }, [hint, id]);

  useEffect(() => {
    if (!hint) return;
    const observer = new MutationObserver(() => {
      const text = hint.target.dataset.tooltip?.trim();
      if (!hint.target.isConnected || !hint.target.getClientRects().length || hint.target.closest('[inert]') || !text) {
        active.current = null; shown.current = null; setHint(null);
      } else if (text !== hint.text) { const next = { ...hint, text }; shown.current = next; setHint(next); }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tooltip', 'hidden', 'inert', 'style', 'class'] });
    return () => observer.disconnect();
  }, [hint]);

  return hint ? createPortal(<div ref={tooltip} id={id} role="tooltip" className="official-tooltip" style={position}
    onPointerEnter={() => clearTimeout(hideTimer.current)}
    onPointerLeave={() => { if (!hint.target.contains(document.activeElement) && hint.described !== document.activeElement) { active.current = null; shown.current = null; setHint(null); } }}
  >{hint.text}</div>, hint.target.closest('[role="dialog"]') ?? document.body) : null;
}
