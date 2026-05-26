/**
 * @fileoverview Re-exports for consumers that just need the config types
 * + the canonical default value.
 *
 * The runtime config is loaded from `~/.moonraker-dashboard/config.yaml`
 * at app boot — see {@link loadConfigSync} in `./configFile`. Hot updates
 * from the in-TUI editor flow through {@link saveConfig}.
 *
 * Older code that imported `{ config }` from this module gets the default
 * config; new code should pull the live one from React state via the
 * `config` prop threaded down from `DashboardRoot`.
 */

export type {
  ChartRenderer,
  ChartsConfig,
  ConsoleConfig,
  DashboardConfig,
  Dimension,
  DimensionSpec,
  FileBrowserConfig,
  HeaderPanelLayoutEntry,
  HeaderSlotKind,
  LayoutConfig,
  StartupConfig,
  WebcamConfig,
} from './defaults';

export { DEFAULT_CONFIG, DEFAULT_SENSORS, buildDefaultConfig } from './defaults';

export {
  coerceConfig,
  getConfigPath,
  loadConfigSync,
  restoreDefaultConfig,
  saveConfig,
} from './configFile';

/**
 * @deprecated The dashboard now loads its config from YAML at boot. This
 *   export is kept as an alias for the canonical default so the few
 *   call-sites that referenced `config` still type-check while they're
 *   migrated to threading the live config through props. New code should
 *   read the prop, not this import.
 *
 * @source
 */
export { DEFAULT_CONFIG as config } from './defaults';
