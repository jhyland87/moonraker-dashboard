import { Text } from 'react-curse';

import { PanelFrame } from './PanelFrame';
import type { KlipperStats } from '../hooks/useKlipperStats';
import type { MachineProcStats, TimedSample } from '../hooks/useMachineProcStats';
import {
  fmtBandwidth,
  fmtMemory,
  fmtPercent as fmtPct,
  fmtUptime,
  truncate,
} from '../services/format';

/**
 * Compact system-resource panel. Renders as a 5-row strip across the
 * bottom of the dashboard:
 *
 * ```
 * ┌─ System ─────────────────────────────────── ⚠ throttled: <flags> ─┐
 * │[Klipper 5.8%]▆▅▆█  [SysLd 2.5]▂▃▄  [MCU 2.00%]▁▂  [RPI 3.6%]▆▇▆▅   │
 * │[Mem 99/209MB]▄▄▄▄  [MR 27.4%]▂▂▃   [MCU Aw 0.3%]▁ [RPI Aw 0.0%]▁    │
 * │ Temp 45 °C        wlan0 2.3 MB/s    Up 3d 3h       Conns 20       │
 * └────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * Eight metric chips arranged in a 2×4 grid, plus a 4-column info row.
 * The throttled warning surfaces in the top border's right slot only when
 * the machine actually reports throttling — costs no rows in the steady
 * state. Total height is fixed at {@link SYSTEM_PANEL_HEIGHT}.
 */

const HEADER_ROWS = 1; // top border row
const CHART_ROWS = 2; // two rows of 4 mini chips each
const INFO_ROWS = 1; // one info row split into 4 cells
const FOOTER_ROWS = 1; // bottom border row

/**
 * Fixed row count for the bottom system-stats strip. App layout reserves
 * exactly this many rows below the columns.
 * @source
 */
export const SYSTEM_PANEL_HEIGHT = HEADER_ROWS + CHART_ROWS + INFO_ROWS + FOOTER_ROWS;

// 0..8 levels of vertical fill within a single character row.
const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/**
 * Pick a block character by fill level `0..8`. Out-of-range levels
 * clamp into the same range; missing index defaults to a space.
 */
const blockChar = (level: number): string => {
  const clamped = Math.min(BLOCKS.length - 1, Math.max(0, level));
  return BLOCKS[clamped] ?? ' ';
};

/**
 * Normalize raw values to `[0..1]` against a fixed `domainMax`. Values
 * beyond the domain clamp to 1 — so a CPU sitting around 5% renders as
 * short bars, not full-height bars, even if the series briefly spikes.
 */
const normalize = (values: readonly number[], domainMax: number): number[] => {
  if (domainMax <= 0) return values.map(() => 0);
  return values.map((v) => Math.max(0, Math.min(1, v / domainMax)));
};

/**
 * Single-row sparkline using 8-level block elements (one cell per sample).
 * Pads the left side with spaces when there are fewer samples than width
 * so new lines grow rightward into view.
 */
const oneRowBars = (
  rawValues: readonly number[],
  width: number,
  domainMax: number,
): string => {
  if (width <= 0) return '';
  const slice = rawValues.length >= width ? rawValues.slice(rawValues.length - width) : rawValues;
  const values = normalize(slice, domainMax);
  const pad = ' '.repeat(width - slice.length);
  return pad + values.map((v) => blockChar(Math.round(v * 8))).join('');
};

/**
 * Pick the network interface most likely to be "the" main connection — the
 * non-loopback interface with the highest current bandwidth. When everything
 * is quiet, the highest cumulative rx/tx interface still wins.
 */
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

interface SystemStatsPanelProps {
  readonly procStats: MachineProcStats;
  readonly klipper: KlipperStats;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

interface MiniChipProps {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly label: string;
  readonly value: string;
  readonly samples: readonly TimedSample[];
  readonly color: string;
  readonly domainMax: number;
}

/**
 * One cell of the 2×4 grid — a colored chip with `LABEL VALUE` plus a
 * sparkline that fills the rest of the cell. The chip occupies up to half
 * of the cell width so the bars stay readable even on narrow columns.
 */
const MiniChip = ({ x, y, width, label, value, samples, color, domainMax }: MiniChipProps) => {
  const labelText = ` ${label} ${value} `;
  const chipMax = Math.max(6, Math.floor(width * 0.55));
  const chipW = Math.min(labelText.length, chipMax);
  const chip = truncate(labelText, chipW).padEnd(chipW);
  const chartW = Math.max(0, width - chipW - 1);
  const spark = oneRowBars(samples.map((s) => s.value), chartW, domainMax);
  return (
    <Text x={x} y={y} width={width} height={1} block>
      <Text x={0} background={color} color="Black" bold>
        {chip}
      </Text>
      {chartW > 0 && (
        <Text x={chipW + 1} color={color}>
          {spark}
        </Text>
      )}
    </Text>
  );
};

/**
 * Single info-row column — plain colored label, no chart. Used for the
 * non-time-series metrics that don't have a meaningful sparkline (temp,
 * network bandwidth, uptime, websocket connection count).
 */
const InfoCell = ({
  x,
  y,
  width,
  text,
}: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly text: string;
}) => (
  <Text x={x} y={y} width={width} height={1} block>
    <Text x={0} color="White">
      {truncate(text, Math.max(1, width - 1))}
    </Text>
  </Text>
);

/**
 * Render the system-stats strip. Always rendered at fixed height
 * {@link SYSTEM_PANEL_HEIGHT}; aligns content into a 4-column grid so the
 * panel stays low-profile regardless of terminal width.
 *
 * @param props - See {@link SystemStatsPanelProps}.
 * @returns The panel element.
 *
 * @source
 */
