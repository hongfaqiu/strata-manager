import type { ContextBenchmarkReport, ContextBenchmarkSample } from '@strata-manager/core';

type Language = 'zh-CN' | 'en';
type ChartSnapshot = { title: string; unit: string; svg: string; width: number; height: number };
type Column = { title: string; unit: string; weight: number; value: (sample: ContextBenchmarkSample) => string };
const FONT = '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", Arial, sans-serif';
const MAX_EDGE = 8192;
const MAX_PIXELS = 32 * 1024 * 1024;
const SVG_STYLES = ['color', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant-numeric', 'letter-spacing', 'text-anchor', 'dominant-baseline', 'paint-order', 'vector-effect', 'visibility', 'display'];

function captureCharts(charts: HTMLElement, language: Language): ChartSnapshot[] {
  const zh = language === 'zh-CN';
  const sections = [...charts.querySelectorAll<HTMLElement>('.context-benchmark-chart')];
  if (sections.length !== 3) throw new Error(zh ? '无法读取三张 Benchmark 图表，请等待图表显示后重试。' : 'The three benchmark charts are unavailable. Wait for the charts and retry.');
  return sections.map(section => {
    const source = section.querySelector<SVGSVGElement>('svg');
    if (!source || source.querySelector('foreignObject, image, use, script')) throw new Error(zh ? '图表不是可安全导出的 SVG，请刷新后重试。' : 'A chart is not a supported SVG. Refresh and retry.');
    const view = source.viewBox.baseVal;
    const width = view.width || source.getBoundingClientRect().width;
    const height = view.height || source.getBoundingClientRect().height;
    if (!(width > 0 && height > 0)) throw new Error(zh ? '图表尚未完成布局，暂时无法导出。' : 'The charts have not finished laying out.');
    const copy = source.cloneNode(true) as SVGSVGElement;
    const originals = [source, ...source.querySelectorAll<SVGElement>('*')];
    const clones = [copy, ...copy.querySelectorAll<SVGElement>('*')];
    originals.forEach((element, index) => {
      const style = getComputedStyle(element), clone = clones[index]!;
      clone.removeAttribute('class');
      for (const property of SVG_STYLES) {
        let value = style.getPropertyValue(property);
        if (value === 'currentcolor' || value === 'currentColor') value = style.color;
        if (value) clone.style.setProperty(property, value);
      }
      // SVG images cannot load page web fonts. Native fallbacks render Chinese
      // consistently while preserving every captured font size and weight.
      clone.style.setProperty('font-family', FONT);
    });
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', String(width)); copy.setAttribute('height', String(height));
    const heading = section.querySelector('h3');
    const unit = heading?.querySelector('span')?.textContent?.trim() ?? '';
    const title = [...(heading?.childNodes ?? [])].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim()
      || section.getAttribute('aria-label') || (zh ? 'Benchmark 图表' : 'Benchmark chart');
    return { title, unit, svg: new XMLSerializer().serializeToString(copy), width, height };
  });
}

function loadSvg(snapshot: ChartSnapshot, language: Language): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image(), url = URL.createObjectURL(new Blob([snapshot.svg], { type: 'image/svg+xml;charset=utf-8' }));
    const timer = setTimeout(() => fail(), 15000);
    const release = () => { clearTimeout(timer); URL.revokeObjectURL(url); };
    const fail = () => { release(); reject(new Error(language === 'zh-CN' ? '图表转换失败，请重试图片导出。' : 'Chart conversion failed. Retry the image export.')); };
    image.onload = () => { release(); resolve(image); };
    image.onerror = fail;
    image.src = url;
  });
}

function wrapped(context: CanvasRenderingContext2D, value: string, width: number): string[] {
  const output: string[] = [];
  for (const paragraph of String(value).split('\n')) {
    let line = '';
    for (const character of Array.from(paragraph)) {
      const next = line + character;
      if (line && context.measureText(next).width > width) { output.push(line); line = character; }
      else line = next;
    }
    output.push(line);
  }
  return output;
}

