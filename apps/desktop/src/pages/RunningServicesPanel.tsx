import { useQueries } from '@tanstack/react-query';
import { CircleAlert, Copy, LoaderCircle, RefreshCw, Server } from 'lucide-react';
import * as core from '@strata-manager/core';
import { Badge, Panel } from '../components';
import './running-services.css';

export interface RunningServicesPanelProps {
  candidates: core.LocalCandidate[];
  language: 'zh-CN' | 'en';
  loading?: boolean;
  error?: unknown;
  onRefresh: () => void;
  onCopy?: (text: string) => void;
}

const words = {
  'zh-CN': {
    title: '检测到运行中服务', refresh: '重新检测', detecting: '正在检测运行中服务…',
    loaded: '模型已加载', unloaded: '模型未加载', unknown: '模型状态未知', checking: '正在检查模型状态…',
    model: '当前模型', unknownModel: '未提供模型名称', configuration: '当前运行配置', api: 'OpenAI API Base URL',
    runtime: 'Strata 目录', version: '引擎版本', modified: '配置修改时间', unavailable: '未提供',
    details: '详细配置 JSON', copyApi: '复制 OpenAI API Base URL', retry: '重新检查',
    invalidHealth: '无法确认 Strata 服务健康状态', healthFailed: '暂时无法读取模型状态',
  },
  en: {
    title: 'Running services detected', refresh: 'Detect again', detecting: 'Detecting running services…',
    loaded: 'Model loaded', unloaded: 'Model not loaded', unknown: 'Model state unknown', checking: 'Checking model state…',
    model: 'Current model', unknownModel: 'Model name unavailable', configuration: 'Running configuration', api: 'OpenAI API Base URL',
    runtime: 'Strata directory', version: 'Engine version', modified: 'Config modified', unavailable: 'Not provided',
    details: 'Full configuration JSON', copyApi: 'Copy OpenAI API Base URL', retry: 'Check again',
    invalidHealth: 'Could not confirm Strata service health', healthFailed: 'Model state is temporarily unavailable',
  },
} as const;

interface ConfirmedHealth { service: 'strata'; status: 'ok'; loaded: boolean; model?: unknown }
function confirmedHealth(value: unknown): ConfirmedHealth | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const health = value as Record<string, unknown>;
  if (health.service === 'strata' && health.status === 'ok' && typeof health.loaded === 'boolean') {
    return health as unknown as ConfirmedHealth;
  }
}

function observerProfile(candidate: core.LocalCandidate): core.ServiceProfile {
  return {
    id: `running-${candidate.id}`, name: candidate.name,
    baseUrl: `http://127.0.0.1:${candidate.detectedPort}`,
    installDir: candidate.installDir, pythonPath: candidate.pythonPath,
    configPath: candidate.configPath, managed: false,
  };
}

function modifiedDate(timestamp: number | undefined): Date | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/** Observes existing services only; no registration or lifecycle actions. */
export function RunningServicesPanel({ candidates, language, loading = false, error, onRefresh, onCopy }: RunningServicesPanelProps) {
  const text = words[language];
  const running = [...new Map(candidates.filter(candidate =>
    candidate.running === true && Number.isSafeInteger(candidate.pid) && candidate.pid! > 0 && candidate.pid! <= 0xffffffff
    && Number.isInteger(candidate.detectedPort) && candidate.detectedPort! > 0 && candidate.detectedPort! <= 65535,
  ).map(candidate => [candidate.id, candidate])).values()];
  const healthQueries = useQueries({ queries: running.map(candidate => {
    const profile = observerProfile(candidate);
    return {
      queryKey: ['observed-running-health', profile.id, profile.baseUrl, candidate.pid, candidate.configPath],
      queryFn: () => core.request<unknown>(profile, '/health', 'GET'),
      refetchInterval: 5000, refetchOnWindowFocus: false, retry: false,
    };
  }) });
  const refresh = () => {
    onRefresh();
    for (const query of healthQueries) void query.refetch();
  };
  const scanError = error ? core.normalizeError(error).message : '';
  if (scanError) return <p className="running-service-scan-error" role="alert"><CircleAlert size={15}/>{scanError}</p>;
  if (!running.length) {
    return loading ? <p className="running-service-detecting" role="status"><LoaderCircle size={15} className="spin"/>{text.detecting}</p> : null;
  }
  return <Panel title={text.title} className="running-services-panel" action={<button type="button" disabled={loading} aria-busy={loading} onClick={refresh}><RefreshCw size={15} className={loading ? 'spin' : undefined}/>{text.refresh}</button>}>
    <div className="running-services-list">{running.map((candidate, index) => {
      const query = healthQueries[index]!;
      const health = query.isSuccess && !query.error ? confirmedHealth(query.data) : undefined;
      const model = health?.loaded && typeof health.model === 'string' && health.model.trim() ? health.model : undefined;
      const checking = query.isPending;
      const healthError = query.error ? `${text.healthFailed}: ${core.normalizeError(query.error).message}`
        : query.isSuccess && !health ? text.invalidHealth : '';
      const profile = observerProfile(candidate);
      const modified = modifiedDate(candidate.configModifiedAt);
      return <article className="running-service-card" key={candidate.id}>
        <div className="running-service-heading"><div className="running-service-identity"><span className="running-service-symbol"><Server size={21}/></span><div><h3>{model ?? (health ? health.loaded ? text.unknownModel : text.unloaded : checking ? text.checking : text.unknown)}</h3><span>{candidate.name}</span></div></div><Badge tone={health?.loaded ? 'positive' : ''}>{checking ? text.checking : health ? health.loaded ? text.loaded : text.unloaded : text.unknown}</Badge></div>
        <dl className="running-service-facts">
          <div><dt>{text.model}</dt><dd>{health ? health.loaded ? model ?? text.unknownModel : text.unloaded : text.unknown}</dd></div>
          <div className="running-service-configuration"><dt>{text.configuration}</dt><dd><code>{candidate.configPath}</code></dd></div>
          <div><dt>{text.api}</dt><dd><code>{`${core.normalizeBaseUrl(profile.baseUrl)}/v1`}</code>{onCopy && <button type="button" className="running-service-copy" aria-label={text.copyApi} title={text.copyApi} onClick={() => onCopy(`${core.normalizeBaseUrl(profile.baseUrl)}/v1`)}><Copy size={14}/></button>}</dd></div>
          <div><dt>PID</dt><dd>{candidate.pid}</dd></div>
          <div><dt>{text.runtime}</dt><dd><code>{candidate.installDir}</code></dd></div>
          <div><dt>{text.version}</dt><dd>{candidate.runtimeVersion ?? text.unavailable}</dd></div>
          <div><dt>{text.modified}</dt><dd>{modified ? <time dateTime={modified.toISOString()}>{modified.toLocaleString(language)}</time> : text.unavailable}</dd></div>
        </dl>
        {healthError && <div className="running-service-health-error" role="status"><p><CircleAlert size={15}/>{healthError}</p><button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={14} className={query.isFetching ? 'spin' : undefined}/>{text.retry}</button></div>}
        {candidate.config && <details className="running-service-config"><summary>{text.details}</summary><pre>{JSON.stringify(candidate.config, null, 2)}</pre></details>}
      </article>;
    })}</div>
  </Panel>;
}
