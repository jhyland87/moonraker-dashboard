import { useMemo } from 'react';

import { AsciiLineChart } from './AsciiLineChart';
import type { ChartSeries } from '../chart/index';
import { buildSeries } from '../services/chartSeries';
import type { SensorConfig, SensorsState } from '../types/index';

/**
 * Color theme handed to {@link AsciiLineChart}. Centralized here so a
 * future theming pass only has to update one place.
 * @source
 */
const CHART_THEME = {
  axisColor: 'BrightBlack',
  labelColor: 'BrightBlack',
  timeColor: 'BrightBlack',
} as const;

/**
 * Props for {@link TemperatureChartPanel}.
 * @source
 */
export interface TemperatureChartPanelProps {
  /** Live sensor sample state, keyed by Moonraker object name. */
  readonly sensors: SensorsState;
  /** Sensor display order + colors. */
  readonly configs: readonly SensorConfig[];
  /** Set of toggle keys whose series should be hidden. */
  readonly hidden: ReadonlySet<string>;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Wraps {@link AsciiLineChart} with the dashboard's series-building logic
 * and theme. The {@link buildSeries} call is memoized against
 * `sensors`/`configs`/`hidden` so adding a new sample doesn't allocate the
 * whole series object graph from scratch.
 *
 * Layered behind every other component in the chart area — App swaps this
 * out for {@link BedMeshPanel} when the user toggles the bed-mesh view.
 *
 * @param props - See {@link TemperatureChartPanelProps}.
 * @returns The chart element.
 * @source
 */
export const TemperatureChartPanel = ({
  sensors,
  configs,
  hidden,
  x,
  y,
  width,
  height,
}: TemperatureChartPanelProps) => {
  const series = useMemo<readonly ChartSeries[]>(
    () => buildSeries(sensors, configs, hidden),
    [sensors, configs, hidden],
  );
  return (
    <AsciiLineChart
      series={series}
      width={width}
      height={height}
      x={x}
      y={y}
      theme={CHART_THEME}
    />
  );
};
