import type { AppLanguage } from "@strata-manager/core";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServiceProfile } from '@strata-manager/core';
import { Segmented } from '../OfficialControls';
import { ContextBenchmarkPage } from './ContextBenchmarkPage';
import { ScenarioBenchmarkPage } from './ScenarioBenchmarkPage';
import { ServiceCapabilityPanel } from '../ServiceCapabilityPanel';
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
  return <div className="benchmark-workspace">
    <ServiceCapabilityPanel profile={props.profile} online={props.online} language={props.language}/>
    <Segmented ariaLabel={zh ? 'Benchmark 类型' : 'Benchmark type'} value={mode} onValueChange={setMode} options={[
      { value: 'context', label: zh ? '上下文档位' : 'Context tiers', disabled: running },
      { value: 'scenario', label: zh ? '场景测试' : 'Scenario suite', disabled: running },
    ]}/>
    <div hidden={mode !== 'context'}><ContextBenchmarkPage {...props} onRunningChange={runningChanged}/></div>
    <div hidden={mode !== 'scenario'}><ScenarioBenchmarkPage {...props} onRunningChange={runningChanged}/></div>
  </div>;
}
