import { toSubscript } from '../services/unicodeCase';
import type {
  ChartCell,
  ChartGrid,
  ChartOptions,
  ChartRenderer,
  ChartRow,
  ChartSeries,
  ChartTheme,
} from './types';

/** Width of the gap (" ┤") between the y-axis label column and the plot. */
const Y_AXIS_GAP = 2;

/**
 * Format an epoch-ms timestamp as `HH:MM:SS`.
 *
 * @param ts - Epoch milliseconds.
 * @returns A zero-padded 8-character time string.
 * @source
 */
const formatHms = (ts: number): string => {
  const d = new Date(ts);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/**
 * Linearly resample an array down to `targetLength` elements by picking
 * the closest source index for each target slot. Returns the original
 * array unchanged when it already fits.
 *
 * Throws if it ever fails to read a source element — this would mean
 * the index math is wrong, not a normal runtime condition. Throwing
 * loudly is preferable to producing a quietly-malformed plot.
 *
 * @param arr - Source data.
 * @param targetLength - Desired output length.
 * @returns A new array of length `targetLength`, or `arr` itself.
 * @source
 */
const resampleToWidth = <T>(arr: readonly T[], targetLength: number): readonly T[] => {
  const n = arr.length;
  if (n === 0 || n <= targetLength) return arr;
  // `Array.from({length})` creates a dense, ordinary array — the Google
  // style guide forbids `Array()` / `new Array()` because they produce
  // sparse arrays whose iteration semantics differ from literals.
  return Array.from({ length: targetLength }, (_, i) => {
    const idx = Math.min(n - 1, Math.round((i * (n - 1)) / (targetLength - 1)));
    const value = arr[idx];
    if (value === undefined) {
      throw new Error(`resampleToWidth: source index ${idx} unexpectedly undefined`);
    }
    return value;
  });
};

/**
 * Scale a series value into a plot row index (`0` = top, `plotH - 1` = bottom)
 * with bounds clamping.
 *
 * @param value - The data value.
 * @param vmin - Series minimum.
 * @param vrange - `max - min`.
 * @param plotH - Plot height in cells.
 * @returns A row index in `[0, plotH - 1]`.
 * @source
 */
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

/**
 * Walk every value in every series to find the joint `[min, max]` range.
 * `forced{Min,Max}` override the data-derived bounds; degenerate ranges
 * are spread by ±1 so the plot always has a visible band.
 *
 * @param series - Series to inspect.
 * @param forcedMin - Optional override for the lower bound.
 * @param forcedMax - Optional override for the upper bound.
 * @returns `{ min, max }`.
 * @source
 */
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

/**
 * Write `ch` at `(r, c)` into both the chars and colors grids, no-op'ing
 * if either grid row is missing or the column is out of range.
 *
 * Used by the palette + braille drawing passes. Keeping the bounds
 * check here means the callers can use plain `r` / `c` integers without
 * needing the non-null assertion operator.
 *
 * @source
 */
const writeCell = (
  chars: string[][],
  colors: (string | undefined)[][],
  r: number,
  c: number,
  ch: string,
  color: string,
): void => {
  const charRow = chars[r];
  const colorRow = colors[r];
  if (charRow === undefined || colorRow === undefined) return;
  if (c < 0 || c >= charRow.length) return;
  charRow[c] = ch;
  colorRow[c] = color;
};

/**
 * Draw one resampled series onto the plot grid using the palette-style
 * box-drawing characters. Adjacent samples are connected with vertical
 * runs of `│` and the appropriate corner glyphs (`╭` / `╮` / `╰` / `╯`).
 *
 * @param chars - Mutable grid of plot characters.
 * @param colors - Mutable grid of per-cell colors.
 * @param rows - Pre-resampled row indices for each column of the plot.
 * @param color - Color applied to every cell this series touches.
 * @source
 */
const drawSeriesOntoGrid = (
  chars: string[][],
  colors: (string | undefined)[][],
  rows: readonly number[],
  color: string,
): void => {
  if (rows.length === 0) return;

  rows.forEach((curr, i) => {
    if (i === 0) {
      writeCell(chars, colors, curr, 0, '╶', color);
      return;
    }
    const prev = rows[i - 1];
    if (prev === undefined) return;

    if (curr === prev) {
      writeCell(chars, colors, curr, i, '─', color);
      return;
    }

    if (curr < prev) {
      // value went UP (smaller row index is higher on screen)
      writeCell(chars, colors, curr, i, '╭', color);
      writeCell(chars, colors, prev, i, '╯', color);
      for (let r = curr + 1; r < prev; r++) {
        writeCell(chars, colors, r, i, '│', color);
      }
    } else {
      // value went DOWN
      writeCell(chars, colors, prev, i, '╮', color);
      writeCell(chars, colors, curr, i, '╰', color);
      for (let r = prev + 1; r < curr; r++) {
        writeCell(chars, colors, r, i, '│', color);
      }
    }
  });
};

/**
 * Bit position of the braille dot at `(dotRow, dotCol)` within a single
 * character cell. Mirrors the Unicode braille pattern standard
 * (U+2800..U+28FF):
 *
 *     col0 col1
 *   +----+----+
 *   |0x01|0x08|  dotRow 0
 *   |0x02|0x10|  dotRow 1
 *   |0x04|0x20|  dotRow 2
 *   |0x40|0x80|  dotRow 3
 *   +----+----+
 *
 * Encoded as a function rather than a 2-D table so callers don't need
 * to chain `!` operators through an array lookup; the function is
 * exhaustive over the documented input range and returns `0` for any
 * out-of-range input.
 *
 * @param dotRow - 0..3.
 * @param dotCol - 0..1.
 * @returns The dot's bitmask in the cell's braille glyph.
 * @source
 */
const brailleDotBit = (dotRow: number, dotCol: number): number => {
  if (dotCol === 0) {
    switch (dotRow) {
      case 0:
        return 0x01;
      case 1:
        return 0x02;
      case 2:
        return 0x04;
      case 3:
        return 0x40;
      default:
        return 0;
    }
  }
  if (dotCol === 1) {
    switch (dotRow) {
      case 0:
        return 0x08;
      case 1:
        return 0x10;
      case 2:
        return 0x20;
      case 3:
        return 0x80;
      default:
        return 0;
    }
  }
  return 0;
};

/**
 * Light a single dot at `(dotX, dotY)` in dot space (dot space is
 * `2*plotW` by `4*plotH` with `(0, 0)` at the top-left). Out-of-range
 * dots are silently ignored.
 *
 * `colors` is per-cell, last-writer-wins — matches the palette renderer's
 * "later series overdraws earlier ones in shared cells" rule.
 *
 * @source
 */
const lightBrailleDot = (
  bits: Uint8Array,
  colors: (string | undefined)[],
  dotX: number,
  dotY: number,
  plotW: number,
  plotH: number,
  color: string,
): void => {
  if (dotX < 0 || dotX >= plotW * 2) return;
  if (dotY < 0 || dotY >= plotH * 4) return;
  const cellCol = dotX >> 1;
  const cellRow = dotY >> 2;
  const dotCol = dotX & 1;
  const dotRow = dotY & 3;
  const i = cellRow * plotW + cellCol;
  if (i < 0 || i >= bits.length) return;
  // Indexed reads on `Uint8Array` narrow to `number | undefined` under
  // `noUncheckedIndexedAccess` (same rule as a regular array), so pull
  // the current mask into a local and default to 0 if it's reported
  // missing — the bounds check above guarantees the write is safe.
  const prev = bits[i] ?? 0;
  bits[i] = prev | brailleDotBit(dotRow, dotCol);
  colors[i] = color;
};

/**
 * Draw one resampled series onto the plot grid using braille dots.
 *
 * Each terminal column hosts two dot-columns, each terminal row hosts
 * four dot-rows — so the effective resolution is `(plotW*2) × (plotH*4)`
 * dots. The series is sampled once per dot-column and adjacent samples
 * are connected vertically so steep slopes draw as continuous lines.
 * Cells with no lit dots stay as a space.
 *
 * @param chars - Mutable grid of plot characters; populated with braille glyphs.
 * @param colors - Mutable grid of per-cell colors.
 * @param bolds - Mutable grid of per-cell bold flags. Set to `true` for
 *                cells this series writes when `bold` is `true`.
 * @param values - Raw series values (will be resampled to `plotW*2`).
 * @param plotW - Plot width in terminal cells.
 * @param plotH - Plot height in terminal cells.
 * @param vmin - Series minimum (for y-scaling).
 * @param vrange - Series value range (`max - min`).
 * @param color - Color applied to every cell this series touches.
 * @param bold - Whether to mark this series' cells with the bold flag.
 * @source
 */
const drawSeriesAsBraille = (
  chars: string[][],
  colors: (string | undefined)[][],
  bolds: boolean[][],
  values: readonly number[],
  plotW: number,
  plotH: number,
  vmin: number,
  vrange: number,
  color: string,
  bold: boolean,
): void => {
  if (values.length === 0) return;
  const dotW = plotW * 2;
  const dotH = plotH * 4;
  const bits = new Uint8Array(plotW * plotH);
  const cellColors: (string | undefined)[] = Array.from({ length: plotW * plotH }, () => undefined);

  const sampled = resampleToWidth(values, dotW);
  // Map a value to a dot-row index (0 = top). Stay in float space so the
  // vertical-connect step lands on the right cells when the slope is steep.
  const yToDot = (v: number): number =>
    ((vrange === 0 ? 0 : (vmin + vrange - v) / vrange)) * (dotH - 1);

  let prevDotY: number | null = null;
  sampled.forEach((v, dotX) => {
    if (!Number.isFinite(v)) {
      prevDotY = null;
      return;
    }
    const dotY = Math.round(yToDot(v));
    // Connect vertically to the previous dot-column so steep runs are solid.
    if (prevDotY !== null && Math.abs(dotY - prevDotY) > 1) {
      const step = dotY > prevDotY ? 1 : -1;
      for (let dy: number = prevDotY + step; dy !== dotY; dy += step) {
        lightBrailleDot(bits, cellColors, dotX, dy, plotW, plotH, color);
      }
    }
    lightBrailleDot(bits, cellColors, dotX, dotY, plotW, plotH, color);
    prevDotY = dotY;
  });

  // Project the per-cell bitmask into chars/colors. Only touch cells
  // that have lit dots so earlier series under this one stay visible
  // wherever this series didn't draw. Mark each touched cell as bold
  // only when the caller asked — the renderer treats bold as opt-in so
  // a "current value" series can be emphasized while target / reference
  // lines stay light.
  for (let r = 0; r < plotH; r++) {
    const charRow = chars[r];
    const colorRow = colors[r];
    const boldRow = bolds[r];
    if (charRow === undefined || colorRow === undefined || boldRow === undefined) continue;
    for (let c = 0; c < plotW; c++) {
      const i = r * plotW + c;
      const mask = bits[i];
      if (mask === undefined || mask === 0) continue;
      charRow[c] = String.fromCharCode(0x2800 + mask);
      colorRow[c] = cellColors[i];
      if (bold) boldRow[c] = true;
    }
  }
};

/**
 * Format a numeric value for the y-axis label column, right-padded to
 * `width` characters.
 *
 * @source
 */
const buildYLabel = (value: number, width: number): string =>
  value.toFixed(2).padStart(width);

/**
 * Convert a plain string into a row of {@link ChartCell}s, all sharing
 * the same color.
 *
 * @source
 */
const cellsFromString = (text: string, color: string | undefined): ChartCell[] =>
  Array.from(text, (c) => ({ char: c, color }));

/**
 * Build a row of `count` blank cells (no color).
 *
 * @source
 */
const blankCells = (count: number): ChartCell[] =>
  Array.from({ length: count }, () => ({ char: ' ' }));

/**
 * Build the bottom-of-chart row of x-axis time labels.
 *
 * Picks a reasonable number of labels based on plot width, centers each
 * label under its source column, and renders the digits + colon as
 * subscript glyphs (via {@link toSubscript}) so they read as a footer
 * rather than competing with the chart body.
 *
 * @param refTimestamps - Resampled timestamps of the reference series.
 * @param plotW - Width of the plot region in cells.
 * @param labelW - Width of the y-axis label column.
 * @param totalW - Total chart width.
 * @param timeColor - Color for the label cells.
 * @returns A {@link ChartRow} of length `totalW`.
 * @source
 */
const buildTimeLabelRow = (
  refTimestamps: readonly number[] | undefined,
  plotW: number,
  labelW: number,
  totalW: number,
  timeColor: string | undefined,
): ChartRow => {
  if (!refTimestamps || refTimestamps.length === 0) return blankCells(totalW);
  const first = refTimestamps[0];
  if (first === undefined) return blankCells(totalW);

  const line: string[] = Array.from({ length: totalW }, () => ' ');
  const lblLen = formatHms(first).length; // "HH:MM:SS" → 8
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
    const lbl = toSubscript(formatHms(ts));
    const chars = Array.from(lbl);
    const len = chars.length;
    const pos = labelW + Y_AXIS_GAP + col - Math.floor(len / 2);
    if (pos <= lastEnd) continue;
    for (let k = 0; k < len; k++) {
      const ch = chars[k];
      if (ch === undefined) continue;
      const idx = pos + k;
      if (idx >= 0 && idx < totalW) line[idx] = ch;
    }
    lastEnd = pos + len;
  }
  return line.map((c) => ({ char: c, color: timeColor }));
};