/** Snapshot DOM and report before the first await, then produce a complete PNG. */
export async function createContextBenchmarkImage(report: ContextBenchmarkReport, charts: HTMLElement, language: Language): Promise<Blob> {
  const zh = language === 'zh-CN', text = (cn: string, en: string) => zh ? cn : en;
  if (!report.samples.length) throw new Error(text('没有可导出的测量结果，请先完成一次测试。', 'No measurements are available. Run a benchmark first.'));
  const saved = structuredClone(report), snapshots = captureCharts(charts, language);
  const style = getComputedStyle(charts.closest('.context-benchmark-page') ?? charts);
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const theme = {
    background: color('--st-bg', '#f5f6f7'), surface: color('--st-surface', '#ffffff'), raised: color('--st-surface-2', '#f1f3f5'),
    ink: color('--st-ink', '#18202a'), muted: color('--st-ink-muted', '#687384'), line: color('--st-line', '#d8dde3'),
    danger: color('--st-danger-text', '#b73849'), warning: color('--st-warn-text', '#956618'),
  };
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
  if (!context) throw new Error(text('当前环境无法生成 PNG 图片。', 'This environment cannot create a PNG image.'));
  const number = (value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(language, { maximumFractionDigits: digits });
  const tier = (value: number | null) => value == null ? '—' : value >= 1048576 && value % 1048576 === 0 ? `${value / 1048576}M` : value % 1024 === 0 ? `${value / 1024}K` : number(value, 0);
  const state = (value: ContextBenchmarkSample['state']) => ({ completed: text('完成', 'Completed'), failed: text('失败', 'Failed'), cancelled: text('已停止', 'Stopped') })[value];
  const date = (value: number) => Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString(language, { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
  const width = 1600, margin = 40, innerWidth = width - margin * 2, gap = 18;
  const chartWidth = (innerWidth - gap * 2) / 3, plotWidth = chartWidth - 28;
  const chartHeight = Math.max(...snapshots.map(chart => plotWidth / chart.width * chart.height)) + 66;
  const columns: Column[] = [
    { title: text('档位', 'Tier'), unit: '', weight: 1, value: sample => tier(sample.targetTokens) },
    ...(saved.options.rounds > 1 ? [{ title: text('轮次', 'Round'), unit: '', weight: .55, value: (sample: ContextBenchmarkSample) => number(sample.round, 0) }] : []),
    { title: text('实际输入', 'Actual input'), unit: 'token', weight: 1.15, value: sample => number(sample.promptTokens, 0) },
    { title: text('实际输出', 'Actual output'), unit: 'token', weight: 1, value: sample => number(sample.completionTokens, 0) },
    { title: text('预填充', 'Prefill'), unit: 'tok/s', weight: 1.1, value: sample => number(sample.prefillTokS) },
    { title: text('解码', 'Decode'), unit: 'tok/s', weight: 1, value: sample => number(sample.decodeTokS) },
    { title: text('整卡显存峰值', 'Peak GPU memory'), unit: 'MiB', weight: 1.4, value: sample => number(sample.peakGpuMemory == null ? null : sample.peakGpuMemory / 2 ** 20, 0) },
    { title: text('最低空闲显存', 'Min. free GPU memory'), unit: 'MiB', weight: 1.45, value: sample => number(sample.minGpuMemoryFree == null ? null : sample.minGpuMemoryFree / 2 ** 20, 0) },
    { title: text('RAM 峰值', 'Peak RAM'), unit: 'GiB', weight: 1, value: sample => number(sample.peakRam == null ? null : sample.peakRam / 2 ** 30) },
    { title: text('总耗时', 'Wall time'), unit: 's', weight: 1, value: sample => number(sample.wallMs / 1000, 2) },
    { title: text('状态', 'Status'), unit: '', weight: 1, value: sample => state(sample.state) },
  ];
  const weight = columns.reduce((sum, column) => sum + column.weight, 0);
  const columnWidths = columns.map(column => innerWidth * column.weight / weight);
  context.font = `16px ${FONT}`;
  const metadata = [
    `${text('模型', 'Model')}  ${saved.model}`,
    `${text('测试配置', 'Configuration')}  ${saved.options.configurationLabel || saved.profileName}`,
    `${date(saved.startedAt)} – ${date(saved.finishedAt)} (UTC+8) · ${state(saved.state)}`,
    `${text('模型上下文', 'Model context')} ${tier(saved.maxContext)} · ${text('最大输出', 'Output limit')} ${number(saved.options.maxTokens, 0)} token · ${text('每档轮数', 'Rounds per tier')} ${saved.options.rounds} · ${text('请求超时', 'Request timeout')} ${number(saved.options.timeoutMs / 1000, 0)} s`,
    `temperature=0 · reasoning_effort=none · ${text('纯文本输入 · 单请求串行', 'Text input · Serial requests')}`,
  ].flatMap(line => wrapped(context, line, innerWidth));
  const chartTop = margin + 54 + metadata.length * 27 + 25;
  const tableTop = chartTop + chartHeight + 58;
  context.font = `600 15px ${FONT}`;
  const headerLines = columns.map((column, index) => wrapped(context, column.title, columnWidths[index]! - 24));
  const headerHeight = Math.max(...headerLines.map(lines => lines.length)) * 21 + 40;
  context.font = `15px ${FONT}`;
  const rowLayouts = saved.samples.map(sample => {
    const cells = columns.map((column, index) => wrapped(context, column.value(sample), columnWidths[index]! - 24));
    const error = sample.error ? wrapped(context, `${tier(sample.targetTokens)}${saved.options.rounds > 1 ? ` / ${sample.round}` : ''} · ${sample.error}`, innerWidth - 32) : [];
    return { sample, cells, error, height: Math.max(...cells.map(lines => lines.length)) * 21 + 26 + (error.length ? error.length * 21 + 10 : 0) };
  });
  context.font = `14px ${FONT}`;
  const notes = [
    text('图表为成功请求的档位均值；表格保留每次测量，缺失值为 —。', 'Charts show per-tier means of successful requests; the table includes every measurement. Missing values are —.'),
    text(`显存与 RAM 为整卡／整机读数，采样间隔 ${number(saved.resourceIntervalMs / 1000)} 秒，可能包含其他程序。`, `GPU memory and RAM cover the whole system, sampled every ${number(saved.resourceIntervalMs / 1000)} seconds, and may include other programs.`),
    text('实际 token 来自 usage，速度来自 timings，总耗时为端到端请求时间。缓存与预热状态会影响结果。', 'Tokens come from usage, throughput from timings, and wall time covers the full request. Cache and warmup state affect results.'),
    ...saved.skippedTiers.map(skipped => `${tier(skipped.targetTokens)} · ${text('已跳过', 'Skipped')} · ${skipped.reason}`),
  ].flatMap(line => wrapped(context, line, innerWidth));
  const rowsHeight = rowLayouts.reduce((sum, row) => sum + row.height, 0);
  const height = Math.ceil(tableTop + headerHeight + rowsHeight + 28 + notes.length * 23 + margin);
  const scale = Math.min(2, MAX_EDGE / width, MAX_EDGE / height, Math.sqrt(MAX_PIXELS / (width * height)));
  if (scale < 1) throw new Error(text('完整结果超过单张图片的尺寸上限，请使用 JSON 或 CSV 导出；图片不会截断测量结果。', 'The complete report exceeds the image size limit. Export JSON or CSV; measurements will not be truncated.'));
  try {
    const images = await Promise.all(snapshots.map(snapshot => loadSvg(snapshot, language)));
    await document.fonts.ready;
    canvas.width = Math.floor(width * scale); canvas.height = Math.floor(height * scale);
    context.scale(scale, scale); context.textBaseline = 'top';
    const fillText = (value: string, x: number, y: number, size = 16, bold = false, color = theme.ink) => {
      context.font = `${bold ? '600 ' : ''}${size}px ${FONT}`; context.fillStyle = color; context.fillText(value, x, y);
    };
    context.fillStyle = theme.background; context.fillRect(0, 0, width, height);
    fillText(text('Strata · 上下文档位实测', 'Strata · Context tier benchmark'), margin, margin, 30, true);
    metadata.forEach((line, index) => fillText(line, margin, margin + 54 + index * 27, 16, index < 2, index < 2 ? theme.ink : theme.muted));
    snapshots.forEach((chart, index) => {
      const x = margin + index * (chartWidth + gap);
      context.fillStyle = theme.surface; context.fillRect(x, chartTop, chartWidth, chartHeight);
      context.strokeStyle = theme.line; context.lineWidth = 1; context.strokeRect(x + .5, chartTop + .5, chartWidth - 1, chartHeight - 1);
      fillText(chart.title, x + 14, chartTop + 16, 18, true);
      context.font = `14px ${FONT}`; const unitWidth = context.measureText(chart.unit).width;
      fillText(chart.unit, x + chartWidth - 14 - unitWidth, chartTop + 20, 14, false, theme.muted);
      const plotHeight = plotWidth / chart.width * chart.height;
      context.drawImage(images[index]!, x + 14, chartTop + 54, plotWidth, plotHeight);
    });
    fillText(text('逐次测量', 'Measurements'), margin, tableTop - 36, 20, true);
    context.fillStyle = theme.raised; context.fillRect(margin, tableTop, innerWidth, headerHeight);
    let x = margin;
    columns.forEach((column, index) => {
      headerLines[index]!.forEach((line, lineIndex) => fillText(line, x + 12, tableTop + 12 + lineIndex * 21, 15, true));
      if (column.unit) fillText(column.unit, x + 12, tableTop + headerHeight - 25, 13, false, theme.muted);
      x += columnWidths[index]!;
    });
    let y = tableTop + headerHeight;
    rowLayouts.forEach((row, index) => {
      context.fillStyle = index % 2 ? theme.background : theme.surface; context.fillRect(margin, y, innerWidth, row.height);
      x = margin;
      row.cells.forEach((lines, columnIndex) => {
        const statusColor = row.sample.state === 'failed' ? theme.danger : row.sample.state === 'cancelled' ? theme.warning : theme.ink;
        lines.forEach((line, lineIndex) => fillText(line, x + 12, y + 13 + lineIndex * 21, 15, false, columnIndex === columns.length - 1 ? statusColor : theme.ink));
        x += columnWidths[columnIndex]!;
      });
      const cellHeight = Math.max(...row.cells.map(lines => lines.length)) * 21 + 26;
      row.error.forEach((line, lineIndex) => fillText(line, margin + 16, y + cellHeight + lineIndex * 21, 14, false, theme.danger));
      y += row.height;
      context.strokeStyle = theme.line; context.beginPath(); context.moveTo(margin, y + .5); context.lineTo(width - margin, y + .5); context.stroke();
    });
    notes.forEach((line, index) => fillText(line, margin, y + 28 + index * 23, 14, false, theme.muted));
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(text('PNG 编码失败，请重试。', 'PNG encoding failed. Please retry.'))), 'image/png'));
  } catch (error) {
    throw new Error(text('图片导出失败，请重试。', 'Image export failed. Please retry.'), { cause: error });
  }
}
