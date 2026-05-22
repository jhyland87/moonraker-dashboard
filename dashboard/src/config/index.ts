import type { ClientConfig } from '@jhyland87/moonraker-client';
import type { SensorConfig } from '../types/index';

/**
 * Identifier for a panel that can appear in the dashboard's top header row.
 * - `sensor-table`  — temperature/sensor table on the left
 * - `print-status`  — print job metadata
 * - `system-stats`  — system utilization (CPU/Mem/MCU)
 * @source
 */
export type HeaderSlotKind = 'sensor-table' | 'print-status' | 'system-stats';

/**
 * A dimensional value: a fixed number of character cells, a percentage of
 * the available row (e.g. `"40%"`), or `"auto"` to fall back to the
 * panel's intrinsic preferred size.
 * @source
 */
export type Dimension = number | `${number}%` | 'auto';

/**
 * Verbose form of a dimension that adds optional `min` / `max` clamps.
 * Either field may be omitted; both are interpreted in *cells*.
 *
 * If even `min` doesn't fit on screen, the panel is dropped from the
 * layout entirely.
 * @source
 */
export interface DimensionSpec {
  /** Target value. Defaults to the panel's intrinsic preferred size. */
  readonly value?: Dimension;
  /** Hard minimum width/height in character cells. */
  readonly min?: number;
  /** Hard maximum width/height in character cells. */
  readonly max?: number;
}

/**
 * Configuration entry for a single panel in the header row.
 *
 * Width may be a single {@link Dimension} (shorthand, no clamps) or a
 * {@link DimensionSpec} for fine-grained control. Height is reserved for
 * a future iteration — header panels currently render at their intrinsic
 * height regardless of this value.
 * @source
 */
export interface HeaderPanelLayoutEntry {
  readonly component: HeaderSlotKind;
  readonly width?: Dimension | DimensionSpec;
  /**
   * Currently advisory only. Header panels render at their intrinsic
   * height (defined inside each component). Reserved for forward
   * compatibility so configs written today survive future expansion.
   */
  readonly height?: Dimension | DimensionSpec;
}

/**
 * Static UI-layout configuration. Currently controls the header row;
 * future versions may add slots for the main (chart) and bottom areas.
 * @source
 */
export interface LayoutConfig {
  /**
   * Header components in left-to-right rendering order. Components not
   * listed are not rendered. Duplicate components collapse to their
   * first occurrence.
   *
   * Each entry can override width with a fixed cell count, a percentage
   * of the row, or `"auto"` (use the panel's preferred width). `min` and
   * `max` clamps can be applied on top of any of those.
   *
   * @example
   * ```ts
   * header: [
   *   { component: 'sensor-table' },                              // auto (57 cells)
   *   { component: 'print-status', width: { value: '40%', min: 40, max: 80 } },
   *   { component: 'system-stats', width: 36 },                   // fixed
   * ]
   * ```
   */
  readonly header: readonly HeaderPanelLayoutEntry[];
}

/**
 * Startup / connection-bring-up knobs.
 *
 * Klipper printers in sleep mode can take a while to wake — the socket
 * either refuses or hangs during that window. {@link useReconnectingClient}
 * keeps reattempting the websocket open every `retryIntervalMs` while the
 * loading dialog is up; if the total wait exceeds
 * `connectionTimeoutMs` the dialog flips to a "still trying" state without
 * actually giving up.
 * @source
 */
export interface StartupConfig {
  /**
   * How long (ms) to wait for the initial connection before the loading
   * dialog switches into a "still trying" message. Retries continue in
   * the background — this is a UI threshold, not a hard give-up.
   */
  readonly connectionTimeoutMs: number;
  /** Time (ms) between websocket retry attempts during initial bring-up. */
  readonly retryIntervalMs: number;
}

/**
 * Renderer choice for the temperature chart's plot area.
 *
 * - `'palette'` — original box-drawing characters (`╭`, `╮`, `╰`, `╯`,
 *   `─`, `│`). One mark per terminal cell.
 * - `'braille'` — Unicode braille glyphs (U+2800–U+28FF). Each terminal
 *   cell encodes a 2×4 dot grid, giving 2× horizontal and 4× vertical
 *   resolution. Steep slopes draw as smooth lines instead of stair-steps.
 * @source
 */
