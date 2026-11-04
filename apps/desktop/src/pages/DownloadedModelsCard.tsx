import type { AppLanguage, DownloadedModel } from '@strata-manager/core';
import * as core from '@strata-manager/core';
import type { ReactNode } from 'react';
import { ArrowRight, CloudDownload, HardDrive, Plus } from 'lucide-react';
import './local-model-onboard.css';

/** Copy for 「发现 N 个已下载模型」, the 在线下载 / 使用已有模型 choice and the 本机已有 badge. */
export function onboardCopy(language: AppLanguage) {
  const zh = language === 'zh-CN';
  return zh ? {
    found: (n: number) => `发现 ${n} 个已下载模型`, addAll: '一键加入', add: '加入', noRedownload: '不用重新下载',
    online: '在线下载', onlineHint: '从官方目录挑选', existing: '使用已有模型', existingHint: '选文件夹，不重新下载',
    onDisk: '本机已有', useDirect: '直接使用', sourceLabel: '模型来源',
  } : {
    found: (n: number) => `Found ${n} downloaded model${n === 1 ? '' : 's'}`, addAll: 'Add in one click', add: 'Add', noRedownload: 'No new download',
    online: 'Download online', onlineHint: 'Pick from the official catalog', existing: 'Use an existing model', existingHint: 'Choose a folder, no new download',
    onDisk: 'On this computer', useDirect: 'Use directly', sourceLabel: 'Model source',
  };
}

const sizeGB = (bytes: number, language: AppLanguage) => `${(bytes / 1e9).toLocaleString(language, { maximumFractionDigits: bytes >= 1e10 ? 0 : 1 })} GB`;

/** 「发现 N 个已下载模型 · 一键加入」: models the upstream app or Terminal already downloaded, one click to 使用已有模型. */
export function DownloadedModelsCard({ language, models, disabled, onUse }: { language: AppLanguage; models: DownloadedModel[]; disabled?: boolean; onUse: (model: DownloadedModel) => void }) {
  const t = onboardCopy(language);
  if (!models.length) return null;
  return <section className="downloaded-card" data-testid="downloaded-models-card" aria-label={t.found(models.length)}>
    <span className="downloaded-card-icon" aria-hidden="true"><HardDrive size={22}/><b>{models.length}</b></span>
    <div className="downloaded-card-body">
      <strong>{t.found(models.length)} · {t.addAll}</strong>
      <ul className="downloaded-card-chips">{models.slice(0, 6).map(model => <li key={`${model.directory}|${model.group.id}`}>
        <button type="button" disabled={disabled} title={model.directory} onClick={() => onUse(model)} data-testid="downloaded-model-chip">
          {model.group.quant && <b>{model.group.quant}</b>}<span>{core.localModelBaseName(model.group)}</span><small>{sizeGB(model.group.totalBytes, language)}</small><Plus size={14} aria-hidden="true"/>
        </button></li>)}</ul>
    </div>
    <button type="button" className="primary downloaded-card-go" disabled={disabled} onClick={() => onUse(models[0]!)} data-testid="downloaded-models-add"><ArrowRight size={17}/>{t.addAll}</button>
  </section>;
}

/** 在线下载 | 使用已有模型: two equal cards instead of a collapsed section. */
export function ModelSourceChoice({ language, value, foundCount, onChange }: { language: AppLanguage; value: 'online' | 'existing'; foundCount: number; onChange: (value: 'online' | 'existing') => void }) {
  const t = onboardCopy(language);
  const card = (id: 'online' | 'existing', icon: ReactNode, title: string, hint: string, badge?: number) => <button type="button" role="tab" aria-selected={value === id} className={`model-source-card${value === id ? ' is-selected' : ''}`} data-testid={`model-source-${id}`} onClick={() => onChange(id)}>
    <span className="model-source-icon" aria-hidden="true">{icon}</span><span className="model-source-text"><strong>{title}</strong><small>{hint}</small></span>{badge ? <b className="model-source-badge">{badge}</b> : null}
  </button>;
  return <div className="model-source-choice" role="tablist" aria-label={t.sourceLabel} data-testid="model-source-choice">
    {card('online', <CloudDownload size={22}/>, t.online, t.onlineHint)}
    {card('existing', <HardDrive size={22}/>, t.existing, t.existingHint, foundCount)}
  </div>;
}
