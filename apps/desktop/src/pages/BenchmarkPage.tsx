import type { AppLanguage } from "@strata-manager/core";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServiceProfile } from '@strata-manager/core';
import { Segmented } from '../OfficialControls';
import { ContextBenchmarkPage } from './ContextBenchmarkPage';
import { ScenarioBenchmarkPage } from './ScenarioBenchmarkPage';
import { ArenaPage } from './ArenaPage';
import { OfficialBenchmarkPage } from './OfficialBenchmarkPage';
import { useTranslation } from 'react-i18next';
import './benchmark.css';

export function BenchmarkPage(props: {
  profile?: ServiceProfile; online: boolean; disabled: boolean; language: AppLanguage; onRunningChange: (running: boolean) => void; quickRunRequest?: number;
}) {
  const [mode, setMode] = useState('context'), [running, setRunning] = useState(false);
  const { onRunningChange } = props;
  const lastQuickRunRequest = useRef(0);
  const quickRunRequest = props.quickRunRequest ?? 0;
  useEffect(() => {
    if (!quickRunRequest || quickRunRequest === lastQuickRunRequest.current) return;
    lastQuickRunRequest.current = quickRunRequest;
    setMode('scenario');
  }, [quickRunRequest]);
  const runningChanged = useCallback((value: boolean) => { setRunning(value); onRunningChange(value); }, [onRunningChange]);
  const zh = props.language === 'zh-CN';
  const { t } = useTranslation();
  return <div className="benchmark-workspace">
    <Segmented ariaLabel={zh ? 'Benchmark 类型' : 'Benchmark type'} value={mode} onValueChange={setMode} options={[
      { value: 'context', label: zh ? '上下文档位' : 'Context tiers', disabled: running },
      { value: 'scenario', label: zh ? '场景测试' : 'Scenario suite', disabled: running },
      { value: 'official', label: zh ? '官方基准' : 'Official benchmark', disabled: running },
      { value: 'arena', label: t('arenaTab') },
    ]}/>
    <div hidden={mode !== 'context'}><ContextBenchmarkPage {...props} onRunningChange={runningChanged}/></div>
    <div hidden={mode !== 'scenario'}><ScenarioBenchmarkPage {...props} onRunningChange={runningChanged}/></div>
    <div hidden={mode !== 'official'}><OfficialBenchmarkPage {...props} onRunningChange={runningChanged}/></div>
    <div hidden={mode !== 'arena'}><ArenaPage language={props.language} active={mode === 'arena'}/></div>
  </div>;
}
