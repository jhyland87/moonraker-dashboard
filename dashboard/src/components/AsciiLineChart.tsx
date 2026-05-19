import { useMemo } from 'react';
import { Text } from 'react-curse';

import { buildChart, buildRuns } from '../chart/index';
import type { ChartSeries, ChartTheme } from '../chart/index';

interface AsciiLineChartProps {
  readonly series: readonly ChartSeries[];
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
  readonly theme?: ChartTheme;
  readonly forcedMin?: number;
  readonly forcedMax?: number;
}

export const AsciiLineChart = ({
  series,
  width,
  height,
  x = 0,
  y = 0,
  theme,
  forcedMin,
  forcedMax,
}: AsciiLineChartProps) => {
  const grid = useMemo(
    () => buildChart(series, { width, height, theme, forcedMin, forcedMax }),
    [series, width, height, theme, forcedMin, forcedMax],
  );

  return (
    <Text x={x} y={y}>
      {grid.rows.map((row, rowIndex) => (
        <Text key={rowIndex} x={0} y={rowIndex}>
          {buildRuns(row).map((run, runIndex) => (
            <Text key={runIndex} color={run.color}>
              {run.text}
            </Text>
          ))}
        </Text>
      ))}
    </Text>
  );
};
