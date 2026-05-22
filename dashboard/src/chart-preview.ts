/**
 * Offline preview of the chart with synthetic data — useful for tuning visuals
 * without needing a live printer.
 *
 * Usage: pnpm --filter dashboard preview
 */
import { buildChart, buildRuns } from './chart/index';
import type { ChartSeries } from './chart/index';
import { config } from './config/index';

const NOW = Date.now();
const POINTS = 200;

const makeSeries = (
  name: string,
  color: string,
  fn: (i: number) => number,
): ChartSeries => ({
  name,
  color,
  values: Array.from({ length: POINTS }, (_, i) => fn(i)),
  timestamps: Array.from({ length: POINTS }, (_, i) => NOW - (POINTS - i - 1) * 1000),
});

// Synthetic profile loosely mirroring the screenshot the user shared.
const extruderTemp = (i: number): number => {
  if (i < 30) return 23 + i * 0.4;
  if (i < 80) return 35 + (i - 30) * 4.7;
  if (i < 150) return 270 + Math.sin(i * 0.4) * 5;
  return 270 - (i - 150) * 0.6;
};
const extruderTarget = (i: number): number => {
  if (i < 25) return 0;
  if (i < 150) return 270;
  return 0;
};
const bedTemp = (i: number): number => {
  if (i < 15) return 22 + i * 0.3;
  if (i < 50) return 26 + (i - 15) * 1.0;
  return 60 + Math.sin(i * 0.15) * 0.8;
};
const bedTarget = (i: number): number => (i < 10 ? 0 : 60);
const chamberFan = (i: number): number => 30 + Math.sin(i * 0.06) * 1.5;
const chamberFanTarget = (): number => 35;
const chamberTemp = (i: number): number => 30 + Math.sin(i * 0.04) * 1.5;
const mcuTemp = (i: number): number => 48 + Math.sin(i * 0.1) * 2;

const generators: Record<string, (i: number) => number> = {
  extruder: extruderTemp,
  heater_bed: bedTemp,
  'temperature_fan chamber_fan': chamberFan,
  'temperature_sensor chamber_temp': chamberTemp,
  'temperature_sensor mcu_temp': mcuTemp,
};
const targetGenerators: Record<string, (i: number) => number> = {
  extruder: extruderTarget,
  heater_bed: bedTarget,
  'temperature_fan chamber_fan': chamberFanTarget,
};

// Build series with the same back-to-front ordering rule as App.tsx.
// `slice().reverse()` flips the array so each `for..of` iteration yields
// a real `SensorConfig` rather than an indexed-access `T | undefined`.
const series: ChartSeries[] = [];
const reversed = config.sensors.slice().reverse();
for (const cfg of reversed) {
  if (!cfg.hasTarget) continue;
  const gen = targetGenerators[cfg.objectName];
  if (!gen) continue;
  series.push(makeSeries(`${cfg.label} tgt`, cfg.dimColor, gen));
}
for (const cfg of reversed) {
  const gen = generators[cfg.objectName];
  if (!gen) continue;
  series.push(makeSeries(cfg.label, cfg.color, gen));
}

const COLS = process.stdout.columns ?? 120;
const ROWS = Math.max(20, (process.stdout.rows ?? 36) - 4);

const grid = buildChart(series, {
  width: COLS,
  height: ROWS,
  theme: { axisColor: 'gray', labelColor: 'gray', timeColor: 'gray' },
});

const RESET = '\x1b[0m';
const toAnsi = (color?: string): string => {
  if (!color) return '';
  if (color.startsWith('#')) {
    const h = color.slice(1);
    const exp = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(exp.slice(0, 2), 16);
    const g = parseInt(exp.slice(2, 4), 16);
    const b = parseInt(exp.slice(4, 6), 16);
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  if (color === 'gray') return '\x1b[90m';
  return '';
};

// Legend banner — sensors in display (table) order, bright colors.
let legend = '';
for (const cfg of config.sensors) {
  const a = toAnsi(cfg.color);
  legend += ` ${a}───${RESET} ${a}${cfg.label}${RESET} `;
}
process.stdout.write(legend + '\n');

for (const row of grid.rows) {
  let line = '';
  for (const run of buildRuns(row)) {
    const code = toAnsi(run.color);
    line += `${code}${run.text}${code ? RESET : ''}`;
  }
  process.stdout.write(line + '\n');
}
