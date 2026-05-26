/**
 * @fileoverview YAML config file loader/saver with field-level type guards.
 *
 * Lifecycle:
 *  1. `loadConfigSync()` runs at app boot, before React mounts.
 *  2. If `~/.moonraker-dashboard/config.yaml` doesn't exist, the default
 *     config is written there and returned. First-launch experience: the
 *     user gets a fully-populated file they can hand-edit.
 *  3. If the file exists, it's parsed and each field is run through a
 *     type guard. Any field that's missing or fails its guard is replaced
 *     with the default value for that field. Partial YAML works — the
 *     user can keep only the keys they actually want to override.
 *  4. `saveConfig()` serializes the active config back to disk. Called by
 *     the in-TUI editor after each save.
 *
 * Why type guards instead of `as` casts:
 *  - YAML is user-edited; the loaded `unknown` value can be literally
 *    anything (a string where we wanted a number, an array where we
 *    wanted an object, `null` everywhere because the user deleted a
 *    line). Casting would propagate runtime values that violate the
 *    static types and crash unrelated code downstream.
 *  - Field-level guards let us recover per-field rather than rejecting
 *    the whole file. The "least surprising" failure mode for a TUI
 *    config is "your bad field reverts to default" rather than "the
 *    app refuses to start."
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

import type { ClientConfig } from '@jhyland87/moonraker-client';
import type {
  ChartRenderer,
  ChartsConfig,
  ConsoleConfig,
  DashboardConfig,
  FileBrowserConfig,
  LayoutConfig,
  StartupConfig,
  WebcamConfig,
} from './defaults';
import { DEFAULT_CONFIG, DEFAULT_SENSORS } from './defaults';
import type { Hotkey, PowerField, SensorConfig } from '../types/index';

// =============================================================================
// File-location helpers
// =============================================================================

/**
 * Absolute path to the YAML config file. Resolved once at module load.
 *
 * `~/.moonraker-dashboard/config.yaml` is standard for user-level CLI
 * tooling; the directory is created on first save if missing. If `HOME`
 * isn't set (rare — CI sandboxes, container init), we fall back to the
 * current working directory so the file lands *somewhere* readable.
 *
 * @source
 */
export const getConfigPath = (): string => {
  const home = homedir();
  if (home) return join(home, '.moonraker-dashboard', 'config.yaml');
  return join(process.cwd(), 'moonraker-dashboard.config.yaml');
};

// =============================================================================
// Primitive type guards
// =============================================================================

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every(isString);

/**
 * Pull a value from a `Record<string, unknown>` and validate it with a
 * type guard, falling back to a default if absent or invalid. Centralizes
 * the per-field pattern so each section's `coerce*` function stays
 * readable.
 */
const pick = <T>(
  source: Record<string, unknown>,
  key: string,
  guard: (v: unknown) => v is T,
  fallback: T,
): T => {
  const raw = source[key];
  return guard(raw) ? raw : fallback;
};

// =============================================================================
// Section coercion — each one takes `unknown` and produces a valid section
// =============================================================================

const isChartRenderer = (v: unknown): v is ChartRenderer =>
  v === 'palette' || v === 'braille';

const isPowerField = (v: unknown): v is PowerField =>
  v === 'powers' || v === 'speeds' || v === 'none';

/**
 * `Hotkey` is a strict union of single lowercase letters `'a'..'z'`. We
 * can't enumerate it via a runtime array of the same type easily without
 * duplicating the definition; instead, validate by shape (one char in
 * the range) and assert via the type predicate.
 */
const isHotkey = (v: unknown): v is Hotkey =>
  typeof v === 'string' && v.length === 1 && v >= 'a' && v <= 'z';

const coerceSensor = (
  raw: unknown,
  fallback: SensorConfig,
): SensorConfig => {
  if (!isObject(raw)) return fallback;
  return {
    objectName: pick(raw, 'objectName', isString, fallback.objectName),
    label: pick(raw, 'label', isString, fallback.label),
    color: pick(raw, 'color', isString, fallback.color),
    dimColor: pick(raw, 'dimColor', isString, fallback.dimColor),
    hasTarget: pick(raw, 'hasTarget', isBoolean, fallback.hasTarget),
    powerField: pick(raw, 'powerField', isPowerField, fallback.powerField),
    toggleKey: pick(raw, 'toggleKey', isHotkey, fallback.toggleKey),
  };
};