export type ChartRenderer = 'palette' | 'braille';

/**
 * Temperature-chart configuration knobs.
 * @source
 */
export interface ChartsConfig {
  /** Which character set to use when plotting the temperature graph. */
  readonly renderer: ChartRenderer;
}

/**
 * Console-panel configuration knobs.
 * @source
 */
export interface ConsoleConfig {
  /**
   * When `true`, mouse-wheel scrolling follows the system's "natural"
   * convention (wheel up → older entries / scroll back into history). When
   * `false`, the direction is reversed (wheel up → newer entries / scroll
   * toward the live tail), which matches most CLI tools' scrollback behavior.
   */
  readonly naturalScroll: boolean;
  /**
   * Initial state for the in-console debug logger. Can also be toggled at
   * runtime by pressing `d` in the console's view mode. When on, lifecycle
   * events (ws open/close/error) are interleaved into the feed as dim
   * `[D]`-prefixed lines.
   */
  readonly debug: boolean;
}

/**
 * Top-level dashboard configuration object passed to {@link App}.
 * @source
 */
export interface DashboardConfig {
  readonly client: ClientConfig;
  readonly sensors: readonly SensorConfig[];
  /** Maximum number of samples to retain per sensor. */
  readonly historyLength: number;
  /** Sampling cadence in milliseconds (driven client-side off pushed updates). */
  readonly sampleIntervalMs: number;
  readonly console: ConsoleConfig;
  readonly layout: LayoutConfig;
  readonly startup: StartupConfig;
  readonly charts: ChartsConfig;
}

const envServer = process.env.MOONRAKER_HOST ?? '192.168.0.96';
const envPort = process.env.MOONRAKER_PORT ? Number(process.env.MOONRAKER_PORT) : 7125;

/**
 * Sensor definitions mirroring `moonraker-cli`'s `status.graph` table.
 * Colors are the literal RGB values from that script.
 */
const sensors: readonly SensorConfig[] = [
  {
    objectName: 'extruder',
    label: 'Extruder',
    color: '#ff5252',
    dimColor: '#802929',
    hasTarget: true,
    powerField: 'powers',
    toggleKey: 'e',
  },
  {
    objectName: 'heater_bed',
    label: 'Heater Bed',
    color: '#20b0ff',
    dimColor: '#105880',
    hasTarget: true,
    powerField: 'powers',
    toggleKey: 'b',
  },
  {
    objectName: 'temperature_fan chamber_fan',
    label: 'Chamber Fan',
    color: '#3cc25a',
    dimColor: '#1e612d',
    hasTarget: true,
    powerField: 'speeds',
    toggleKey: 'f',
  },
  {
    objectName: 'temperature_sensor chamber_temp',
    label: 'Chamber Temp',
    color: '#830ee3',
    dimColor: '#410771',
    hasTarget: false,
    powerField: 'none',
    toggleKey: 't',
  },
  {
    objectName: 'temperature_sensor mcu_temp',
    label: 'MCU Temp',
    color: '#d67600',
    dimColor: '#6b3b00',
    hasTarget: false,
    powerField: 'none',
    toggleKey: 'm',
  },
];

// `satisfies` (TS 4.9+) checks that the literal conforms to
// `DashboardConfig` while preserving the narrow inferred types of its
// fields — so e.g. `config.layout.header` keeps its tuple length and
// `config.console.naturalScroll` stays a literal `false` rather than
// widening to `boolean`. Useful for callers that read this constant.
export const config = {
  client: {
    API: {
      connection: {
        server: envServer,
        port: envPort,
        path: '/websocket',
        timeout: 1000,
      },
    },
  },
  sensors,
  historyLength: 500,
  sampleIntervalMs: 1000,
  console: {
    naturalScroll: false,
    debug: false,
  },
  layout: {
    header: [
      { component: 'sensor-table' },
      { component: 'print-status' },
      { component: 'system-stats' },
    ],
  },
  startup: {
    connectionTimeoutMs: 30_000,
    retryIntervalMs: 2_000,
  },
  charts: {
    renderer: 'braille',
  },
} as const satisfies DashboardConfig;
