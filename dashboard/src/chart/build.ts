import type {
  ChartCell,
  ChartGrid,
  ChartOptions,
  ChartRow,
  ChartSeries,
  ChartTheme,
} from './types';

const Y_AXIS_GAP = 2; // " ┤" between label and plot

const SUBSCRIPTS: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  ':': '꞉',
};

const formatHms = (ts: number): string => {
  const d = new Date(ts);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const resampleToWidth = <T>(arr: readonly T[], targetLength: number): readonly T[] => {
  const n = arr.length;
  if (n === 0 || n <= targetLength) return arr;
  const out: T[] = new Array(targetLength);
  for (let i = 0; i < targetLength; i++) {
    const idx = Math.min(n - 1, Math.round((i * (n - 1)) / (targetLength - 1)));
    out[i] = arr[idx]!;
  }
  return out;
};

const scaleToRow = (
  value: number,
  vmin: number,
  vrange: number,
  plotH: number,
): number => {
  const row = Math.round(plotH - 1 - ((value - vmin) / vrange) * (plotH - 1));
  if (row < 0) return 0;
  if (row >= plotH) return plotH - 1;
  return row;
};

const computeBounds = (
  series: readonly ChartSeries[],
  forcedMin?: number,
  forcedMax?: number,
): { min: number; max: number } => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const s of series) {
    for (const v of s.values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (forcedMin !== undefined) min = forcedMin;
  if (forcedMax !== undefined) max = forcedMax;
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  return { min, max };
};

const drawSeriesOntoGrid = (
  chars: string[][],
  colors: (string | undefined)[][],
  rows: readonly number[],
  color: string,
): void => {
  if (rows.length === 0) return;
  chars[rows[0]!]![0] = '╶'; // ╶
  colors[rows[0]!]![0] = color;

  for (let i = 1; i < rows.length; i++) {
    const curr = rows[i]!;
    const prev = rows[i - 1]!;

    if (curr === prev) {
      chars[curr]![i] = '─'; // ─
      colors[curr]![i] = color;
      continue;
    }

    if (curr < prev) {
      // value went UP (smaller row index is higher on screen)
      chars[curr]![i] = '╭'; // ╭
      colors[curr]![i] = color;
      chars[prev]![i] = '╯'; // ╯
      colors[prev]![i] = color;
      for (let r = curr + 1; r < prev; r++) {
        chars[r]![i] = '│'; // │
        colors[r]![i] = color;
      }
    } else {
      // value went DOWN
      chars[prev]![i] = '╮'; // ╮
      colors[prev]![i] = color;
      chars[curr]![i] = '╰'; // ╰
      colors[curr]![i] = color;
      for (let r = prev + 1; r < curr; r++) {
        chars[r]![i] = '│'; // │
        colors[r]![i] = color;
      }
    }
  }
};

const buildYLabel = (value: number, width: number): string => value.toFixed(2).padStart(width);

const cellsFromString = (text: string, color: string | undefined): ChartCell[] =>
  Array.from(text, (c) => ({ char: c, color }));

const blankCells = (count: number): ChartCell[] => {
  const out: ChartCell[] = new Array(count);
  for (let i = 0; i < count; i++) out[i] = { char: ' ' };
  return out;
};

const buildTimeLabelRow = (
  refTimestamps: readonly number[] | undefined,
  plotW: number,
  labelW: number,
  totalW: number,
  timeColor: string | undefined,
): ChartRow => {
  if (!refTimestamps || refTimestamps.length === 0) return blankCells(totalW);

  const line: string[] = new Array(totalW).fill(' ');
  const lblLen = formatHms(refTimestamps[0]!).length; // "HH:MM:SS" → 8
  const gap = 2;
  let maxLabels = Math.floor(plotW / (lblLen + gap));
  if (maxLabels < 2) maxLabels = 2;
  if (maxLabels > 7) maxLabels = 7;
  const numLabels = Math.min(maxLabels, refTimestamps.length);

  let lastEnd = -1;
  for (let li = 0; li < numLabels; li++) {
    const col =
      numLabels === 1 ? 0 : Math.round((li * (refTimestamps.length - 1)) / (numLabels - 1));
    const ts = refTimestamps[col];
    if (ts === undefined) continue;
    const lbl = formatHms(ts);
    const len = lbl.length;
    const pos = labelW + Y_AXIS_GAP + col - Math.floor(len / 2);
    if (pos <= lastEnd) continue;
    for (let k = 0; k < len; k++) {
      const ch = lbl[k]!;
      const idx = pos + k;
      if (idx >= 0 && idx < totalW) line[idx] = SUBSCRIPTS[ch] ?? ch;
    }
    lastEnd = pos + len;
  }
  return line.map((c) => ({ char: c, color: timeColor }));
};

/**
 * Port of multiline-asciichart.awk. Builds a 2D character grid representing
 * the chart, with each cell tagged with an optional color. Later series
 * overdraw earlier ones at the same cell.
 */
export const buildChart = (
  series: readonly ChartSeries[],
  opts: ChartOptions,
): ChartGrid => {
  const theme: ChartTheme = opts.theme ?? {};
  const { min, max } = computeBounds(series, opts.forcedMin, opts.forcedMax);
  const vrange = max - min;

  const labelW = Math.max(buildYLabel(min, 1).length, buildYLabel(max, 1).length) + 1;
  const totalW = Math.max(labelW + Y_AXIS_GAP + 4, opts.width);
  const plotW = Math.max(1, totalW - labelW - Y_AXIS_GAP);
  const plotH = Math.max(3, opts.height - 2); // reserve axis row + time-label row

  // Resample + scale each series.
  const resampledRows: number[][] = [];
  const resampledTimestamps: (readonly number[] | undefined)[] = [];
  for (const s of series) {
    if (s.values.length === 0) {
      resampledRows.push([]);
      resampledTimestamps.push(s.timestamps ?? undefined);
      continue;
    }
    const sampled = resampleToWidth(s.values, plotW);
    const sampledTs = s.timestamps ? resampleToWidth(s.timestamps, plotW) : undefined;
    const rows: number[] = new Array(sampled.length);
    for (let i = 0; i < sampled.length; i++) {
      rows[i] = scaleToRow(sampled[i]!, min, vrange, plotH);
    }
    resampledRows.push(rows);
    resampledTimestamps.push(sampledTs);
  }

  // Initialize grid.
  const chars: string[][] = new Array(plotH);
  const colors: (string | undefined)[][] = new Array(plotH);
  for (let r = 0; r < plotH; r++) {
    chars[r] = new Array(plotW).fill(' ');
    colors[r] = new Array(plotW).fill(undefined);
  }

  // Plot series in order, so later ones draw on top.
  for (let s = 0; s < series.length; s++) {
    drawSeriesOntoGrid(chars, colors, resampledRows[s]!, series[s]!.color);
  }

  // Pick reference series for x-axis timestamps (first with data).
  const refIdx = resampledRows.findIndex((r) => r.length > 0);
  const refTimestamps =
    refIdx >= 0 ? resampledTimestamps[refIdx] : undefined;

  // Assemble each plot row: y-label + " ┤" + plot chars.
  const outRows: ChartRow[] = [];
  for (let r = 0; r < plotH; r++) {
    const val = max - (r / Math.max(1, plotH - 1)) * vrange;
    const row: ChartCell[] = [
      ...cellsFromString(buildYLabel(val, labelW), theme.labelColor),
      { char: ' ' },
      { char: '┤', color: theme.axisColor }, // ┤
    ];
    for (let c = 0; c < plotW; c++) {
      row.push({ char: chars[r]![c]!, color: colors[r]![c] });
    }
    outRows.push(row);
  }

  // X-axis row.
  const axisRow: ChartCell[] = [
    ...blankCells(labelW + 1),
    { char: '┼', color: theme.axisColor }, // ┼
  ];
  for (let c = 0; c < plotW; c++) {
    axisRow.push({ char: '─', color: theme.axisColor }); // ─
  }
  outRows.push(axisRow);

  // Time-label row.
  outRows.push(buildTimeLabelRow(refTimestamps, plotW, labelW, totalW, theme.timeColor));

  return {
    rows: outRows,
    width: totalW,
    height: outRows.length,
    min,
    max,
  };
};
