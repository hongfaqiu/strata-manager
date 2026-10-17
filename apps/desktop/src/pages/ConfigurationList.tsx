import type { AppLanguage } from "@strata-manager/core";
import { useEffect, useRef, useState } from 'react';
import { FileText, Play, RefreshCw, Trash2 } from 'lucide-react';
import type { LocalModelConfiguration, LocalModelGroup, VersionedConfiguration } from '@strata-manager/core';
import { configurationInstallDir, configurationPathKey, focusModelGroup, installDirKey } from '@strata-manager/core';
import { useTranslation } from 'react-i18next';
import { useShowAllVersions } from '../useShowAllVersions';
import { Dialog, Panel } from '../components';
import { Toggle } from '../OfficialControls';
import './configuration-list.css';
import './config-versions.css';

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
  language: AppLanguage;
  onOpen: (entry: LocalModelConfiguration) => void;
  onDelete: (entry: LocalModelConfiguration) => void;
  onUse: (entry: LocalModelConfiguration, restart: boolean) => Promise<unknown>;
  onRefresh: () => void;
  /** Installation directory → runtime version. */
  versions?: Map<string, string>;
  /** The current Strata installation; other versions are collapsed by default. */
  currentInstallDir?: string;
}

const date = (value: number | null | undefined, language: Props['language']) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString(language) : undefined;
const name = (entry: LocalModelConfiguration) => entry.configPath.split(/[\\/]/).at(-1) || entry.profile?.name || entry.candidate?.name || '—';

/** Opening a file only changes the editor. Loading a configuration always requires an explicit confirmation. */
export function ConfigurationList({ groups, selectedPath, activeId, running, lastUsedId, disabled, loading, error, language, onOpen, onDelete, onUse, onRefresh, versions = new Map(), currentInstallDir }: Props) {
  const zh = language === 'zh-CN';
  const { t } = useTranslation();
  const [showAllVersions, setShowAllVersions] = useShowAllVersions();
  const multipleVersions = new Set(groups.flatMap(group => group.configurations.map(entry => installDirKey(configurationInstallDir(entry)))).filter(Boolean)).size > 1;
  const versionTag = (version?: string) => version ? t('mvVersionTag', { version }) : t('mvVersionUnknown');
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
    <div className="configuration-list-popover" hidden={!open}><Panel title={`${zh ? '此模型的全部配置' : 'All configurations for this model'} · ${count}`} action={<span className="configuration-list-head-actions">{multipleVersions && <span className="configuration-list-version-toggle"><Toggle checked={showAllVersions} onCheckedChange={setShowAllVersions} ariaLabel={t('mvShowAllVersions')} tooltip={t('mvShowAllVersionsHint')}/><span aria-hidden="true" onClick={() => setShowAllVersions(!showAllVersions)}>{t('mvShowAllVersions')}</span></span>}<button disabled={disabled || loading} onClick={onRefresh}><RefreshCw size={14}/>{zh ? '扫描' : 'Scan'}</button></span>}>
    <div className="configuration-list" aria-label={zh ? '此模型的配置列表' : 'Configurations for this model'}>
      {error && <div role="alert" className="notice warning">{error}</div>}
      {!groups.length && <p className="subtle">{loading ? (zh ? '正在读取配置…' : 'Reading configurations…') : (zh ? '还没有本机配置。' : 'No local configurations yet.')}</p>}
      {groups.map(group => {
        const pinned = group.configurations.filter(entry => current(entry) || selected(entry) || entry.profile?.id === lastUsedId).map(entry => entry.key);
        const focused = focusModelGroup(group, { currentInstallDir, versions, showAll: showAllVersions || !multipleVersions, pinned });
        const row = (item: VersionedConfiguration) => {
          const entry = item.entry;
          const modification = date(entry.modifiedAt, language), activation = date(entry.lastActivatedAt, language);
          const active = current(entry), viewed = selected(entry);
          return <div className={`configuration-list-row${viewed ? ' selected' : ''}`} key={entry.key}>
            <button type="button" className="configuration-list-open" aria-pressed={viewed} disabled={disabled || working} onClick={() => { if (viewed) return; onOpen(entry); }} data-tooltip={entry.configPath}>
              <FileText size={17}/><span><strong>{name(entry)}{multipleVersions && <span className={`config-version-tag${item.current ? ' is-current' : ''}`}>{versionTag(item.version)}</span>}{active && <em>{zh ? '当前运行' : 'Running'}</em>}{!active && entry.profile?.id === lastUsedId && <em className="previous">{zh ? '上次使用' : 'Last used'}</em>}</strong>
              <span className="configuration-list-times">{modification && <time>{zh ? '修改' : 'Modified'} · {modification}</time>}<time>{zh ? '上次启用' : 'Last activated'} · {activation ?? (zh ? '未记录' : 'Not recorded')}</time>{item.duplicates.length > 0 && <span className="config-version-same" data-tooltip={`${t('mvSameCopiesTitle')}\n${item.duplicates.map(copy => `${versionTag(copy.version)} · ${copy.entry.configPath}`).join('\n')}`}>{t('mvSameCopies', { count: item.duplicates.length })}</span>}</span></span>
            </button>
            <div className="configuration-list-actions"><button aria-label={`${active ? (zh ? '重启模型服务并应用配置' : 'Restart model service and apply configuration') : (zh ? '使用此配置' : 'Use configuration')} ${name(entry)}`} data-tooltip={active ? (zh ? '重启模型服务并应用配置' : 'Restart model service and apply configuration') : (zh ? '使用此配置' : 'Use configuration')} disabled={disabled || working || entry.candidate?.availability === 'repair'} onClick={() => { setFailure(''); setPending(entry); }}><Play size={14}/></button><button className="danger" data-tooltip={zh ? '删除配置文件' : 'Delete configuration file'} aria-label={`${zh ? '删除配置文件' : 'Delete configuration file'} ${name(entry)}`} disabled={disabled || working} onClick={() => onDelete(entry)}><Trash2 size={14}/></button></div>
          </div>;
        };
        return <section className="configuration-list-group" key={group.key}>
          <h3>{group.name}<span>{group.configurations.length}</span></h3>
          {focused.fallback && multipleVersions && <p className="configuration-list-version-note">{t('mvFallback')}</p>}
          {focused.primary.map(row)}
          {focused.others.length > 0 && <details className="configuration-list-others" open={focused.others.some(item => selected(item.entry)) || undefined}>
            <summary>{t('mvOtherVersions', { count: focused.others.length })}</summary>
            {focused.others.map(row)}
          </details>}
        </section>;
      })}
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
