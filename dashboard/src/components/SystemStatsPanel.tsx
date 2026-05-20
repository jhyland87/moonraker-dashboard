import { Text } from 'react-curse';

import type { KlipperStats } from '../hooks/useKlipperStats';
import type { MachineProcStats, TimedSample } from '../hooks/useMachineProcStats';

/**
 * System resource panel modeled after Fluidd's "System Utilization" card.
 *
 * Klipper Load and System Memory get the larger 2-row chip+bars treatment
 * (these are the metrics you actually want to glance at). Everything else
 * gets a 1-row mini chart in the same chip+sparkline style. All charts
 * auto-scale to the highest observed value in their visible window so the
 * shape of the series is readable regardless of absolute magnitude (e.g.
 * MCU Load might sit at 1%, RPI Load near 200% — both render correctly).
 *
 * Layout:
 *   ┌─ System ───────────────────────────────────┐
 *   │[ Klipper 62.9% ] ▆▅▆▅▇▆▅█▆▆▆▆▅▆▆█          │  ← 2-row chart
 *   │[                ] ▆▅▆▅▇▆▅█▆▆▆▆▅▆▆█          │
 *   │[ Mem 99 MB / 209 MB (47%) ] ▄▄▄▄▄▄          │  ← 2-row chart
 *   │[                          ] ▄▄▄▄▄▄          │
 *   │[ SysLd 2.16/2 ] ▂▃▃▄▄▄▃▂                    │  ← mini charts
 *   │[ MR 6.99% ] ▂▂▃▂▂▃▂▂                        │
 *   │[ MCU 1.92% ] ▁▂▁▁▂▁▂                        │
 *   │[ MCU Aw 0.12% ] ▁▁▂▁▁                       │
 *   │[ RPI 209% ] ▆▇▆▅▄▅▆▇                        │
 *   │[ RPI Aw 0.44% ] ▁▁▁▂▁                       │
 *   │ Temp 45 °C  wlan0 2.5 MB/s  Up 7h  Conns 2 │
 *   │ <throttled warning row if any>              │
 *   └────────────────────────────────────────────┘
 */

const HEADER_ROWS = 1;
const BIG_ROWS = 2; // 2-row chart
const MINI_METRICS = 6; // SysLd, MR, MCU, MCU Aw, RPI, RPI Aw
const INFO_ROWS = 2; // info line + throttled

export const SYSTEM_PANEL_HEIGHT =
  HEADER_ROWS + BIG_ROWS * 2 + MINI_METRICS + INFO_ROWS; // 13

const PANEL_MIN = 40;
const PANEL_MAX = 60;
const PANEL_GAP = 2;

export const SYSTEM_PANEL_GAP = PANEL_GAP;

export interface PanelGeometry {
  readonly width: number;
  readonly x: number;
}

export const computeSystemPanelGeometry = (
  termWidth: number,
  leftEdge: number,
): PanelGeometry | null => {
  let width = termWidth - leftEdge;
  if (width > PANEL_MAX) width = PANEL_MAX;
  if (width < PANEL_MIN) return null;
  return { width, x: termWidth - width };
};

// 0..8 levels of vertical fill within a single character row.
const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/**
 * Normalize raw values to `[0..1]` against a fixed `domainMax`. Using a fixed
 * domain (rather than auto-scaling to observed max) means bars accurately
 * reflect "how loaded is this in absolute terms" — a series sitting around
 * 5% renders as short bars, not as full-height bars. Values that exceed the
 * domain are clamped to 1.
 */
const normalize = (values: readonly number[], domainMax: number): number[] => {
  if (domainMax <= 0) return values.map(() => 0);
  return values.map((v) => Math.max(0, Math.min(1, v / domainMax)));
};

const twoRowBars = (
  rawValues: readonly number[],
  width: number,
  domainMax: number,
): { top: string; bottom: string } => {
  if (width <= 0) return { top: '', bottom: '' };
  const slice = rawValues.length >= width ? rawValues.slice(rawValues.length - width) : rawValues;
  const values = normalize(slice, domainMax);
  const pad = width - slice.length;
  const padTop = ' '.repeat(pad);
  const padBottom = ' '.repeat(pad);
  const topChars: string[] = [];
  const bottomChars: string[] = [];
  for (const v of values) {
    const total = Math.round(v * 16);
    const bottomFill = Math.min(8, total);
    const topFill = Math.max(0, total - 8);
    bottomChars.push(BLOCKS[bottomFill]!);
    topChars.push(BLOCKS[topFill]!);
  }
  return { top: padTop + topChars.join(''), bottom: padBottom + bottomChars.join('') };
};

