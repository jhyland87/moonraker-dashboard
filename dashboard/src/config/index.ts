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
 * Static UI-layout configuration. The dashboard renders as two stacked
 * columns (Fluidd-style):
 *
 * - **Left column**: Print Status (fixed) → Sensors (fixed) → Temperature
 *   chart (flexible) → Bed Mesh (flexible, when toggled visible with `h`).
 * - **Right column**: Webcam (flexible, when toggled visible with `w`) →
 *   Console (flexible, when toggled visible with `c`).
 *
 * Visible flexible panels in each column share remaining vertical space —
 * toggling something off naturally rescales the neighbors.
 *
 * @source
 */
export interface LayoutConfig {
  /**
   * Fractional horizontal split between the left and right columns
   * (`0..1`). `0.5` gives a 50/50 split; `0.6` makes the left column 60%
   * wide. Both columns floor at 20 cells to keep panels readable.
   */
  readonly columnSplit: number;
  /**
   * Header layout from the previous header-row design. Kept on the type
   * for forward-compat with older configs — the new two-column layout
   * ignores it. Will be removed once any external consumers migrate.
   *
   * @deprecated The header-row layout has been replaced by the two-column
   *   layout. Setting this has no effect.
   */
  readonly header?: readonly HeaderPanelLayoutEntry[];
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
 * Webcam panel configuration knobs.
 *
 * The webcam server (mjpg-streamer / ustreamer / Crowsnest) runs on a
 * separate port from Moonraker — typically `8080`, distinct from
 * Moonraker's `7125`. Host/port/path are split here so each piece can be
 * overridden independently (via env vars or programmatic config) without
 * forcing the user to assemble the full URL by hand.
 *
 * @source
 */
export interface WebcamConfig {
  /** Hostname or IP serving the webcam stream. Usually the printer host. */
  readonly host: string;
  /** Port the webcam HTTP server listens on (8080 for mjpg-streamer default). */
  readonly port: number;
  /**
   * Use TLS when fetching from the webcam server. `true` → `https://`,
   * `false` (default) → `http://`. Independent of the Moonraker
   * connection's `secure` flag — many printers terminate TLS at a reverse
   * proxy that fronts only some of the services. Set explicitly when
   * your webcam server is behind HTTPS.
   */
  readonly secure?: boolean;
  /**
   * Path component of the snapshot URL — used by the manual `s` hotkey
   * and by the print-status thumbnail's one-shot fetches. mjpg-streamer
   * / ustreamer both expose snapshots at `/?action=snapshot`; some
   * setups use `/snapshot`.
   */
  readonly snapshotPath: string;
  /**
   * Path component of the live-stream URL — a `multipart/x-mixed-replace`
   * MJPEG endpoint. mjpg-streamer / ustreamer expose this at
   * `/?action=stream`. Consumed by the webcam panel during active prints
   * (or when the user manually starts the stream).
   */
  readonly streamPath: string;
  /**
   * Maximum frame rate to forward into React state, in frames per second.
   * The MJPEG server may emit frames faster than this (often 15–30 FPS);
   * frames arriving more often than `1000/streamMaxFps` ms are dropped.
   * Keeps React render pressure bounded — every emitted frame triggers
   * a full dashboard re-render plus an iTerm2 inline-image escape write.
   *
   * Reasonable values: 10–20 FPS for smooth video, 2–5 for a low-impact
   * status view.
   */
  readonly streamMaxFps: number;
}

/**
 * File browser configuration knobs. Controls the modal triggered by the
 * `o` hotkey (or whichever key the central hotkeys registry maps).
 *
 * @source
 */
export interface FileBrowserConfig {
  /**
   * Moonraker file root to list. Defaults to `'gcodes'` (the print-file
   * root). Other useful roots: `'config'`, `'logs'`, `'timelapse'`.
   */
  readonly root: string;
  /**
   * File extensions to show. Empty array shows everything in the root.
   * Defaults to `['.gcode']` so the dashboard's print-job browser only
   * surfaces printable files.
   */
  readonly extensions: readonly string[];
  /**
   * Column ids to render, in left-to-right order. Each id must exist in
   * `services/fileBrowser.ts`'s `COLUMN_CATALOG`. Add more / reorder to
   * taste — wider sets enable the modal's horizontal scrolling.
   */
  readonly visibleColumns: readonly string[];
  /**
   * Absolute path on disk where downloaded files land. The browser
   * preserves the printer-side subdirectory layout under this root.
   */
  readonly downloadDir: string;
  /**
   * Render the gcode's slicer thumbnail inline next to each row, the way
   * Fluidd and Mainsail do. Only takes effect when the host terminal
   * supports iTerm2 inline images (other terminals silently ignore it).
   *
   * Costs a network fetch per visible file the first time it scrolls
   * into view, plus an extra base64-encode + stdout write per row on
   * every dashboard render. Thumbnails are PNGs (~1–6 KB each at the
   * 100×100 size) and are cached in-process so the cost is one-time.
   * Defaults to `false` so the browser is cheap by default; flip on
   * if you want the Fluidd-style preview.
   */
  readonly showThumbnails: boolean;
  /** Width (in terminal cells) of each row's inline thumbnail. */
  readonly thumbnailCellW: number;
  /** Height (in terminal cells) of each row's inline thumbnail. */
  readonly thumbnailCellH: number;
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
  readonly webcam: WebcamConfig;
  readonly fileBrowser: FileBrowserConfig;
}

const envServer = process.env.MOONRAKER_HOST ?? '192.168.0.96';
const envPort = process.env.MOONRAKER_PORT ? Number(process.env.MOONRAKER_PORT) : 7125;
// Webcam server is usually on the same host but a different port — Klipper's
// mjpg-streamer / ustreamer defaults to 8080, while Moonraker itself is 7125.
const envWebcamHost = process.env.WEBCAM_HOST ?? envServer;
const envWebcamPort = process.env.WEBCAM_PORT ? Number(process.env.WEBCAM_PORT) : 8080;

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
} as const satisfies DashboardConfig;