const coerceSensorList = (raw: unknown): readonly SensorConfig[] => {
  if (!Array.isArray(raw)) return DEFAULT_SENSORS;
  // For each entry, match by index against the default list when possible;
  // when the user has more entries than defaults, fall back to the first
  // default's shape so the new entry inherits sane field types. We assert
  // the first default exists because DEFAULT_SENSORS is non-empty at
  // module load (validated by configFile's own tests — not a runtime
  // surprise in practice).
  const fallbackBase = DEFAULT_SENSORS[0];
  if (fallbackBase === undefined) return [];
  return raw.map((entry, i) => coerceSensor(entry, DEFAULT_SENSORS[i] ?? fallbackBase));
};

const coerceClient = (raw: unknown): ClientConfig => {
  const fallback = DEFAULT_CONFIG.client;
  if (!isObject(raw)) return fallback;
  const api = isObject(raw['API']) ? raw['API'] : {};
  const connection = isObject(api['connection']) ? api['connection'] : {};
  const fbConn = fallback.API.connection;
  return {
    API: {
      connection: {
        server: pick(connection, 'server', isString, fbConn.server),
        port: pick(connection, 'port', isNumber, fbConn.port ?? 7125),
        path: pick(connection, 'path', isString, fbConn.path ?? '/websocket'),
        timeout: pick(connection, 'timeout', isNumber, fbConn.timeout ?? 1000),
        ...(isBoolean(connection['secure']) ? { secure: connection['secure'] } : {}),
      },
    },
  };
};

const coerceConsole = (raw: unknown): ConsoleConfig => {
  const fallback = DEFAULT_CONFIG.console;
  if (!isObject(raw)) return fallback;
  return {
    naturalScroll: pick(raw, 'naturalScroll', isBoolean, fallback.naturalScroll),
    debug: pick(raw, 'debug', isBoolean, fallback.debug),
  };
};

const coerceLayout = (raw: unknown): LayoutConfig => {
  const fallback = DEFAULT_CONFIG.layout;
  if (!isObject(raw)) return fallback;
  // Clamp columnSplit to a sane range so a bad value doesn't make the
  // dashboard unusable (e.g. 0 or 1 → one column has zero width).
  const split = pick(raw, 'columnSplit', isNumber, fallback.columnSplit);
  return {
    columnSplit: Math.min(0.9, Math.max(0.1, split)),
  };
};

const coerceStartup = (raw: unknown): StartupConfig => {
  const fallback = DEFAULT_CONFIG.startup;
  if (!isObject(raw)) return fallback;
  return {
    connectionTimeoutMs: pick(
      raw,
      'connectionTimeoutMs',
      isNumber,
      fallback.connectionTimeoutMs,
    ),
    retryIntervalMs: pick(raw, 'retryIntervalMs', isNumber, fallback.retryIntervalMs),
  };
};

const coerceCharts = (raw: unknown): ChartsConfig => {
  const fallback = DEFAULT_CONFIG.charts;
  if (!isObject(raw)) return fallback;
  return {
    renderer: pick(raw, 'renderer', isChartRenderer, fallback.renderer),
  };
};

const coerceWebcam = (raw: unknown): WebcamConfig => {
  const fallback = DEFAULT_CONFIG.webcam;
  if (!isObject(raw)) return fallback;
  return {
    host: pick(raw, 'host', isString, fallback.host),
    port: pick(raw, 'port', isNumber, fallback.port),
    snapshotPath: pick(raw, 'snapshotPath', isString, fallback.snapshotPath),
    streamPath: pick(raw, 'streamPath', isString, fallback.streamPath),
    streamMaxFps: pick(raw, 'streamMaxFps', isNumber, fallback.streamMaxFps),
    ...(isBoolean(raw['secure']) ? { secure: raw['secure'] } : {}),
  };
};

