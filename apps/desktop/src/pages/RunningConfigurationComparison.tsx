import { ChevronDown, FileJson, FolderOpen } from 'lucide-react';
import type * as core from '@strata-manager/core';
import './running-configuration-comparison.css';

export interface RunningConfigurationComparisonProps {
  comparison: core.RunningConfigurationComparison;
  language: 'zh-CN' | 'en';
  onOpenConfiguration?: (configuration: core.ConfigurationComparison) => void;
}

const words = {
  'zh-CN': {
    current: '实际运行文件', source: '来源配置', importedFrom: '导入来源',
    all: '对比全部配置', equivalent: '参数相同', different: '参数不同',
    unreadable: '配置不可读', conflict: '快照冲突', fields: '字段差异',
    field: 'JSON 字段', runningValue: '运行值', candidateValue: '列表值',
    missing: '未设置', credentials: '凭据已隐藏，未比较', open: '查看配置',
    ambiguity: '多个配置匹配', root: '根节点',
  },
  en: {
    current: 'Actual running file', source: 'Source configuration', importedFrom: 'Imported from',
    all: 'Compare all configurations', equivalent: 'Same parameters', different: 'Different parameters',
    unreadable: 'Configuration unreadable', conflict: 'Conflicting snapshots', fields: 'Field differences',
    field: 'JSON field', runningValue: 'Running value', candidateValue: 'Listed value',
    missing: 'Not set', credentials: 'Hidden credentials not compared', open: 'View configuration',
    ambiguity: 'Multiple configurations match', root: 'Root',
  },
} as const;

type Text = typeof words['zh-CN'] | typeof words.en;

function DifferenceValue({ value, missing, text }: { value: unknown; missing: boolean; text: Text }) {
  if (missing) return <span className="configuration-comparison-missing">{text.missing}</span>;
  return <pre>{JSON.stringify(value, null, 2) ?? text.missing}</pre>;
}

function ConfigurationRow({ entry, text, onOpenConfiguration }: {
  entry: core.ConfigurationComparison;
  text: Text;
  onOpenConfiguration?: RunningConfigurationComparisonProps['onOpenConfiguration'];
}) {
  const relationship = entry.pathRelation === 'exact' ? text.current : entry.pathRelation === 'import-source' ? text.source : undefined;
  const contentLabel = entry.contentMatch === 'equivalent' ? text.equivalent
    : entry.contentMatch === 'different' ? `${text.different} · ${entry.differences.length}`
      : entry.contentUnknownReason === 'conflicting-snapshots' ? text.conflict : text.unreadable;
  return <article className={`configuration-comparison-row is-${entry.pathRelation}`}>
    <div className="configuration-comparison-heading">
      <div className="configuration-comparison-name"><FileJson size={16} aria-hidden="true"/><strong title={entry.name}>{entry.configPath.split(/[\\/]/).at(-1) || entry.name}</strong></div>
      <div className="configuration-comparison-badges">
        {relationship && <span className={`configuration-comparison-badge relation-${entry.pathRelation}`}>{relationship}</span>}
        <span className={`configuration-comparison-badge content-${entry.contentMatch}`}>{contentLabel}</span>
      </div>
    </div>
    <code className="configuration-comparison-path">{entry.configPath}</code>
    {entry.originalConfigPaths.length > 0 && <dl className="configuration-comparison-sources"><dt>{text.importedFrom}</dt>{entry.originalConfigPaths.map(path => <dd key={path}><code>{path}</code></dd>)}</dl>}
    {(entry.ignoredPaths.length > 0 || onOpenConfiguration) && <div className="configuration-comparison-actions">
      {entry.ignoredPaths.length > 0 && <span className="configuration-comparison-credentials">{text.credentials}</span>}
      {onOpenConfiguration && <button type="button" onClick={() => onOpenConfiguration(entry)}><FolderOpen size={14} aria-hidden="true"/>{text.open}</button>}
    </div>}
    {entry.differences.length > 0 && <details className="configuration-comparison-differences">
      <summary><ChevronDown size={14} aria-hidden="true"/>{text.fields}<span>{entry.differences.length}</span></summary>
      <div className="configuration-comparison-table-scroll"><table>
        <thead><tr><th scope="col">{text.field}</th><th scope="col">{text.runningValue}</th><th scope="col">{text.candidateValue}</th></tr></thead>
        <tbody>{entry.differences.map(difference => <tr key={difference.path}>
          <th scope="row"><code>{difference.path || text.root}</code></th>
          <td><DifferenceValue value={difference.runningValue} missing={difference.kind === 'missing-running'} text={text}/></td>
          <td><DifferenceValue value={difference.candidateValue} missing={difference.kind === 'missing-candidate'} text={text}/></td>
        </tr>)}</tbody>
      </table></div>
    </details>}
  </article>;
}

/** Displays comparison snapshots without changing registration or runtime state. */
export function RunningConfigurationComparison({ comparison, language, onOpenConfiguration }: RunningConfigurationComparisonProps) {
  const text = words[language];
  const highlighted = comparison.comparisons.filter(entry => entry.pathRelation !== 'none');
  return <section className="running-configuration-comparison" aria-label={text.all}>
    {!comparison.exactMatches.length && <div className="configuration-comparison-running-file"><span className="configuration-comparison-badge relation-exact">{text.current}</span><code>{comparison.runningConfigPath}</code></div>}
    {comparison.ambiguous && <span className="configuration-comparison-ambiguity" role="status">{text.ambiguity}</span>}
    {highlighted.length > 0 && <div className="configuration-comparison-highlighted">{highlighted.map(entry => <ConfigurationRow key={entry.key} entry={entry} text={text} onOpenConfiguration={onOpenConfiguration}/>)}</div>}
    <details className="configuration-comparison-all">
      <summary><ChevronDown size={15} aria-hidden="true"/>{text.all}<span>{comparison.comparisons.length}</span></summary>
      <div className="configuration-comparison-list">{comparison.comparisons.map(entry => <ConfigurationRow key={entry.key} entry={entry} text={text} onOpenConfiguration={onOpenConfiguration}/>)}</div>
    </details>
  </section>;
}
