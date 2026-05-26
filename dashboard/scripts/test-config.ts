/**
 * Smoke test for the YAML config loader + type guards. Run via:
 *   pnpm tsx scripts/test-config.ts
 *
 * Doesn't touch the dashboard or printer; exercises only the parser.
 */
import { coerceConfig, getConfigPath, loadConfigSync } from '../src/config/index';
import { DEFAULT_CONFIG } from '../src/config/defaults';

const ok = (label: string, cond: boolean): void => {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${label}`);
};

console.log('Config path:', getConfigPath());
console.log();

// Garbage input → every section falls back to default.
const garbage = coerceConfig({
  client: 'not an object',
  sensors: 42,
  layout: { columnSplit: 'nope' },
});
ok('garbage: columnSplit reverts to default', garbage.layout.columnSplit === DEFAULT_CONFIG.layout.columnSplit);
ok('garbage: sensors revert to default', garbage.sensors.length === DEFAULT_CONFIG.sensors.length);

// Partial input — only override columnSplit; rest must be default.
const partial = coerceConfig({ layout: { columnSplit: 0.7 } });
ok('partial: columnSplit honored', partial.layout.columnSplit === 0.7);
ok('partial: fileBrowser.root default', partial.fileBrowser.root === 'gcodes');

// Clamping — out-of-range columnSplit gets clamped to [0.1, 0.9].
const clampedHi = coerceConfig({ layout: { columnSplit: 5.0 } });
ok('clamp: 5.0 → 0.9', clampedHi.layout.columnSplit === 0.9);
const clampedLo = coerceConfig({ layout: { columnSplit: -1 } });
ok('clamp: -1 → 0.1', clampedLo.layout.columnSplit === 0.1);

// Invalid enum → fallback.
const badEnum = coerceConfig({ charts: { renderer: 'invalid' } });
ok('bad enum: renderer reverts', badEnum.charts.renderer === DEFAULT_CONFIG.charts.renderer);

// Type guard on toggleKey: '5' is not a Hotkey, so fallback.
const badHotkey = coerceConfig({
  sensors: [{ ...DEFAULT_CONFIG.sensors[0], toggleKey: '5' }],
});
ok(
  'bad toggleKey: reverts to default',
  badHotkey.sensors[0]?.toggleKey === DEFAULT_CONFIG.sensors[0]?.toggleKey,
);

// Good input: all fields preserved.
const good = coerceConfig({
  layout: { columnSplit: 0.45 },
  webcam: { host: '10.0.0.5', port: 8081, snapshotPath: '/s', streamPath: '/st', streamMaxFps: 20 },
  charts: { renderer: 'palette' },
  console: { naturalScroll: true, debug: true },
});
ok('good: columnSplit honored', good.layout.columnSplit === 0.45);
ok('good: webcam.host honored', good.webcam.host === '10.0.0.5');
ok('good: webcam.port honored', good.webcam.port === 8081);
ok('good: renderer honored', good.charts.renderer === 'palette');
ok('good: naturalScroll honored', good.console.naturalScroll === true);

// Sensor edits preserved when fields are valid.
const sensorEdit = coerceConfig({
  sensors: [{ ...DEFAULT_CONFIG.sensors[0], label: 'My Extruder', toggleKey: 'x' }],
});
ok('sensor edit: label honored', sensorEdit.sensors[0]?.label === 'My Extruder');
ok('sensor edit: toggleKey honored', sensorEdit.sensors[0]?.toggleKey === 'x');

// Live YAML file (writes default if missing).
const { source } = loadConfigSync();
ok(`loadConfigSync source = ${source}`, source === 'file' || source === 'default-new-file');