/** Single-row sparkline using the same block elements (8 levels per column). */
const oneRowBars = (
  rawValues: readonly number[],
  width: number,
  domainMax: number,
): string => {
  if (width <= 0) return '';
  const slice = rawValues.length >= width ? rawValues.slice(rawValues.length - width) : rawValues;
  const values = normalize(slice, domainMax);
  const pad = ' '.repeat(width - slice.length);
  return (
    pad +
    values
      .map((v) => BLOCKS[Math.min(8, Math.max(0, Math.round(v * 8)))]!)
      .join('')
  );
};

const fmtMemory = (kb: number | undefined): string => {
  if (kb === undefined) return '—';
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
  return `${kb} KB`;
};

const fmtBandwidth = (bytesPerSec: number): string => {
  if (bytesPerSec >= 1_000_000) return `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1000) return `${(bytesPerSec / 1000).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
};

const fmtUptime = (sec: number | undefined): string => {
  if (sec === undefined || sec <= 0) return '—';
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

const fmtPct = (v: number | undefined, digits = 2): string =>
  v === undefined ? '—' : `${v.toFixed(digits)}%`;

const pickNetwork = (
  network: MachineProcStats['network'],
): { name: string; bandwidth: number } | null => {
  let pick: { name: string; bandwidth: number } | null = null;
  for (const [name, stat] of Object.entries(network)) {
    if (name === 'lo') continue;
    if (!pick || stat.bandwidth > pick.bandwidth) {
      pick = { name, bandwidth: stat.bandwidth };
    }
  }
  return pick;
};

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

interface SystemStatsPanelProps {
  readonly procStats: MachineProcStats;
  readonly klipper: KlipperStats;
  readonly y: number;
  readonly x: number;
  readonly width: number;
}

interface ChartBlockProps {
  readonly y: number;
  readonly x: number;
  readonly width: number;
  readonly label: string;
  readonly value: string;
  readonly samples: readonly TimedSample[];
  readonly color: string;
  /** Upper bound of the metric; values normalize as `v / domainMax`, clamped to [0,1]. */
  readonly domainMax: number;
}

const computeChip = (
  labelText: string,
  width: number,
  maxFraction: number,
): { chipW: number; chip: string } => {
  const chipMax = Math.max(6, Math.floor(width * maxFraction));
  const chipW = Math.min(labelText.length, chipMax);
  return { chipW, chip: truncate(labelText, chipW).padEnd(chipW) };
};

const ChartBlock = ({ y, x, width, label, value, samples, color, domainMax }: ChartBlockProps) => {
  const labelText = ` ${label} ${value} `;
  const { chipW, chip } = computeChip(labelText, width, 0.6);
  const chartX = x + 1 + chipW + 1;
  const chartW = Math.max(0, x + width - chartX - 1);
  const { top, bottom } = twoRowBars(samples.map((s) => s.value), chartW, domainMax);

  return (
    <>
      <Text x={x} y={y} width={width} height={1} block>
        <Text x={1} background={color} color="Black" bold>
          {chip}
        </Text>
        {chartW > 0 && (
          <Text x={1 + chipW + 1} color={color}>
            {top}
          </Text>
        )}
      </Text>
      <Text x={x} y={y + 1} width={width} height={1} block>
        <Text x={1} background={color}>
          {' '.repeat(chipW)}
        </Text>
        {chartW > 0 && (
          <Text x={1 + chipW + 1} color={color}>
            {bottom}
          </Text>
        )}
      </Text>
    </>
  );
};

interface MiniChartProps {
  readonly y: number;
  readonly x: number;
  readonly width: number;
  readonly label: string;
  readonly value: string;
  readonly samples: readonly TimedSample[];
  readonly color: string;
  /** Upper bound of the metric; values normalize as `v / domainMax`, clamped to [0,1]. */
  readonly domainMax: number;
}

/**
 * 1-row variant of `ChartBlock` — same chip + sparkline visual but compressed
 * to a single character row. Used for secondary metrics so the panel can
 * show all 8 Fluidd-style stats without becoming taller than the chart below.
 */
const MiniChart = ({ y, x, width, label, value, samples, color, domainMax }: MiniChartProps) => {
  const labelText = ` ${label} ${value} `;
  const { chipW, chip } = computeChip(labelText, width, 0.45);
  const chartW = Math.max(0, width - 2 - chipW - 1);
  const spark = oneRowBars(samples.map((s) => s.value), chartW, domainMax);
  return (
    <Text x={x} y={y} width={width} height={1} block>
      <Text x={1} background={color} color="Black" bold>
        {chip}
      </Text>
      {chartW > 0 && (
        <Text x={1 + chipW + 1} color={color}>
          {spark}
        </Text>
      )}
    </Text>
  );
};

const HeaderRow = ({ x, y, width }: { x: number; y: number; width: number }) => (
  <Text x={x} y={y} width={width} height={1} block bold underline>
    <Text x={0}>{'System'.padEnd(width)}</Text>
  </Text>
);

export const SystemStatsPanel = ({ procStats, klipper, y, x, width }: SystemStatsPanelProps) => {
  // Klipper Load chart (primary CPU consumer on a printer).
  const klipperValue = fmtPct(klipper.klipperLoad, 1);

  // Memory chart — system_memory used/total.
  let memValue = '—';
  if (procStats.memUsedKb !== undefined && procStats.memTotalKb && procStats.memTotalKb > 0) {
    const memPct = (procStats.memUsedKb / procStats.memTotalKb) * 100;
    memValue = `${fmtMemory(procStats.memUsedKb)} / ${fmtMemory(procStats.memTotalKb)} (${memPct.toFixed(0)}%)`;
  } else if (procStats.memUsedKb !== undefined) {
    memValue = fmtMemory(procStats.memUsedKb);
  }

  // Compact stat rows.
  const sysLoadValue =
    klipper.sysload !== undefined
      ? `${klipper.sysload.toFixed(2)}${klipper.cpuCores ? ` / ${klipper.cpuCores}` : ''}`
      : '—';
  const moonrakerValue = fmtPct(procStats.cpuPct, 1);
  const mcuLoad = fmtPct(klipper.mainMcu.load, 2);
  const mcuAwake = fmtPct(klipper.mainMcu.awakePct, 2);
  const rpiLoad = fmtPct(klipper.rpiMcu.load, 2);
  const rpiAwake = fmtPct(klipper.rpiMcu.awakePct, 2);

  // Info row.
  const temp = procStats.cpuTemp !== undefined ? `${procStats.cpuTemp.toFixed(1)} °C` : '—';
  const net = pickNetwork(procStats.network);
  const uptime = fmtUptime(procStats.systemUptimeSec);
  const conns =
    procStats.websocketConnections !== undefined ? String(procStats.websocketConnections) : '—';
  const infoSegments = [
    `Temp ${temp}`,
    net ? `${net.name} ${fmtBandwidth(net.bandwidth)}` : null,
    `Up ${uptime}`,
    `Conns ${conns}`,
  ].filter((s): s is string => s !== null);
  const infoLine = infoSegments.join('  ');

  const throttled = procStats.throttledFlags.length > 0;

  const klipperY = y + HEADER_ROWS;
  const memY = klipperY + BIG_ROWS;
  const miniY = memY + BIG_ROWS;
  const infoY = miniY + MINI_METRICS;
  const throttledY = infoY + 1;

  return (
    <>
      <HeaderRow x={x} y={y} width={width} />
      <ChartBlock
        x={x}
        y={klipperY}
        width={width}
        label="Klipper"
        value={klipperValue}
        samples={klipper.klipperLoadSamples}
        color="Cyan"
        domainMax={100}
      />
      <ChartBlock
        x={x}
        y={memY}
        width={width}
        label="Mem"
        value={memValue}
        samples={procStats.memSamples}
        color="Magenta"
        domainMax={100}
      />
      <MiniChart
        x={x}
        y={miniY}
        width={width}
        label="SysLd"
        value={sysLoadValue}
        samples={klipper.sysloadSamples}
        color="Yellow"
        domainMax={Math.max(2, (klipper.cpuCores ?? 2) * 2)}
      />
      <MiniChart
        x={x}
        y={miniY + 1}
        width={width}
        label="MR"
        value={moonrakerValue}
        samples={procStats.cpuSamples}
        color="Blue"
        domainMax={100}
      />
      <MiniChart
        x={x}
        y={miniY + 2}
        width={width}
        label="MCU"
        value={mcuLoad}
        samples={klipper.mainMcu.loadSamples}
        color="Green"
        domainMax={50}
      />
      <MiniChart
        x={x}
        y={miniY + 3}
        width={width}
        label="MCU Aw"
        value={mcuAwake}
        samples={klipper.mainMcu.awakeSamples}
        color="Green"
        domainMax={100}
      />
      <MiniChart
        x={x}
        y={miniY + 4}
        width={width}
        label="RPI"
        value={rpiLoad}
        samples={klipper.rpiMcu.loadSamples}
        color="BrightMagenta"
        domainMax={1000}
      />
      <MiniChart
        x={x}
        y={miniY + 5}
        width={width}
        label="RPI Aw"
        value={rpiAwake}
        samples={klipper.rpiMcu.awakeSamples}
        color="BrightMagenta"
        domainMax={100}
      />
      <Text x={x} y={infoY} width={width} height={1} block>
        <Text x={1} color="White">
          {truncate(infoLine, Math.max(1, width - 2))}
        </Text>
      </Text>
      {throttled ? (
        <Text x={x} y={throttledY} width={width} height={1} block>
          <Text x={1} color="Red" bold>
            {truncate(`⚠ throttled: ${procStats.throttledFlags.join(', ')}`, width - 2)}
          </Text>
        </Text>
      ) : (
        <Text x={x} y={throttledY} width={width} height={1} block>
          <Text x={0} color="BrightBlack" dim>
            {' '.padEnd(width)}
          </Text>
        </Text>
      )}
    </>
  );
};
