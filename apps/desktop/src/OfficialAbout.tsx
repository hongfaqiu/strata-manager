import type { AppLanguage } from "@strata-manager/core";
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import * as core from '@strata-manager/core';
import type { JsonObject, ServiceProfile } from '@strata-manager/core';
import { OfficialCopyButton } from './OfficialCopyButton';
import strataLicense from './official/LICENSE.strata?raw';
import outfitLicense from './fonts/OFL.txt?raw';
import { version } from '../package.json';

const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
export function AboutPage({ raw, health, profile, language, desktop = core.isDesktop(), onCopy, onOpenSettings, onOpenConfig }: {
  raw: JsonObject; health: JsonObject; profile?: ServiceProfile; online?: boolean; language:AppLanguage; desktop?:boolean;
  onCopy:(value:string)=>void|Promise<boolean|void>; onError?:(error:unknown)=>void;
  onOpenSettings:()=>void; onOpenConfig:()=>void;
}) {
  const { t } = useTranslation(); const eng = object(raw.engine), hw = object(raw.hardware), st = object(raw.hardware_static);
  const fmt = (value:unknown,digits=0)=>typeof value==='number'?value.toLocaleString(language,{maximumFractionDigits:digits}):String(value??'');
  const gb = (value:unknown,digits=1)=>typeof value==='number'?fmt(value/1073741824,digits):'';
  const facts = (rows:[string,unknown,boolean?][])=>rows.filter(row=>row[1]!=null&&row[1]!=='').map(([label,value,copy])=><Fragment key={label}><dt>{label}</dt><dd>{copy?<><code>{String(value)}</code><OfficialCopyButton value={String(value)} onCopy={onCopy} size={16}/></>:String(value)}</dd></Fragment>);
  const kv = ({int8:t('kv8'),q4_0:t('kv4'),fp16:t('kv16')} as Record<string,string>)[String(eng.kv)] ?? eng.kv;
  let projection: string|null = null;
  if(eng.cvec && eng.cvec!=='0') {const [mode,range,single]=String(eng.cvec).split(':');projection=t('projectionDescription',{mode:t(mode==='project'?'projectionMode':'additiveMode'),range:(range??'').replace('-','–'),direction:single?t('layerDirection',{layer:single.replace('single','')}):''});}
  const engineRows:[string,unknown][] = [[t('model'),eng.model??health.model],[t('engine'),eng.version?`v${eng.version}`:(language==='zh-CN'?'未报告版本':'Version not reported')],[t('context'),eng.max_context?`${fmt(eng.max_context)} ${t('tokensUnit')}`:null],[t('kvCache'),kv?`${kv}, ${eng.kv_resident?t('streamedKv',{count:fmt(eng.kv_resident)}):t('allInVram')}`:null],[t('expertsInVram'),eng.expert_slots?`${fmt(eng.expert_slots)} (${gb(Number(eng.expert_cache_mib??0)*1048576)} GB)`:null],[t('speculation'),eng.spec?`${t('mtpDrafts',{count:Math.max(0,Number(eng.mtp_max??eng.spec)-1)})}${eng.lookup?`, ${t('lookupOn')}`:''}`:null],[t('aboutImages'),typeof eng.images==='boolean'?t(eng.images?'enabledOn':'enabledOff'):(language==='zh-CN'?'未知':'Unknown')],[t('esp'),projection]];
  const base = profile ? core.normalizeBaseUrl(profile.baseUrl) : '';
  return <section className="view view--about" id="view-about" aria-labelledby="workspace-page-title"><div className="about">
    <div className="st-card"><span className="card-title">{t('localEngine')}</span><dl className="facts" id="facts-engine">{facts(engineRows)}</dl></div>
    <div className="st-card"><span className="card-title">{t('thisPc')}</span><dl className="facts" id="facts-hw">{facts([[t('aboutGpu'),st.gpu_name?`${st.gpu_name}${hw.gpu_mem_total?`, ${gb(hw.gpu_mem_total,0)} GB`:''}`:st.gpu_note??t('nvmlUnavailable')],[t('aboutCpu'),st.cpu_name?`${st.cpu_name}${st.threads?`, ${t('threadsCount',{count:st.threads})}`:''}`:null],[t('aboutRam'),hw.ram_total?`${gb(hw.ram_total,0)} GB`:null]])}</dl></div>
    <div className="st-card"><span className="card-title">{t('connectTools')}</span><p className="muted">{t('connectToolsHint')}</p><dl className="facts" id="facts-api">{facts([[t('openAiBase'),base?`${base}/v1`:null,true],[t('anthropicBase'),base||null,true],[t('modelName'),eng.model??health.model,true]])}</dl></div>
    <div className="st-card"><span className="card-title">Strata Manager</span><dl className="facts">{facts([[t('appVersion'),version]])}</dl><p className="muted">{t('aboutHint')}</p><p className="muted small">{t('aboutProjectHint')}</p><p className="muted small">{t(desktop?'storageDesktop':'storageBrowser')}</p><p className="muted"><a href="https://github.com/hongfaqiu/strata-manager" target="_blank" rel="noopener noreferrer">{t('aboutManagerSource')}</a> · <a href="https://github.com/Niko1221/Strata" target="_blank" rel="noopener noreferrer">{t('aboutUpstreamSource')}</a></p><details className="open-source-licenses"><summary>{t('thirdPartyLicenses')}</summary><pre className="json-view">{strataLicense + '\n\n' + outfitLicense}</pre></details></div>
    <div className="st-card"><span className="card-title">{t('aboutPreferences')}</span><p className="muted">{t('aboutConfigHint')}</p><p className="muted small">{t('aboutDefaultsHint')}</p><div className="cfg-actions"><button className="st-btn st-btn--secondary" type="button" onClick={onOpenConfig}>{t('configuration')}</button><button className="st-btn st-btn--secondary" type="button" onClick={onOpenSettings}>{t('settings')}</button></div></div>
  </div></section>;
}

export { AboutPage as OfficialAbout };
