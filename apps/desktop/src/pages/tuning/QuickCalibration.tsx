import { Check, ClipboardCheck, FilePlus2, Gauge, RotateCw, Save } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { AppLanguage, CalibrationJob, CalibrationStep, TuningLiveSnapshot } from '@strata-manager/core';
import { LiveLog, LiveStatus, SweepChart, SweepTable, formatRate } from './TuningLive';
import type { CalibrationText } from './strings';

const stepTitle = (text: CalibrationText, kind: CalibrationStep['kind']) => text[kind];
const stateLabel = (text: CalibrationText, state: CalibrationJob['state'], fallback: Record<string, string>) =>
  (({ checking: text.checking, completed: text.completed, interrupted: text.interrupted, failed: text.failed, canceled: text.canceled } as Record<string, string>)[state]) ?? fallback[state] ?? state;
const fmt = (value: number | undefined, digits = 2) => value == null ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(digits);

export interface QuickCalibrationProps {
  job: CalibrationJob;
  live: TuningLiveSnapshot | null;
  text: CalibrationText;
  language: AppLanguage;
  states: Record<string, string>;
  clock: number;
  busy: boolean;
  canApply: boolean;
  notice?: { kind: 'saved' | 'overwritten'; onOpen?: () => void; onRestart?: () => void } | null;
  onCancel: () => void;
  onSaveVersion: () => void;
  onOverwrite: () => void;
  onVerify: () => void;
  onBenchmark?: () => void;
}

