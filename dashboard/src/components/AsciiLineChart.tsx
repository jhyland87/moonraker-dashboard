import { useMemo } from 'react';
import { Text } from 'react-curse';

import { buildChart, buildRuns } from '../chart/index';
import type { ChartRenderer, ChartSeries, ChartTheme } from '../chart/index';

/**
 * Props for {@link AsciiLineChart}.
 * @source
 */
export interface AsciiLineChartProps {
  readonly series: readonly ChartSeries[];
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
  readonly theme?: ChartTheme;
  readonly forcedMin?: number;
  readonly forcedMax?: number;
  /** Which character set to use when drawing the series. */
  readonly renderer?: ChartRenderer;
}

/**
 * Render the chart grid produced by {@link buildChart} as react-curse
 * `<Text>` runs. The series-drawing palette is selectable via
 * {@link AsciiLineChartProps.renderer}.
 *
 * @param props - See {@link AsciiLineChartProps}.
 * @returns The chart element.
 * @source
 */
export const AsciiLineChart = ({
  series,
  width,
  height,
  x = 0,
  y = 0,
  theme,
  forcedMin,
  forcedMax,
  renderer,
}: AsciiLineChartProps) => {
  const grid = useMemo(
    () => buildChart(series, { width, height, theme, forcedMin, forcedMax, renderer }),
    [series, width, height, theme, forcedMin, forcedMax, renderer],
  );

  return (
    <Text x={x} y={y}>
      {grid.rows.map((row, rowIndex) => (
        <Text key={rowIndex} x={0} y={rowIndex}>
          {buildRuns(row).map((run, runIndex) => (
            <Text key={runIndex} color={run.color} bold={run.bold === true}>
              {run.text}
            </Text>
          ))}
        </Text>
      ))}
    </Text>
  );
};