/**
 * Build the chart grid.
 *
 * Port of multiline-asciichart.awk. Returns a 2D grid where each cell
 * carries a character and an optional color; later series overdraw
 * earlier ones at the same cell. Two glyph palettes are supported via
 * {@link ChartOptions.renderer}:
 *
 * - `'palette'` (default) — box-drawing characters, one mark per cell.
 *   Curves are pre-resampled to `plotW` columns and connected with
 *   vertical runs of `│` plus corner glyphs.
 * - `'braille'` — each cell holds a 2×4 dot bitmask rendered as a
 *   Unicode braille glyph (U+2800..U+28FF). 2× the horizontal and 4×
 *   the vertical resolution, with smoother slopes.
 *
 * Axis, y-labels, and the time-label row are renderer-independent.
 *
 * @param series - Series to plot.
 * @param opts - See {@link ChartOptions}.
 * @returns The composed chart grid.
 * @source
 */
export const buildChart = (
  series: readonly ChartSeries[],
  opts: ChartOptions,
): ChartGrid => {
  const theme: ChartTheme = opts.theme ?? {};
  const renderer: ChartRenderer = opts.renderer ?? 'palette';
  const { min, max } = computeBounds(series, opts.forcedMin, opts.forcedMax);
  const vrange = max - min;

  const labelW = Math.max(buildYLabel(min, 1).length, buildYLabel(max, 1).length) + 1;
  const totalW = Math.max(labelW + Y_AXIS_GAP + 4, opts.width);
  const plotW = Math.max(1, totalW - labelW - Y_AXIS_GAP);
  const plotH = Math.max(3, opts.height - 2); // reserve axis row + time-label row

  // Resample timestamps (used by the time-label row) at plot-column
  // resolution regardless of renderer. The palette renderer also uses
  // per-column row indices for its drawing pass; the braille renderer
  // skips that — it samples internally at dot-column resolution.
  const resampledTimestamps: (readonly number[] | undefined)[] = [];
  const resampledRows: number[][] = []; // only populated for the palette renderer
  for (const s of series) {
    if (s.values.length === 0) {
      resampledTimestamps.push(s.timestamps ?? undefined);
      if (renderer === 'palette') resampledRows.push([]);
      continue;
    }
    const sampledTs = s.timestamps ? resampleToWidth(s.timestamps, plotW) : undefined;
    resampledTimestamps.push(sampledTs);
    if (renderer === 'palette') {
      const sampled = resampleToWidth(s.values, plotW);
      const rows: number[] = sampled.map((v) => scaleToRow(v, min, vrange, plotH));
      resampledRows.push(rows);
    }
  }

  // Initialize grid. `bolds[r][c]` is only set by the braille pass;
  // the palette path keeps it false so axis/labels and series cells
  // share the same weight.
  const chars: string[][] = Array.from({ length: plotH }, () =>
    Array.from({ length: plotW }, () => ' '),
  );
  const colors: (string | undefined)[][] = Array.from({ length: plotH }, () =>
    Array.from({ length: plotW }, () => undefined),
  );
  const bolds: boolean[][] = Array.from({ length: plotH }, () =>
    Array.from({ length: plotW }, () => false),
  );

  // Plot series in order, so later ones draw on top.
  series.forEach((s, idx) => {
    if (renderer === 'braille') {
      drawSeriesAsBraille(
        chars,
        colors,
        bolds,
        s.values,
        plotW,
        plotH,
        min,
        vrange,
        s.color,
        s.bold === true,
      );
      return;
    }
    const rows = resampledRows[idx];
    if (rows === undefined) return;
    drawSeriesOntoGrid(chars, colors, rows, s.color);
  });

  // Pick reference series for x-axis timestamps (first with data).
  const refIdx = resampledTimestamps.findIndex((t) => t !== undefined && t.length > 0);
  const refTimestamps = refIdx >= 0 ? resampledTimestamps[refIdx] : undefined;

  // Assemble each plot row: y-label + " ┤" + plot chars.
  const outRows: ChartRow[] = [];
  for (let r = 0; r < plotH; r++) {
    const charRow = chars[r];
    const colorRow = colors[r];
    const boldRow = bolds[r];
    // Empty rows should be impossible (we allocated `plotH` of them
    // above), but `noUncheckedIndexedAccess` requires the check.
    if (charRow === undefined || colorRow === undefined || boldRow === undefined) {
      outRows.push(blankCells(totalW));
      continue;
    }
    const val = max - (r / Math.max(1, plotH - 1)) * vrange;
    const row: ChartCell[] = [
      ...cellsFromString(buildYLabel(val, labelW), theme.labelColor),
      { char: ' ' },
      { char: '┤', color: theme.axisColor }, // ┤
    ];
    for (let c = 0; c < plotW; c++) {
      const ch = charRow[c] ?? ' ';
      const col = colorRow[c];
      const cell: ChartCell = boldRow[c]
        ? { char: ch, color: col, bold: true }
        : { char: ch, color: col };
      row.push(cell);
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
