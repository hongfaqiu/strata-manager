import { type ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TextKey } from './i18n';
export { OfficialIcon } from './OfficialIcon';

export { OfficialDialog as Dialog } from './OfficialControls';
export function Empty({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Inbox size={30} strokeWidth={1.4} /></div><h3>{title}</h3>{hint && <p>{hint}</p>}{children}</div>;
}
export function Panel({ title, children, action, className = '' }: { title: string; children: ReactNode; action?: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><header className="panel-header"><h2>{title}</h2>{action}</header>{children}</section>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Header({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return <div className="page-header"><div><h2>{title}</h2>{hint && <p>{hint}</p>}</div><div className="actions">{children}</div></div>;
}
export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Metric({ label, value, unit, children }: { label: string; value: string; unit?: string; children?: ReactNode }) {
  return <div className="metric"><span className="metric-label">{label}</span><div className="metric-value">{value}<small>{unit}</small></div>{children}</div>;
}
export function Chart({ values, label, unit = '' }: { values: (number | null)[]; label: string; unit?: string }) {
  const { t } = useTranslation();
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const max = Math.max(1, ...finite);
  const width = 600, height = 132;
  const paths: string[] = []; let path = '';
  values.forEach((value, i) => {
    if (value === null) { if (path) paths.push(path); path = ''; return; }
    const x = (i / Math.max(1, values.length - 1)) * width;
    const y = height - (value / max) * (height - 12) - 4;
    path += `${path ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
  });
  if (path) paths.push(path);
  return <div className="chart"><div className="chart-title"><span>{label}</span><span>{finite.length ? `${max.toFixed(1)} ${unit}` : '—'}</span></div>
    {finite.length ? <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} preserveAspectRatio="none"><path d={`M0 34H${width}M0 78H${width}M0 124H${width}`} className="chart-grid" />{paths.map((d, i) => <path key={i} d={d} className="chart-line" />)}</svg> : <div className="chart-empty">{t('noHistory' satisfies TextKey)}</div>}
  </div>;
}
export function JsonView({ value }: { value: unknown }) { return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>; }
