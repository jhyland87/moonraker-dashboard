import type { ChartSeries } from '../chart/index';
import type { SensorConfig, SensorsState } from '../types/index';

/**
 * Build the per-sensor chart series array for the temperature graph.
 *
 * Drawing order replicates `status.graph` in moonraker-cli:
 *   1. All target lines first (back layer), in reverse table order so the
 *      first table row's target sits on top within the target group.
 *   2. All current-temp lines next (front layer), same reverse order so
 *      the first table row's current temp sits on top overall.
 *
 * Net effect: targets never overdraw any current line, and `configs[0]`
 * is the most visually prominent series. Hidden sensors (per `hidden`,
 * keyed by `cfg.toggleKey`) are omitted entirely.
 *
 * @param state - Current sensor sample state, keyed by Moonraker object name.
 * @param configs - The configured sensor list (display order).
 * @param hidden - Set of toggle keys whose sensors should be omitted.
 * @returns The chart series in draw order (back to front).
 * @source
 */
export const buildSeries = (
  state: SensorsState,
  configs: readonly SensorConfig[],
  hidden: ReadonlySet<string>,
): readonly ChartSeries[] => {
  const series: ChartSeries[] = [];

  for (let i = configs.length - 1; i >= 0; i--) {
    const cfg = configs[i]!;
    if (!cfg.hasTarget) continue;
    if (hidden.has(cfg.toggleKey)) continue;
    const sensor = state[cfg.objectName];
    if (!sensor) continue;
    series.push({
      name: `${cfg.label} tgt`,
      color: cfg.dimColor,
      values: sensor.samples.map((s) => s.target),
      timestamps: sensor.samples.map((s) => s.timestamp),
    });
  }

  for (let i = configs.length - 1; i >= 0; i--) {
    const cfg = configs[i]!;
    if (hidden.has(cfg.toggleKey)) continue;
    const sensor = state[cfg.objectName];
    if (!sensor) continue;
    series.push({
      name: cfg.label,
      color: cfg.color,
      values: sensor.samples.map((s) => s.temperature),
      timestamps: sensor.samples.map((s) => s.timestamp),
    });
  }

  return series;
};