export const SystemStatsPanel = ({
  procStats,
  klipper,
  x,
  y,
  width,
}: SystemStatsPanelProps) => {
  const innerX = x + 1;
  const innerY = y + 1;
  const innerW = Math.max(1, width - 2);

  // 4 equal columns. The gap (1 char) is built into MiniChip's `width`
  // claim — each chip writes a block of `colW - 1` chars, leaving one
  // breathing-room space between neighbors.
  const colW = Math.max(8, Math.floor(innerW / 4));
  const colX = (i: number): number => innerX + i * colW;

  // ----- Values ---------------------------------------------------------
  const klipperValue = fmtPct(klipper.klipperLoad, 1);

  // Memory: shortened from "99 MB / 209 MB (47%)" to "99/209MB 47%" so it
  // fits a single column. mfmtMemory("99 MB") → "99 MB"; strip the spaces
  // and unit on the first half.
  let memValue = '—';
  if (procStats.memUsedKb !== undefined && procStats.memTotalKb && procStats.memTotalKb > 0) {
    const memPct = (procStats.memUsedKb / procStats.memTotalKb) * 100;
    const used = fmtMemory(procStats.memUsedKb).replace(/\s+/g, '');
    const total = fmtMemory(procStats.memTotalKb).replace(/\s+/g, '');
    memValue = `${used}/${total} ${memPct.toFixed(0)}%`;
  } else if (procStats.memUsedKb !== undefined) {
    memValue = fmtMemory(procStats.memUsedKb);
  }

  const sysLoadValue =
    klipper.sysload !== undefined
      ? `${klipper.sysload.toFixed(2)}${klipper.cpuCores ? `/${klipper.cpuCores}` : ''}`
      : '—';
  const moonrakerValue = fmtPct(procStats.cpuPct, 1);
  const mcuLoad = fmtPct(klipper.mainMcu.load, 2);
  const mcuAwake = fmtPct(klipper.mainMcu.awakePct, 2);
  const rpiLoad = fmtPct(klipper.rpiMcu.load, 2);
  const rpiAwake = fmtPct(klipper.rpiMcu.awakePct, 2);

  // Info row.
  const temp = procStats.cpuTemp !== undefined ? `${procStats.cpuTemp.toFixed(1)}°C` : '—';
  const net = pickNetwork(procStats.network);
  const uptime = fmtUptime(procStats.systemUptimeSec);
  const conns =
    procStats.websocketConnections !== undefined ? String(procStats.websocketConnections) : '—';

  const throttled = procStats.throttledFlags.length > 0;
  const throttledLabel = throttled
    ? `⚠ throttled: ${procStats.throttledFlags.join(', ')}`
    : undefined;

  // ----- Render ---------------------------------------------------------
  // Chart row 1 (top): Klipper / SysLd / MCU / RPI
  // Chart row 2:        Mem / MR / MCU Aw / RPI Aw
  // Info row:           Temp / Network / Uptime / Conns
  const chartW = colW - 1; // 1 char gap before the next column

  return (
    <>
      <MiniChip
        x={colX(0)} y={innerY} width={chartW}
        label="Klipper" value={klipperValue}
        samples={klipper.klipperLoadSamples} color="Cyan" domainMax={100}
      />
      <MiniChip
        x={colX(1)} y={innerY} width={chartW}
        label="SysLd" value={sysLoadValue}
        samples={klipper.sysloadSamples} color="Yellow"
        domainMax={Math.max(2, (klipper.cpuCores ?? 2) * 2)}
      />
      <MiniChip
        x={colX(2)} y={innerY} width={chartW}
        label="MCU" value={mcuLoad}
        samples={klipper.mainMcu.loadSamples} color="Green" domainMax={50}
      />
      <MiniChip
        x={colX(3)} y={innerY} width={chartW}
        label="RPI" value={rpiLoad}
        samples={klipper.rpiMcu.loadSamples} color="BrightMagenta" domainMax={1000}
      />

      <MiniChip
        x={colX(0)} y={innerY + 1} width={chartW}
        label="Mem" value={memValue}
        samples={procStats.memSamples} color="Magenta" domainMax={100}
      />
      <MiniChip
        x={colX(1)} y={innerY + 1} width={chartW}
        label="MR" value={moonrakerValue}
        samples={procStats.cpuSamples} color="Blue" domainMax={100}
      />
      <MiniChip
        x={colX(2)} y={innerY + 1} width={chartW}
        label="MCU Aw" value={mcuAwake}
        samples={klipper.mainMcu.awakeSamples} color="Green" domainMax={100}
      />
      <MiniChip
        x={colX(3)} y={innerY + 1} width={chartW}
        label="RPI Aw" value={rpiAwake}
        samples={klipper.rpiMcu.awakeSamples} color="BrightMagenta" domainMax={100}
      />

      <InfoCell x={colX(0)} y={innerY + 2} width={chartW} text={`Temp ${temp}`} />
      <InfoCell
        x={colX(1)} y={innerY + 2} width={chartW}
        text={net ? `${net.name} ${fmtBandwidth(net.bandwidth)}` : '—'}
      />
      <InfoCell x={colX(2)} y={innerY + 2} width={chartW} text={`Up ${uptime}`} />
      <InfoCell x={colX(3)} y={innerY + 2} width={chartW} text={`Conns ${conns}`} />

      {/* Border drawn last so the side bars overwrite block-fill edges. */}
      <PanelFrame
        x={x}
        y={y}
        width={width}
        height={SYSTEM_PANEL_HEIGHT}
        title="System"
        rightLabel={throttledLabel}
        rightLabelColor="Red"
      />
    </>
  );
};
