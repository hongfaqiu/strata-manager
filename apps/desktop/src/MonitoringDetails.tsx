import type { JsonObject } from '@strata-manager/core';
import type { ReactNode } from 'react';
import { asObject } from '@strata-manager/core';
import { Badge, Chart, Panel } from './components';

export interface MonitoringDetailsProps { raw: JsonObject; language: 'zh-CN' | 'en'; requests?: ReactNode }
type Fact = [string, string];
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const records = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : [];

/** Additional official /metrics fields. /mcp can be supplied as raw.mcp by the parent query. */
export function MonitoringDetails({ raw, language, requests }: MonitoringDetailsProps) {
  const zh = language === 'zh-CN';
  const label = (cn: string, en: string) => zh ? cn : en;
  const fmt = (value: unknown, digits = 1) => { const n = numeric(value); return n === null ? '—' : n.toLocaleString(language, { maximumFractionDigits: digits }); };
  const bytes = (value: unknown) => { const n = numeric(value); return n === null ? '—' : `${fmt(n / 1073741824)} GB`; };
  const text = (value: unknown) => typeof value === 'string' && value ? value : typeof value === 'number' ? fmt(value) : '—';
  const bool = (value: unknown) => value === true ? label('已启用', 'Enabled') : value === false ? label('未启用', 'Disabled') : '—';
  const date = (value: unknown) => { const n = numeric(value); return n === null ? '—' : new Date(n * 1000).toLocaleString(language); };
  const live = asObject(raw.live), hardware = asObject(raw.hardware), staticHardware = asObject(raw.hardware_static);
  const engine = asObject(raw.engine), cache = asObject(raw.conversation_cache), totals = asObject(raw.totals), history = asObject(raw.history);
  const last = records(raw.requests)[0] ?? {};
  const active = live.state === 'reading' || live.state === 'generating';
  const prompt = numeric(active ? live.prompt_tokens : last.prompt_tokens);
  const generated = numeric(active ? live.generated : last.output_tokens);
  const used = prompt !== null && generated !== null ? prompt + generated : null;
  const context = numeric(engine.max_context);
  const gpus = records(hardware.gpus);
  const mcp = asObject(raw.mcp), servers = records(mcp.servers);
  const ratio = (usedValue: unknown, totalValue: unknown): number | null => {
    const a = numeric(usedValue), b = numeric(totalValue);
    return a !== null && b !== null && b > 0 ? Math.min(100, Math.max(0, a / b * 100)) : null;
  };
  const facts = (values: Fact[]) => <div className="info-list">{values.map(([name, value]) => <div key={name}><span>{name}</span><strong>{value}</strong></div>)}</div>;
  const progress = (name: string, usedValue: unknown, totalValue: unknown, display?: string) => {
    const percent = ratio(usedValue, totalValue);
    return <div className="resource-row"><div className="bar-row"><span>{name}</span><strong>{display ?? `${fmt(usedValue, 0)} / ${fmt(totalValue, 0)}`} {percent === null ? '' : ` · ${fmt(percent)}%`}</strong></div>
      {percent === null ? <p className="subtle">—</p> : <div className="progress" role="progressbar" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div style={{ width: `${percent}%` }} /></div>}</div>;
  };
  const series = (key: string): (number | null)[] => Array.isArray(history[key]) ? history[key].map(numeric) : [];
  const cacheBudget = numeric(cache.budget_mib);
  const expertMiB = numeric(engine.expert_cache_mib);
  const reused = numeric(totals.reused), promptTotal = numeric(totals.prompt_tokens);
  const read = reused !== null && promptTotal !== null ? Math.max(0, promptTotal - reused) : null;
  const promptMs = numeric(totals.prompt_ms), decodeMs = numeric(totals.decode_ms), outputTokens = numeric(totals.output_tokens);
  const totalPrefillSpeed = read !== null && promptMs !== null && promptMs > 0 ? read / (promptMs / 1000) : null;
  const totalDecodeSpeed = outputTokens !== null && decodeMs !== null && decodeMs > 0 ? outputTokens / (decodeMs / 1000) : null;
  const mcpStatus = (value: unknown) => {
    const statuses: Record<string, string> = { ready: label('已连接', 'Connected'), starting: label('启动中', 'Starting'), failed: label('失败', 'Failed'), stopped: label('已停止', 'Stopped'), idle: label('等待中', 'Waiting') };
    return typeof value === 'string' ? statuses[value] ?? value : '—';
  };

  const diskPanel = <Panel title={label('磁盘与 PCIe', 'Disk and PCIe')}>
        {facts([
          [label('磁盘读取', 'Disk read'), numeric(hardware.disk_read_mb) === null ? '—' : `${fmt(hardware.disk_read_mb)} MB/s`],
          [label('磁盘写入', 'Disk write'), numeric(hardware.disk_write_mb) === null ? '—' : `${fmt(hardware.disk_write_mb)} MB/s`],
          [label('PCIe 当前代数', 'PCIe generation'), numeric(hardware.gpu_pcie_gen) === null ? '—' : `Gen${fmt(hardware.gpu_pcie_gen, 0)}`],
          [label('PCIe 最大代数', 'PCIe max generation'), numeric(hardware.gpu_pcie_gen_max) === null ? '—' : `Gen${fmt(hardware.gpu_pcie_gen_max, 0)}`],
          [label('PCIe 通道数', 'PCIe lanes'), numeric(hardware.gpu_pcie_width) === null ? '—' : `x${fmt(hardware.gpu_pcie_width, 0)}`],
          [label('传至 GPU', 'To GPU'), numeric(hardware.gpu_pcie_rx_mb) === null ? '—' : `${fmt(hardware.gpu_pcie_rx_mb)} MB/s`],
          [label('传出 GPU', 'From GPU'), numeric(hardware.gpu_pcie_tx_mb) === null ? '—' : `${fmt(hardware.gpu_pcie_tx_mb)} MB/s`],
        ])}
        {(series('disk_read_mb').length > 0 || series('gpu_pcie_rx_mb').length > 0) && <div className="two-columns"><Chart values={series('disk_read_mb')} label={label('磁盘读取', 'Disk read')} unit="MB/s" /><Chart values={series('gpu_pcie_rx_mb')} label={label('传至 GPU', 'To GPU')} unit="MB/s" /></div>}
      </Panel>;

  return <>
    <div className="monitor-row">
      <Panel title={label('上下文与提示词', 'Context and prompt')} className="ctx-card">
        {progress(label('上下文占用', 'Context usage'), used, context)}
        {live.state === 'reading' && progress(label('提示词读取进度', 'Prompt reading progress'), live.prompt_read, live.prompt_total)}
        {live.state === 'generating' && progress(label('本次生成进度', 'Generation progress'), live.generated, live.max_tokens)}
        {facts([[label('提示词 tokens', 'Prompt tokens'), fmt(prompt, 0)], [label('输出 tokens', 'Output tokens'), fmt(generated, 0)], [label('阶段', 'Phase'), text(live.phase)], [label('耗时', 'Elapsed'), numeric(live.elapsed_s) === null ? '—' : `${fmt(live.elapsed_s)} s`]])}
      </Panel>
      {requests ?? diskPanel}
    </div>
    {requests != null && diskPanel}

    {gpus.length > 0 && <Panel title={label('逐 GPU 指标', 'Per-GPU metrics')}><div className="table-wrap"><table><thead><tr>{['GPU', label('利用率', 'Utilization'), label('显存', 'VRAM'), label('温度', 'Temperature'), label('功耗', 'Power')].map(name => <th key={name}>{name}</th>)}</tr></thead><tbody>{gpus.map((gpu, index) => <tr key={`${text(gpu.index)}-${index}`}><td>{numeric(gpu.index) === null ? '—' : `GPU ${fmt(gpu.index, 0)}`}</td><td>{numeric(gpu.util) === null ? '—' : `${fmt(gpu.util)}%`}</td><td>{bytes(gpu.mem_used)} / {bytes(gpu.mem_total)}</td><td>{numeric(gpu.temp) === null ? '—' : `${fmt(gpu.temp)} °C`}</td><td>{numeric(gpu.power) === null ? '—' : `${fmt(gpu.power)} W`}</td></tr>)}</tbody></table></div></Panel>}

    <div className="two-columns">
      <Panel title={label('专家缓存', 'Expert cache')}>
        {progress(label('专家缓存显存', 'Expert cache VRAM'), expertMiB === null ? null : expertMiB * 1048576, hardware.gpu_mem_total, `${expertMiB === null ? '—' : bytes(expertMiB * 1048576)} / ${bytes(hardware.gpu_mem_total)}`)}
        {facts([[label('缓存专家数', 'Cached experts'), fmt(engine.expert_slots, 0)], [label('最近请求命中率', 'Last request hit rate'), numeric(last.hit_rate) === null ? '—' : `${fmt(Number(last.hit_rate) * 100)}%`], [label('最近 PCIe 专家份额', 'Last PCIe expert share'), numeric(last.pcie_share) === null ? '—' : `${fmt(Number(last.pcie_share) * 100)}%`]])}
      </Panel>
      <Panel title={label('会话缓存', 'Conversation cache')} className="cc-card">
        {facts([[label('多会话缓存', 'Multi-conversation cache'), bool(cache.enabled)]])}
        {cache.enabled === true && <div className="cc-bars">{progress(label('停放会话', 'Parked conversations'), cache.parked, cache.slots)}{progress(label('缓存内存', 'Cache memory'), cache.bytes, cacheBudget === null ? null : cacheBudget * 1048576, `${bytes(cache.bytes)} / ${cacheBudget === null ? '—' : bytes(cacheBudget * 1048576)}`)}</div>}
        {facts([
          [label('复用请求 / 记录请求', 'Reused / recorded requests'), `${fmt(cache.requests_reused, 0)} / ${fmt(cache.requests, 0)}`],
          [label('复用提示词 tokens', 'Reused prompt tokens'), fmt(cache.reused_tokens, 0)],
          [label('最近复用 / 提示词', 'Last reused / prompt'), `${fmt(cache.last_reused, 0)} / ${fmt(cache.last_prompt, 0)}`],
          [label('停放 / 恢复 / 淘汰', 'Parked / restored / evicted'), `${fmt(cache.parks, 0)} / ${fmt(cache.restores, 0)} / ${fmt(cache.evictions, 0)}`],
          [label('最近切换', 'Last switch'), cache.last_event === 'parked' ? label('停放', 'Parked') : cache.last_event === 'restored' ? label('恢复', 'Restored') : text(cache.last_event)],
          [label('最近切换 tokens', 'Last switch tokens'), fmt(cache.last_tokens, 0)], [label('最近切换时间', 'Last switch time'), date(cache.last_at)],
        ])}
        {cache.enabled === false && <p className="subtle">{label('引擎保留最近会话的状态；多会话停放缓存尚未启用。', 'The engine retains the last conversation state. Parking multiple conversations is disabled.')}</p>}
      </Panel>
    </div>

    {Object.keys(mcp).length > 0 && <Panel title={label('MCP 服务', 'MCP servers')} className="mcp-card" action={<Badge>{fmt(mcp.tools, 0)} {label('个工具', 'tools')}</Badge>}>
      {servers.length === 0 ? <p className="subtle">{Array.isArray(mcp.servers) ? label('未配置 MCP 服务', 'No MCP servers configured') : '—'}</p> : servers.map((server, index) => { const tools = records(server.tools), info = asObject(server.info); return <div className="mcp-server" key={`${text(server.name)}-${index}`}><div className="mcp-server-head mcp-server__head"><Badge tone={server.status === 'ready' ? 'positive' : server.status === 'failed' ? 'warning' : ''}>{mcpStatus(server.status)}</Badge><strong>{text(server.name)}</strong><span className="subtle">{text(server.transport)} · {Array.isArray(server.tools) ? tools.length : '—'} {label('个工具', 'tools')}{typeof info.name === 'string' ? ` · ${info.name}${typeof info.version === 'string' ? ` ${info.version}` : ''}` : ''}</span></div>{typeof server.error === 'string' && server.error && <div className="notice error">{server.error}</div>}<div className="mcp-tools mcp-server__tools">{tools.map((tool, toolIndex) => <span className="badge chip" key={`${text(tool.tool)}-${toolIndex}`} title={typeof tool.description === 'string' ? tool.description : undefined}>{text(tool.tool)}</span>)}</div></div>; })}
    </Panel>}

    <div className="two-columns">
      <Panel title={label('引擎与硬件', 'Engine and hardware')}>
        {facts([
          [label('模型', 'Model'), text(engine.model)], [label('引擎版本', 'Engine version'), text(engine.version)],
          [label('最大上下文', 'Max context'), fmt(engine.max_context, 0)], ['KV cache', text(engine.kv)],
          [label('显存 KV 位置数 / 层', 'VRAM KV positions / layer'), fmt(engine.kv_resident, 0)],
          [label('推测解码', 'Speculation'), text(engine.spec)], [label('MTP 最大值', 'MTP maximum'), fmt(engine.mtp_max, 0)],
          [label('提示词查找', 'Prompt lookup'), typeof engine.lookup === 'number' ? bool(engine.lookup !== 0) : bool(engine.lookup)], [label('图片输入', 'Image input'), bool(engine.images)],
          [label('实验速度投影', 'Experimental speed projection'), text(engine.cvec)],
          ['GPU', text(staticHardware.gpu_name)], [label('硬件遥测备注', 'Telemetry note'), text(staticHardware.gpu_note)],
          ['CPU', text(staticHardware.cpu_name)], [label('CPU 核心 / 线程', 'CPU cores / threads'), `${fmt(staticHardware.cores, 0)} / ${fmt(staticHardware.threads, 0)}`],
        ])}
      </Panel>
      <Panel title={label('运行累计', 'Session totals')}>
        {facts([
          [label('统计开始', 'Since'), date(totals.since)], [label('请求数', 'Requests'), fmt(totals.requests, 0)],
          [label('实际读取提示词 tokens', 'Prompt tokens read'), fmt(read, 0)], [label('复用 tokens', 'Reused tokens'), fmt(reused, 0)],
          [label('输出 tokens', 'Output tokens'), fmt(outputTokens, 0)],
          [label('累计 prefill 吞吐', 'Total prefill throughput'), totalPrefillSpeed === null ? '—' : `${fmt(totalPrefillSpeed)} tok/s`],
          [label('累计 decode 吞吐', 'Total decode throughput'), totalDecodeSpeed === null ? '—' : `${fmt(totalDecodeSpeed)} tok/s`],
        ])}
      </Panel>
    </div>
  </>;
}
