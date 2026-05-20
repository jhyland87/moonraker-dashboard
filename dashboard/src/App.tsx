import type { MoonrakerClient } from '@jhyland87/moonraker-client';
import { useCallback, useMemo, useState } from 'react';
import { useInput, useSize } from 'react-curse';

import { AsciiLineChart } from './components/AsciiLineChart';
import { ConsolePanel } from './components/ConsolePanel';
import { ErrorPanel, ERROR_PANEL_HEIGHT } from './components/ErrorPanel';
import {
  PrintStatusPanel,
  PRINT_PANEL_HEIGHT,
  PRINT_PANEL_MIN,
  PRINT_PANEL_GAP,
  computePanelGeometry,
} from './components/PrintStatusPanel';
import { SensorTable, SENSOR_TABLE_WIDTH, sensorTableHeight } from './components/SensorTable';
import { StatusBar } from './components/StatusBar';
import {
  SystemStatsPanel,
  SYSTEM_PANEL_GAP,
  SYSTEM_PANEL_HEIGHT,
  computeSystemPanelGeometry,
} from './components/SystemStatsPanel';
import type { ChartSeries } from './chart/index';
import type { DashboardConfig } from './config/index';
import { useGcodeConsole } from './hooks/useGcodeConsole';
import { useKlipperStats } from './hooks/useKlipperStats';
import { useMachineProcStats } from './hooks/useMachineProcStats';
import { useMoonrakerSensors } from './hooks/useMoonrakerSensors';
import { usePrintStatus } from './hooks/usePrintStatus';
import { usePrinterErrors } from './hooks/usePrinterErrors';
import { restoreTerminalNow } from './terminal';
import type { SensorConfig, SensorsState } from './types/index';

interface AppProps {
  readonly client: MoonrakerClient;
  readonly config: DashboardConfig;
}

/**
 * Build the chart series.
 *
 * Drawing order matches `status.graph` in moonraker-cli:
 *   1. All target lines first (back layer), in reverse table order so the first
 *      table row's target sits on top within the target group.
 *   2. All current-temp lines next (front layer), same reverse order so the
 *      first table row's temp sits on top overall.
 *
 * Net effect: targets never overdraw any current line, and `sensors[0]` is the
 * most prominent series.
 */
const buildSeries = (
  state: SensorsState,
  configs: readonly SensorConfig[],
  hidden: ReadonlySet<string>,
): readonly ChartSeries[] => {
  const series: ChartSeries[] = [];

  for (let i = configs.length - 1; i >= 0; i--) {
    const cfg = configs[i]!;
    if (!cfg.hasTarget) continue;
    if (hidden.has(cfg.toggleKey)) continue;
    const sensor = state[cfg.objectName];
    if (!sensor) continue;
    series.push({
      name: `${cfg.label} tgt`,
      color: cfg.dimColor,
      values: sensor.samples.map((s) => s.target),
      timestamps: sensor.samples.map((s) => s.timestamp),
    });
  }

  for (let i = configs.length - 1; i >= 0; i--) {
    const cfg = configs[i]!;
    if (hidden.has(cfg.toggleKey)) continue;
    const sensor = state[cfg.objectName];
    if (!sensor) continue;
    series.push({
      name: cfg.label,
      color: cfg.color,
      values: sensor.samples.map((s) => s.temperature),
      timestamps: sensor.samples.map((s) => s.timestamp),
    });
  }

  return series;
};

const CHART_THEME = {
  axisColor: 'BrightBlack',
  labelColor: 'BrightBlack',
  timeColor: 'BrightBlack',
} as const;

const STATUSBAR_HEIGHT = 1;
const TABLE_BOTTOM_GAP = 1;

