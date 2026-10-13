import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import * as core from '@strata-manager/core';
import type { ServiceProfile } from '@strata-manager/core';
import './daily-experience.css';

export function ServiceCapabilityPanel({ profile, online, language, identityToken, configuredPromptCache }: { profile?: ServiceProfile; online: boolean; language: 'zh-CN' | 'en'; identityToken?: string; configuredPromptCache?: number }) {
  const zh = language === 'zh-CN';
  const [invalidatedAt, setInvalidatedAt] = useState<number>();
  const query = useQuery({ queryKey: ['service-capability-evidence', profile?.id, profile?.baseUrl, profile?.configPath, identityToken, online, configuredPromptCache], enabled: false, retry: false, queryFn: async () => {
    if (!profile || !online) throw new Error(zh ? '服务未启动或未就绪。' : 'The service is stopped or not ready.');
    return core.readServiceCapabilities(profile, { configuredPromptCache });
  } });
  const currentIdentity = useQuery({ queryKey: ['displayed-capability-identity', profile?.id, profile?.baseUrl, identityToken, query.data?.sampledAt],
    enabled: !!profile && online && !!query.data, queryFn: () => core.readServiceCapabilityIdentity(profile!), retry: false, refetchInterval: 5000, refetchOnWindowFocus: true });
  const identityChanged = !!query.data && (!!currentIdentity.data && !core.sameServiceCapabilityIdentity(query.data.identity, currentIdentity.data) || currentIdentity.isError);
  useEffect(() => { if (identityChanged && query.data) setInvalidatedAt(query.data.sampledAt); }, [identityChanged, query.data]);
  const stale = identityChanged || !!query.data && invalidatedAt === query.data.sampledAt;
  const labels: Record<string, string> = zh ? { chat: '文本聊天', messages: 'Anthropic Messages', responses: 'Responses', images: '图片输入', tools: '工具调用', json: '结构化输出', prefix: '固定前缀', logitBias: 'Token 偏置' } : { chat: 'Text chat', messages: 'Anthropic Messages', responses: 'Responses', images: 'Image input', tools: 'Tool calling', json: 'Structured output', prefix: 'Fixed prefix', logitBias: 'Logit bias' };
  const states = zh ? { available: '可用', unavailable: '不支持', unknown: '未核验', restartRequired: '需要重启' } : { available: 'Available', unavailable: 'Unsupported', unknown: 'Unverified', restartRequired: 'Restart required' };
  return <details className="daily-capabilities"><summary>{zh ? '当前服务能力' : 'Current service capabilities'}</summary><p>{zh ? '点击核验只读取元数据；停止、切换或加载状态改变后需重新核验。保存配置不代表已经生效。' : 'Checking only reads metadata. Check again after a stop, switch or load-state change. Saved settings do not establish live support.'}</p><button type="button" disabled={!online || !profile || query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? (zh ? '核验中…' : 'Checking…') : zh ? '核验服务能力' : 'Check capabilities'}</button>{query.isError && <p role="alert">{core.normalizeError(query.error).message}</p>}{online && stale && <p role="status">{zh ? '服务或引擎身份已改变，旧结果已失效。请重新核验。' : 'The service or engine identity changed. Previous results are invalid; check again.'}</p>}{online && !stale && !query.isError && query.data && <><small>{new Date(query.data.sampledAt).toLocaleString(language)} · {query.data.runtimeVersion ?? (zh ? '版本未知' : 'Unknown version')}</small><dl>{query.data.items.filter(item => labels[item.id]).map(item => <div key={item.id}><dt>{labels[item.id]}</dt><dd><strong>{states[item.state]}</strong> · {core.describeServiceCapability(item, language)}<small>{item.source}</small></dd></div>)}</dl></>}</details>;
}