const coerceFileBrowser = (raw: unknown): FileBrowserConfig => {
  const fallback = DEFAULT_CONFIG.fileBrowser;
  if (!isObject(raw)) return fallback;
  return {
    root: pick(raw, 'root', isString, fallback.root),
    extensions: pick(raw, 'extensions', isStringArray, fallback.extensions),
    visibleColumns: pick(
      raw,
      'visibleColumns',
      isStringArray,
      fallback.visibleColumns,
    ),
    downloadDir: pick(raw, 'downloadDir', isString, fallback.downloadDir),
    showThumbnails: pick(raw, 'showThumbnails', isBoolean, fallback.showThumbnails),
    thumbnailCellW: pick(raw, 'thumbnailCellW', isNumber, fallback.thumbnailCellW),
    thumbnailCellH: pick(raw, 'thumbnailCellH', isNumber, fallback.thumbnailCellH),
  };
};

/**
 * Coerce an arbitrary parsed-YAML value into a valid {@link DashboardConfig},
 * filling in defaults for any field that's missing or fails its type guard.
 *
 * Never throws — invalid input maps to the default. Callers can compare
 * the returned object against `DEFAULT_CONFIG` if they need to know
 * whether the file was usable.
 *
 * @param raw - The result of `yaml.load(...)`. Typed as `unknown` because
 *   YAML is user-edited and can be anything.
 * @returns A fully-populated config; every field is type-safe.
 *
 * @source
 */
export const coerceConfig = (raw: unknown): DashboardConfig => {
  const obj = isObject(raw) ? raw : {};
  return {
    client: coerceClient(obj['client']),
    sensors: coerceSensorList(obj['sensors']),
    historyLength: pick(obj, 'historyLength', isNumber, DEFAULT_CONFIG.historyLength),
    sampleIntervalMs: pick(
      obj,
      'sampleIntervalMs',
      isNumber,
      DEFAULT_CONFIG.sampleIntervalMs,
    ),
    console: coerceConsole(obj['console']),
    layout: coerceLayout(obj['layout']),
    startup: coerceStartup(obj['startup']),
    charts: coerceCharts(obj['charts']),
    webcam: coerceWebcam(obj['webcam']),
    fileBrowser: coerceFileBrowser(obj['fileBrowser']),
  };
};

// =============================================================================
// File I/O
// =============================================================================

/**
 * Read the YAML config from disk, validate every field, and return a
 * fully-populated {@link DashboardConfig}.
 *
 * On any failure path (file missing, parse error, IO error) the default
 * config is returned — and, in the file-missing case, also written to
 * disk so the user has a starting template to edit.
 *
 * Synchronous because it runs before React mounts; the dashboard's first
 * frame depends on having the config in hand.
 *
 * @returns The active config and a hint about whether it came from the
 *   file or the default.
 *
 * @source
 */
export const loadConfigSync = (): {
  config: DashboardConfig;
  source: 'file' | 'default-new-file' | 'default-fallback';
} => {
  const path = getConfigPath();
  if (!existsSync(path)) {
    // First run — write the default config so the user has something to
    // edit. Best-effort: if the write fails (read-only fs, etc.) we
    // still return the in-memory default so the dashboard launches.
    try {
      saveConfig(DEFAULT_CONFIG);
      return { config: DEFAULT_CONFIG, source: 'default-new-file' };
    } catch {
      return { config: DEFAULT_CONFIG, source: 'default-fallback' };
    }
  }
  try {
    const text = readFileSync(path, 'utf8');
    const parsed: unknown = yaml.load(text);
    return { config: coerceConfig(parsed), source: 'file' };
  } catch {
    return { config: DEFAULT_CONFIG, source: 'default-fallback' };
  }
};

/**
 * Serialize the given {@link DashboardConfig} to YAML and write it to
 * {@link getConfigPath}. Creates the parent directory if missing.
 *
 * Synchronous so the editor modal can show success/failure immediately
 * after the user hits "save". Throws on filesystem errors; the caller
 * should surface those in the UI.
 *
 * @param config - The config to persist.
 *
 * @source
 */
export const saveConfig = (config: DashboardConfig): void => {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const text = yaml.dump(config, {
    indent: 2,
    lineWidth: 100,
    quotingType: '"',
    forceQuotes: false,
    sortKeys: false,
  });
  writeFileSync(path, text, 'utf8');
};

/**
 * Restore the on-disk YAML to the canonical default. Returns the default
 * config so the caller can apply it to React state in one step.
 *
 * @returns A fresh default config (same reference as {@link DEFAULT_CONFIG}).
 *
 * @source
 */
export const restoreDefaultConfig = (): DashboardConfig => {
  saveConfig(DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
};
