import { useEffect, useRef, useState } from 'react';
import { FileText, Play, RefreshCw, Trash2 } from 'lucide-react';
import type { LocalModelConfiguration, LocalModelGroup } from '@strata-manager/core';
import { configurationPathKey } from '@strata-manager/core';
import { Dialog, Panel } from '../components';
import './configuration-list.css';

interface Props {
  groups: LocalModelGroup[];
  selectedPath?: string;
  activeId: string;
  running: boolean;
  lastUsedId: string;
  disabled: boolean;
  loading: boolean;
  error?: string;
  dirty: boolean;
  language: 'zh-CN' | 'en';
  onOpen: (entry: LocalModelConfiguration) => void;
  onDelete: (entry: LocalModelConfiguration) => void;
  onUse: (entry: LocalModelConfiguration, restart: boolean) => Promise<unknown>;
  onRefresh: () => void;
}

const date = (value: number | null | undefined, language: Props['language']) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString(language) : undefined;
const name = (entry: LocalModelConfiguration) => entry.configPath.split(/[\\/]/).at(-1) || entry.profile?.name || entry.candidate?.name || '—';

/** Opening a file only changes the editor. Loading a configuration always requires an explicit confirmation. */
export function ConfigurationList({ groups, selectedPath, activeId, running, lastUsedId, disabled, loading, error, dirty, language, onOpen, onDelete, onUse, onRefresh }: Props) {
  const zh = language === 'zh-CN';
  const [pending, setPending] = useState<LocalModelConfiguration>();
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState('');
  const [open, setOpen] = useState(false);
  const floating = useRef<HTMLDivElement>(null);
  const operation = useRef(false);
  const current = (entry: LocalModelConfiguration) => running && entry.profile?.id === activeId;
  const selected = (entry: LocalModelConfiguration) => !!selectedPath && configurationPathKey(entry.configPath) === configurationPathKey(selectedPath);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!floating.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const use = async () => {
    if (!pending || disabled || operation.current) return;
    operation.current = true; setWorking(true); setFailure('');
    const target = pending; setPending(undefined);
    try { await onUse(target, current(target)); }
    catch (cause) { setFailure(cause instanceof Error ? cause.message : String(cause)); }
    finally { operation.current = false; setWorking(false); }
  };
  const count = groups.reduce((sum, group) => sum + group.configurations.length, 0);
  return <><div className="configuration-list-floating"><div className="configuration-list-floating-anchor" ref={floating} onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)} onFocusCapture={() => setOpen(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>
    <button className="configuration-list-trigger" aria-expanded={open} aria-label={zh ? '展开此模型的配置列表' : 'Show configurations for this model'} onClick={() => setOpen(true)}><FileText size={15}/>{zh ? '配置列表' : 'Configurations'} · {count}</button>
    <div className="configuration-list-popover" hidden={!open}><Panel title={`${zh ? '此模型的全部配置' : 'All configurations for this model'} · ${count}`} action={<button disabled={disabled || loading} onClick={onRefresh}><RefreshCw size={14}/>{zh ? '扫描' : 'Scan'}</button>}>
    <div className="configuration-list" aria-label={zh ? '此模型的配置列表' : 'Configurations for this model'}>
      {error && <div role="alert" className="notice warning">{error}</div>}
      {!groups.length && <p className="subtle">{loading ? (zh ? '正在读取配置…' : 'Reading configurations…') : (zh ? '还没有本机配置。' : 'No local configurations yet.')}</p>}
      {groups.map(group => <section className="configuration-list-group" key={group.key}>
        <h3>{group.name}<span>{group.configurations.length}</span></h3>
        {group.configurations.map(entry => {
          const modification = date(entry.modifiedAt, language), activation = date(entry.lastActivatedAt, language);
          const active = current(entry), viewed = selected(entry);
          return <div className={`configuration-list-row${viewed ? ' selected' : ''}`} key={entry.key}>
            <button type="button" className="configuration-list-open" aria-pressed={viewed} disabled={disabled || working} onClick={() => { if (viewed) return; onOpen(entry); }} title={entry.configPath}>
              <FileText size={17}/><span><strong>{name(entry)}{active && <em>{zh ? '当前运行' : 'Running'}</em>}{!active && entry.profile?.id === lastUsedId && <em className="previous">{zh ? '上次使用' : 'Last used'}</em>}</strong>
              <span className="configuration-list-times">{modification && <time>{zh ? '修改' : 'Modified'} · {modification}</time>}<time>{zh ? '上次启用' : 'Last activated'} · {activation ?? (zh ? '未记录' : 'Not recorded')}</time></span></span>
            </button>
            <div className="configuration-list-actions"><button aria-label={`${active ? (zh ? '重启模型服务并应用配置' : 'Restart model service and apply configuration') : (zh ? '使用此配置' : 'Use configuration')} ${name(entry)}`} title={active ? (zh ? '重启模型服务并应用配置' : 'Restart model service and apply configuration') : (zh ? '使用此配置' : 'Use configuration')} disabled={disabled || working || entry.candidate?.availability === 'repair'} onClick={() => { setFailure(''); setPending(entry); }}><Play size={14}/></button><button className="danger" title={zh ? '删除配置文件' : 'Delete configuration file'} aria-label={`${zh ? '删除配置文件' : 'Delete configuration file'} ${name(entry)}`} disabled={disabled || working} onClick={() => onDelete(entry)}><Trash2 size={14}/></button></div>
          </div>;
        })}
      </section>)}
    </div>
    </Panel></div></div></div>
    {failure && <p role="alert" className="notice warning">{failure}</p>}
    {pending && <Dialog title={zh ? '应用运行配置' : 'Apply runtime configuration'} onClose={() => { if (!operation.current) setPending(undefined); }}>
      <p>{zh ? '将结束当前模型服务，并按以下文件启动。未保存的编辑不会生效。' : 'The current model service will stop and start with this file. Unsaved edits will not apply.'}</p>
      <code className="configuration-confirm-path">{pending.configPath}</code>
      <div className="dialog-actions"><button disabled={working} onClick={() => setPending(undefined)}>{zh ? '取消' : 'Cancel'}</button><button className="primary" disabled={disabled || working} onClick={() => void use()}>{working ? (zh ? '正在应用…' : 'Applying…') : (zh ? '使用并重启' : 'Use and restart')}</button></div>
    </Dialog>}
  </>;
}
