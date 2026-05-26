/**
 * @fileoverview Canonical default {@link DashboardConfig}.
 *
 * Lives in its own module so it can be referenced from three places
 * without circular imports: the runtime loader (`configFile.ts`), the
 * "restore defaults" action in the editor modal, and the public
 * re-export in `index.ts`.
 *
 * Environment variables (`MOONRAKER_HOST`, `MOONRAKER_PORT`, `WEBCAM_HOST`,
 * `WEBCAM_PORT`) are read at first load so the default written to YAML on
 * a fresh install reflects whatever the user's environment is set up for
 * — not a hard-coded printer address that won't match their network.
 * After the first write the YAML wins; env vars no longer affect runtime.
 */

import type { ClientConfig } from '@jhyland87/moonraker-client';
import type { SensorConfig } from '../types/index';

/**
 * Identifier for a panel that can appear in the dashboard's top header row.
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
 * @source
 */
export interface DimensionSpec {
  readonly value?: Dimension;
  readonly min?: number;
  readonly max?: number;
}

/**
 * Configuration entry for a single panel in the header row.
 * @source
 */
export interface HeaderPanelLayoutEntry {
  readonly component: HeaderSlotKind;
  readonly width?: Dimension | DimensionSpec;
  readonly height?: Dimension | DimensionSpec;
}

/**
 * Two-column layout configuration.
 * @source
 */
export interface LayoutConfig {
  /** Fractional horizontal split between left and right columns (0..1). */
  readonly columnSplit: number;
  /** @deprecated header-row layout has been replaced by the two-column layout. */
  readonly header?: readonly HeaderPanelLayoutEntry[];
}

/**
 * Startup / connection-bring-up knobs.
 * @source
 */
export interface StartupConfig {
  readonly connectionTimeoutMs: number;
  readonly retryIntervalMs: number;
}

/**
 * Renderer choice for the temperature chart's plot area.
 * @source
 */
export type ChartRenderer = 'palette' | 'braille';

/**
 * Temperature-chart configuration knobs.
 * @source
 */
export interface ChartsConfig {
  readonly renderer: ChartRenderer;
}

/**
 * Console-panel configuration knobs.
 * @source
 */
export interface ConsoleConfig {
  readonly naturalScroll: boolean;
  readonly debug: boolean;
}

/**
 * Webcam panel configuration knobs.
 * @source
 */
export interface WebcamConfig {
  readonly host: string;
  readonly port: number;
  readonly secure?: boolean;
  readonly snapshotPath: string;
  readonly streamPath: string;
  readonly streamMaxFps: number;
}

/**
 * File browser configuration knobs.
 * @source
 */
export interface FileBrowserConfig {
  readonly root: string;
  readonly extensions: readonly string[];
  readonly visibleColumns: readonly string[];
  readonly downloadDir: string;
  readonly showThumbnails: boolean;
  readonly thumbnailCellW: number;
  readonly thumbnailCellH: number;
}

/**
 * Top-level dashboard configuration object passed to {@link App}.
 * @source
 */
export interface DashboardConfig {
  readonly client: ClientConfig;
  readonly sensors: readonly SensorConfig[];
  readonly historyLength: number;
  readonly sampleIntervalMs: number;
  readonly console: ConsoleConfig;
  readonly layout: LayoutConfig;
  readonly startup: StartupConfig;
  readonly charts: ChartsConfig;
  readonly webcam: WebcamConfig;
  readonly fileBrowser: FileBrowserConfig;
}

const envServer = process.env['MOONRAKER_HOST'] ?? '192.168.0.96';
const envPort = process.env['MOONRAKER_PORT']
  ? Number(process.env['MOONRAKER_PORT'])
  : 7125;
const envWebcamHost = process.env['WEBCAM_HOST'] ?? envServer;
const envWebcamPort = process.env['WEBCAM_PORT']
  ? Number(process.env['WEBCAM_PORT'])
  : 8080;

/**
 * Sensor definitions mirroring `moonraker-cli`'s `status.graph` table.
 * Colors are the literal RGB values from that script.
 * @source
 */
export const DEFAULT_SENSORS: readonly SensorConfig[] = [
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

/**
 * Build the canonical {@link DashboardConfig} default — reads env vars
 * for connection fields each call so test harnesses can stub them.
 *
 * @returns A fresh default config. Callers may keep a long-lived
 *   reference; the object's fields are typed `readonly`.
 *
 * @source
 */
export const buildDefaultConfig = (): DashboardConfig => ({
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
  sensors: DEFAULT_SENSORS,
  historyLength: 500,
  sampleIntervalMs: 1000,
  console: {
    naturalScroll: false,
    debug: false,
  },
  layout: {
    columnSplit: 0.5,
  },
  startup: {
    connectionTimeoutMs: 30_000,
    retryIntervalMs: 2_000,
  },
  charts: {
    renderer: 'braille',
  },
  webcam: {
    host: envWebcamHost,
    port: envWebcamPort,
    snapshotPath: '/?action=snapshot',
    streamPath: '/?action=stream',
    streamMaxFps: 15,
  },
  fileBrowser: {
    root: 'gcodes',
    extensions: ['.gcode'],
    visibleColumns: ['name', 'size', 'modified', 'printed', 'layers', 'duration', 'filament_g'],
    downloadDir: process.env['HOME']
      ? `${process.env['HOME']}/Downloads/moonraker-dashboard`
      : './downloads',
    showThumbnails: false,
    thumbnailCellW: 4,
    thumbnailCellH: 2,
  },
});

/**
 * Pre-built default — convenient for callers that don't need a fresh
 * reference. Equivalent to calling {@link buildDefaultConfig} once at
 * module load. The fields aren't mutated by anyone (everything is
 * `readonly`), so sharing the reference is safe.
 *
 * @source
 */
export const DEFAULT_CONFIG: DashboardConfig = buildDefaultConfig();