export function QuickCalibrationView({ job, live, text, language, states, clock, busy, canApply, notice, onCancel, onSaveVersion, onOverwrite, onVerify, onBenchmark }: QuickCalibrationProps) {
  const active = ['checking', 'running', 'canceling'].includes(job.state);
  const progress = core.calibrationProgress(job, live);
  const running = job.steps.find(step => step.status === 'running');
  const runningIndex = running ? job.steps.filter(step => step.status !== 'skipped').indexOf(running) + 1 : undefined;
  const measuredSteps = job.steps.filter(step => step.kind !== 'warmup' && step.kind !== 'confirm');
  const confirm = job.steps.find(step => step.kind === 'confirm');
  const changed = core.calibrationHasChange(job);
  const params = live?.parameters ?? {};
  const paramText = [params.pcieFrac != null ? `${text.pcieFrac} ${params.pcieFrac}` : '', params.specMinP != null ? `${text.specMinP} ${params.specMinP}` : '', params.value != null && running?.kind === 'prefillPipe' ? `${text.prefillPipe} ${params.value}` : ''].filter(Boolean).join(' · ');
  const rows = [
    { key: 'pcieFrac', label: text.pcieFrac, from: job.baseline.pcieFrac, to: job.recommended?.pcieFrac },
    { key: 'specMinP', label: text.specMinP, from: job.baseline.specMinP, to: job.recommended?.specMinP },
    ...(job.layerSplit ? [{ key: 'prefillPipe', label: text.prefillPipe, from: job.baseline.prefillPipe, to: job.recommended?.prefillPipe }] : []),
  ];

  return <div className="tuning-calibration" data-testid="tuning-calibration">
    {active && <LiveStatus text={text} language={language} state={stateLabel(text, job.state, states)} stepLabel={running ? stepTitle(text, running.kind) : text.checking}
      stepIndex={runningIndex} stepTotal={job.steps.filter(step => step.status !== 'skipped').length} round={live?.round} rounds={live?.rounds} parameters={paramText}
      liveRate={live?.request?.tokS ?? null} lastRate={live?.lastTokS ?? null} elapsedMs={clock - job.startedAt} etaMs={live?.etaMs ?? null}
      done={progress.done} total={progress.total} unit={text.progressRequests} cancelLabel={text.cancelQuick} onCancel={onCancel} cancelDisabled={busy || job.state === 'canceling'}/>}

    {!active && <section className="tuning-verdict" data-testid="tuning-calibration-result">
      <div className="tuning-verdict-head">
        <div>
          <p className="tuning-kicker">{text.resultTitle} · {stateLabel(text, job.state, states)}</p>
          <h3>{job.state === 'completed' ? changed ? text.changeFound : text.noChange : job.error ?? stateLabel(text, job.state, states)}</h3>
          <p className="tuning-muted">{text.quickRule}</p>
        </div>
        {job.gain != null && changed && <div className="tuning-verdict-gain"><strong>+{formatRate(job.gain * 100, language)}%</strong><span>{text.gain}</span><small>{formatRate(job.baseRate, language)} → {formatRate(job.tunedRate, language)} tok/s</small></div>}
      </div>
      {job.state === 'completed' && <table className="tuning-diff" data-testid="tuning-diff"><thead><tr><th>{text.parameter}</th><th>{text.from}</th><th>{text.to}</th></tr></thead>
        <tbody>{rows.map(row => { const same = row.to == null || Math.abs((row.to ?? 0) - (row.from ?? 0)) < 1e-9; return <tr key={row.key} className={same ? '' : 'is-changed'}><td>{row.label}</td><td>{fmt(row.from)}</td><td>{same ? <span className="tuning-muted">{fmt(row.from)}</span> : <strong>{fmt(row.to)}</strong>}</td></tr>; })}</tbody></table>}
      <div className="tuning-verdict-actions">
        {changed && <><button className="primary" data-testid="calibration-save-version" disabled={!canApply} onClick={onSaveVersion}><FilePlus2 size={15}/>{text.saveVersion}</button>
          <button data-testid="calibration-overwrite" disabled={!canApply} onClick={onOverwrite}><Save size={15}/>{text.overwrite}</button></>}
        {job.state === 'completed' && <button data-testid="calibration-verify" disabled={busy} onClick={onVerify}><ClipboardCheck size={15}/>{text.verifyScenario}</button>}
        {job.state === 'completed' && onBenchmark && <button className="tuning-link" data-testid="calibration-benchmark" onClick={onBenchmark}><Gauge size={15}/>{text.benchmark}</button>}
      </div>
      {notice && <p className="notice tuning-applied" role="status"><Check size={14}/>{notice.kind === 'saved' ? text.savedVersion : text.overwritten}
        {notice.onOpen && <button onClick={notice.onOpen}>{text.openVersion}</button>}{notice.onRestart && <button onClick={notice.onRestart}><RotateCw size={14}/>{text.restartNow}</button>}</p>}
      {job.state === 'completed' && <p className="tuning-muted tuning-verdict-foot">{text.verifyHint} {onBenchmark ? text.benchmarkHint : ''}</p>}
    </section>}

    <ol className="tuning-steps" data-testid="tuning-steps">{job.steps.map(step => <li key={step.kind} className={`is-${step.status}`}>
      <span className="tuning-step-dot"/><div><strong>{stepTitle(text, step.kind)}</strong><span>{text[step.status]}{step.skippedReason ? ` · ${text[step.skippedReason as keyof CalibrationText] ?? step.skippedReason}` : step.chosen != null && step.kind !== 'confirm' ? ` · ${text.chosen} ${fmt(step.chosen)}` : ''}</span></div>
    </li>)}</ol>

    <div className="tuning-sweeps">{measuredSteps.filter(step => step.status !== 'skipped').map(step => {
      const points = core.sweepPoints(step);
      return <section key={step.kind} className="tuning-sweep-block">
        <SweepChart testId={`sweep-${step.kind}`} title={stepTitle(text, step.kind)} metric={step.metric === 'prompt' ? text.prompt : text.decode} points={points} minGain={job.minGain} text={text} language={language}/>
        {(step.excluded ?? []).map(item => <p key={item.value} className="tuning-muted tuning-excluded">{item.value}: {text[item.reason as keyof CalibrationText] ?? item.reason}</p>)}
        <SweepTable points={points} text={text} language={language}/>
      </section>;
    })}</div>

    <div className="tuning-calibration-foot">
      {live ? <LiveLog text={text} language={language} lines={live.log}/> : job.liveLog?.length ? <LiveLog text={text} language={language} lines={job.liveLog} saved/> : null}
      <section className="tuning-facts"><h3>{text.backend}</h3>
        <dl><div><dt>{text.backend}</dt><dd>{job.backend === 'unknown' ? text.unknownBackend : job.backend.toUpperCase()}</dd></div>
          <div><dt>{text.layerSplit}</dt><dd>{job.layerSplit ? text.yes : text.no}</dd></div>
          {confirm?.samples.length ? <div><dt>{text.confirm}</dt><dd>{formatRate(job.baseRate, language)} → {formatRate(job.tunedRate, language)} tok/s</dd></div> : null}
          <div><dt>{text.rule}</dt><dd>{text.ruleText.replaceAll('{rounds}', String(job.rounds))}</dd></div></dl>
      </section>
    </div>
  </div>;
}
