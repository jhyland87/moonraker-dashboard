/**
 * One series plotted on the chart. Values are y-axis, timestamps (epoch ms)
 * are used for x-axis labels.
 */
export interface ChartSeries {
  readonly name: string;
  readonly color: string;
  readonly values: readonly number[];
  readonly timestamps?: readonly number[];
}

/**
 * A single cell in the rendered chart. `color === undefined` means default.
 */
export interface ChartCell {
  readonly char: string;
  readonly color?: string;
}

export type ChartRow = readonly ChartCell[];

export interface ChartTheme {
  readonly axisColor?: string;
  readonly labelColor?: string;
  readonly timeColor?: string;
}

export interface ChartOptions {
  readonly width: number;
  readonly height: number;
  readonly forcedMin?: number;
  readonly forcedMax?: number;
  readonly theme?: ChartTheme;
}

export interface ChartGrid {
  readonly rows: readonly ChartRow[];
  readonly width: number;
  readonly height: number;
  readonly min: number;
  readonly max: number;
}

export interface ColoredRun {
  readonly text: string;
  readonly color?: string;
}