export const App = ({ client, config }: AppProps) => {
  const { width, height } = useSize();
  const { sensors, status } = useMoonrakerSensors(client, config);
  const printStatus = usePrintStatus(client);
  const printerErrors = usePrinterErrors(client);
  const [debug, setDebug] = useState<boolean>(config.console.debug);
  const gcodeConsole = useGcodeConsole(client, { debug });
  const procStats = useMachineProcStats(client);
  const klipperStats = useKlipperStats(client);
  const showErrorPanel =
    printerErrors.klippyState === 'shutdown' || printerErrors.klippyState === 'error';
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [consoleOpen, setConsoleOpen] = useState(false);
  // Mirrors ConsolePanel.inputFocused. While the console's text input has
  // focus, every keystroke goes into the draft — sensor toggles and other
  // app-level shortcuts must stay out of the way. View-mode is unaffected.
  const [consoleInputFocused, setConsoleInputFocused] = useState(false);

  // Map case-insensitive toggle key → sensor; built once per config change so
  // the input handler stays cheap.
  const toggleKeys = useMemo(() => {
    const m = new Map<string, string>();
    for (const cfg of config.sensors) m.set(cfg.toggleKey.toLowerCase(), cfg.toggleKey);
    return m;
  }, [config.sensors]);

  useInput(
    (input) => {
      // Ctrl-C always quits, even from inside the console.
      if (input === '\x03') {
        client.close();
        restoreTerminalNow();
        process.exit(0);
        return;
      }
      // Console input is focused — every keystroke is meant for the text
      // input. Stay completely out of the way (no sensor toggles, no quit).
      // View-mode of the console is *not* gated here: sensor toggles and
      // other app-level shortcuts continue to work while the user is just
      // watching the feed.
      if (consoleInputFocused) return;

      if (input === 'q') {
        // When the console is open, `q` belongs to the console (closes it
        // via ConsolePanel's view-mode handler). Only quit when the console
        // is closed.
        if (consoleOpen) return;
        client.close();
        // Bypass react-curse's exit path — write the rmcup sequence directly to
        // the stdout fd (blocking syscall) and exit immediately. This guarantees
        // the alt-screen is left before the process tears down, regardless of
        // any stream-level buffering in `process.stdout`.
        restoreTerminalNow();
        process.exit(0);
        return;
      }
      if (input === 'c' || input === 'C') {
        // Same: when open, `c` is the console's close shortcut.
        if (consoleOpen) return;
        setConsoleOpen(true);
        return;
      }
      const key = toggleKeys.get(input.toLowerCase());
      if (key === undefined) return;
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    // Deps: react-curse defaults to `[]`, which freezes the closure at mount.
    // Include every state value the handler reads.
    [consoleInputFocused, consoleOpen, toggleKeys, client],
  );

  const series = useMemo(
    () => buildSeries(sensors, config.sensors, hidden),
    [sensors, config.sensors, hidden],
  );

  // Stable callbacks for ConsolePanel — its `useInput` deps include these
  // (so it sees current values), and stable refs prevent unnecessary
  // re-registration of the keystroke listener on every App render.
  const sendCommand = gcodeConsole.send;
  const handleSubmitConsole = useCallback(
    (s: string) => void sendCommand(s),
    [sendCommand],
  );
  const handleCloseConsole = useCallback(() => setConsoleOpen(false), []);
  const handleToggleDebug = useCallback(() => setDebug((d) => !d), []);

  const host = `${config.client.API.connection.server}:${config.client.API.connection.port ?? 80}`;

  const tableY = STATUSBAR_HEIGHT;
  // The table block must fit the tallest of: sensor rows, print panel,
  // system panel. Otherwise the chart would draw on top of a panel that
  // extends further down than the sensor list.
  const tableBlockHeight = Math.max(
    sensorTableHeight(config.sensors),
    PRINT_PANEL_HEIGHT,
    SYSTEM_PANEL_HEIGHT,
  );
  const chartY = tableY + tableBlockHeight + TABLE_BOTTOM_GAP;
  const availableForChartAndConsole =
    height - chartY - (showErrorPanel ? ERROR_PANEL_HEIGHT : 0);
  // Console takes the bottom ~quarter of the chart area; floor at 8 so it
  // still fits header + a few entries + hint + input.
  const consoleHeight = consoleOpen
    ? Math.min(
        Math.max(8, Math.floor(availableForChartAndConsole / 4)),
        Math.max(8, availableForChartAndConsole - 8),
      )
    : 0;
  const chartHeight = Math.max(8, availableForChartAndConsole - consoleHeight);

  // Three-column header layout:
  //   [SensorTable] [PrintStatusPanel] [SystemStatsPanel]
  //
  // The system panel right-aligns to the terminal edge if the row can
  // accommodate both panels alongside the sensor table. If the screen is too
  // narrow for all three, we fall back to the older two-column layout
  // (sensor + print only).
  const systemLeftEdge = SENSOR_TABLE_WIDTH + PRINT_PANEL_GAP + PRINT_PANEL_MIN + SYSTEM_PANEL_GAP;
  const systemPanelGeom = computeSystemPanelGeometry(width, systemLeftEdge);
  const printRightBound = systemPanelGeom ? systemPanelGeom.x - SYSTEM_PANEL_GAP : width;
  const printPanelGeom = computePanelGeometry(printRightBound, SENSOR_TABLE_WIDTH);

  return (
    <>
      <StatusBar status={status} host={host} y={0} width={width} />
      <SensorTable
        configs={config.sensors}
        sensors={sensors}
        hidden={hidden}
        y={tableY}
        width={width}
      />
      {printPanelGeom && (
        <PrintStatusPanel
          status={printStatus}
          y={tableY}
          x={printPanelGeom.x}
          width={printPanelGeom.width}
        />
      )}
      {systemPanelGeom && (
        <SystemStatsPanel
          procStats={procStats}
          klipper={klipperStats}
          y={tableY}
          x={systemPanelGeom.x}
          width={systemPanelGeom.width}
        />
      )}
      <AsciiLineChart
        series={series}
        width={width}
        height={chartHeight}
        x={0}
        y={chartY}
        theme={CHART_THEME}
      />
      {consoleOpen && (
        <ConsolePanel
          entries={gcodeConsole.entries}
          onSubmit={handleSubmitConsole}
          onClose={handleCloseConsole}
          naturalScroll={config.console.naturalScroll}
          debug={debug}
          onToggleDebug={handleToggleDebug}
          onInputFocusChange={setConsoleInputFocused}
          y={chartY + chartHeight}
          width={width}
          height={consoleHeight}
        />
      )}
      {showErrorPanel && (
        <ErrorPanel
          klippyState={printerErrors.klippyState}
          stateMessage={printerErrors.stateMessage}
          errors={printerErrors.errors}
          fetchError={printerErrors.fetchError}
          y={chartY + chartHeight + consoleHeight}
          width={width}
        />
      )}
    </>
  );
};
