/**
 * One series plotted on the chart. Values are y-axis, timestamps (epoch
 * ms) are used for x-axis labels.
 *
 * `bold` is renderer-respecting: in the braille renderer, setting
 * `bold: true` makes every cell this series touches render with the ANSI
 * bold attribute so the line stands out. The palette renderer ignores it
 * (its glyphs aren't visually improved by bolding). Caller-driven so a
 * primary "current value" series can be emphasized over a dim target
 * series.
 * @source
 */
export interface ChartSeries {
  readonly name: string;
  readonly color: string;
  readonly values: readonly number[];
  readonly timestamps?: readonly number[];
  readonly bold?: boolean;
}

/**
 * A single cell in the rendered chart.
 *
 * - `color === undefined` means default (no ANSI fg override).
 * - `bold === true` adds the ANSI bold attribute. Used by the braille
 *   renderer to make plotted series stand out vs. the axis/labels.
 * @source
 */
export interface ChartCell {
  readonly char: string;
  readonly color?: string;
  readonly bold?: boolean;
}

/**
 * One full row of {@link ChartCell}s ready for run-batching.
 * @source
 */
export type ChartRow = readonly ChartCell[];

export interface ChartTheme {
  readonly axisColor?: string;
  readonly labelColor?: string;
  readonly timeColor?: string;
}

/**
 * Glyph palette used by {@link buildChart}.
 *
 * - `'palette'` — original box-drawing characters, one mark per terminal cell.
 * - `'braille'` — Unicode braille glyphs encoding a 2×4 dot grid per cell.
 * @source
 */
export type ChartRenderer = 'palette' | 'braille';

/**
 * Options passed to {@link buildChart}.
 * @source
 */
export interface ChartOptions {
  readonly width: number;
  readonly height: number;
  readonly forcedMin?: number;
  readonly forcedMax?: number;
  readonly theme?: ChartTheme;
  /**
   * Which character set to draw series with. Defaults to `'palette'`
   * for backwards compatibility; callers should explicitly pass the
   * user's configured renderer when invoking from the dashboard.
   */
  readonly renderer?: ChartRenderer;
}

export interface ChartGrid {
  readonly rows: readonly ChartRow[];
  readonly width: number;
  readonly height: number;
  readonly min: number;
  readonly max: number;
}

/**
 * A horizontal run of characters within a row that share the same color
 * + bold attributes. Emitted by {@link buildRuns} so the renderer can
 * collapse many cells into one `<Text>` element per attribute change.
 * @source
 */
export interface ColoredRun {
  readonly text: string;
  readonly color?: string;
  readonly bold?: boolean;
}
