import { Text } from 'react-curse';

import { PanelFrame } from './PanelFrame';
import type { SensorConfig, SensorState } from '../types/index';

/**
 * Column layout (visible widths, mirroring `printf "%-14s  %6s  %11s  %9s  %7s"`
 * from the bash status.graph). Right-aligned where noted.
 */
const NAME_X = 2;
const NAME_W = 14;
const POWER_W = 6;
const CHANGE_W = 11;
const ACTUAL_W = 9;
const TARGET_W = 7;
const COL_GAP = 2;

const POWER_END = NAME_X + NAME_W + COL_GAP + POWER_W;
const CHANGE_END = POWER_END + COL_GAP + CHANGE_W;
const ACTUAL_END = CHANGE_END + COL_GAP + ACTUAL_W;
const TARGET_END = ACTUAL_END + COL_GAP + TARGET_W;

/** Total visible width of one row (matches bash's `table_max_visible = 57`). */
export const SENSOR_TABLE_WIDTH = TARGET_END + 2; // +2 for left/right border
export const SENSOR_TABLE_HEADER_ROWS = 1;
/** Border rows the frame adds (top + bottom). */
export const SENSOR_TABLE_BORDER_ROWS = 2;

interface SensorTableProps {
  readonly configs: readonly SensorConfig[];
  readonly sensors: Readonly<Record<string, SensorState>>;
  /** Toggle keys (case-sensitive, as declared in config) currently hidden. */
  readonly hidden: ReadonlySet<string>;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

const formatPower = (state: SensorState): string => {
  if (state.power === undefined || state.config.powerField === 'none') return '';
  return `${Math.round(state.power * 100)}%`;
};

const formatChange = (state: SensorState): string => {
  if (state.changeRate === undefined) return '';
  return `${state.changeRate >= 0 ? '+' : ''}${state.changeRate.toFixed(1)} °C/s`;
};

const formatActual = (state: SensorState): string => {
  if (state.samples.length === 0) return '';
  return `${state.current.toFixed(1)} °C`;
};

const formatTarget = (state: SensorState): string => {
  if (!state.config.hasTarget || state.target <= 0) return '';
  return `${state.target.toFixed(0)} °C`;
};

interface NamePartsProps {
  readonly label: string;
  readonly hotkey: string;
  readonly color?: string;
}

/** Render the sensor name with the toggle-key letter underlined. */
const NameCell = ({ label, hotkey, color }: NamePartsProps) => {
  const upper = hotkey.toUpperCase();
  const idx = label.indexOf(upper);
  if (idx < 0) {
    return (
      <Text x={NAME_X} color={color}>
        {label}
      </Text>
    );
  }
  return (
    <>
      {idx > 0 && (
        <Text x={NAME_X} color={color}>
          {label.slice(0, idx)}
        </Text>
      )}
      <Text x={NAME_X + idx} color={color} underline>
        {label[idx]}
      </Text>
      <Text x={NAME_X + idx + 1} color={color}>
        {label.slice(idx + 1)}
      </Text>
    </>
  );
};

interface RowProps {
  readonly state: SensorState;
  readonly hidden: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

const SensorRow = ({ state, hidden, x, y, width }: RowProps) => {
  const power = formatPower(state).padStart(POWER_W);
  const change = formatChange(state).padStart(CHANGE_W);
  const actual = formatActual(state).padStart(ACTUAL_W);
  const target = formatTarget(state).padStart(TARGET_W);
  // When hidden, drop the sensor's color so the whole row reads as inactive.
  // The underline on the hotkey letter is preserved so users can still tell
  // which key brings it back.
  const nameColor = hidden ? undefined : state.config.color;
  const valueColor = hidden ? undefined : 'White';
  return (
    <Text x={x} y={y} width={width} height={1} block dim={hidden}>
      <NameCell label={state.config.label} hotkey={state.config.toggleKey} color={nameColor} />
      <Text x={POWER_END - POWER_W} color={valueColor}>{power}</Text>
      <Text x={CHANGE_END - CHANGE_W} color={valueColor}>{change}</Text>
      <Text x={ACTUAL_END - ACTUAL_W} color={valueColor}>{actual}</Text>
      <Text x={TARGET_END - TARGET_W} color={valueColor}>{target}</Text>
    </Text>
  );
};

const HeaderRow = ({ x, y, width }: { readonly x: number; readonly y: number; readonly width: number }) => (
  <Text x={x} y={y} width={width} height={1} block bold underline>
    <Text x={NAME_X}>Name</Text>
    <Text x={POWER_END - POWER_W}>{'Power'.padStart(POWER_W)}</Text>
    <Text x={CHANGE_END - CHANGE_W}>{'Change'.padStart(CHANGE_W)}</Text>
    <Text x={ACTUAL_END - ACTUAL_W}>{'Actual'.padStart(ACTUAL_W)}</Text>
    <Text x={TARGET_END - TARGET_W}>{'Target'.padStart(TARGET_W)}</Text>
  </Text>
);

export const sensorTableHeight = (configs: readonly SensorConfig[]): number =>
  SENSOR_TABLE_HEADER_ROWS + configs.length + SENSOR_TABLE_BORDER_ROWS;

export const SensorTable = ({ configs, sensors, hidden, x, y, width }: SensorTableProps) => {
  const totalH = sensorTableHeight(configs);
  return (
    <>
      <HeaderRow x={x} y={y + 1} width={width} />
      {configs.map((cfg, idx) => {
        const state =
          sensors[cfg.objectName] ??
          ({ config: cfg, current: 0, target: 0, samples: [] } satisfies SensorState);
        return (
          <SensorRow
            key={cfg.objectName}
            state={state}
            hidden={hidden.has(cfg.toggleKey)}
            x={x}
            y={y + 1 + SENSOR_TABLE_HEADER_ROWS + idx}
            width={width}
          />
        );
      })}
      {/* Border rendered LAST so its side bars overwrite the space-fill from
          the block-style content rows above. */}
      <PanelFrame x={x} y={y} width={width} height={totalH} title="Sensors" />
    </>
  );
};
