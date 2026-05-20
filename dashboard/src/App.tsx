import type { MoonrakerClient } from '@jhyland87/moonraker-client';
import { useCallback, useMemo, useState } from 'react';
import { useInput, useSize } from 'react-curse';

import { BedMeshPanel } from './components/BedMeshPanel';
import { ConsolePanel } from './components/ConsolePanel';
import { ErrorPanel, ERROR_PANEL_HEIGHT } from './components/ErrorPanel';
import { PrintStatusPanel, PRINT_PANEL_HEIGHT } from './components/PrintStatusPanel';
import { SensorTable, sensorTableHeight } from './components/SensorTable';
import { StatusBar } from './components/StatusBar';
import { SystemStatsPanel, SYSTEM_PANEL_HEIGHT } from './components/SystemStatsPanel';
import { TemperatureChartPanel } from './components/TemperatureChartPanel';
import type { DashboardConfig } from './config/index';
import { useBedMesh } from './hooks/useBedMesh';
import { useGcodeConsole } from './hooks/useGcodeConsole';
import { useKlipperStats } from './hooks/useKlipperStats';
import { useMachineProcStats } from './hooks/useMachineProcStats';
import { useMoonrakerSensors } from './hooks/useMoonrakerSensors';
import { usePrintStatus } from './hooks/usePrintStatus';
import { usePrinterErrors } from './hooks/usePrinterErrors';
import { computeHeaderLayout, findSlot } from './services/headerLayout';
import { restoreTerminalNow } from './terminal';

/**
 * Props for the {@link App} root component.
 * @source
 */
export interface AppProps {
  readonly client: MoonrakerClient;
  readonly config: DashboardConfig;
}

/**
 * Single row reserved for the {@link StatusBar} at `y = 0`.
 */
const STATUSBAR_HEIGHT = 1;

/**
 * Blank row between the top header block (sensor table / print status /
 * system stats) and the main chart area.
 */
const TABLE_BOTTOM_GAP = 1;

/**
 * Root dashboard component.
 *
 * Composition responsibilities:
 *  - Owns the websocket client + every domain hook (sensors, gcode console,
 *    print status, etc.).
 *  - Owns interactive UI state: which overlay (console / bed mesh) is open,
 *    which sensor toggles are active, console-input-focus mirror, etc.
 *  - Computes per-frame geometry by combining the configured header layout
 *    with the {@link useSize} terminal dimensions, then renders each panel
 *    at its resolved `(x, y, width, height)`.
 *
 * Routing notes for keyboard input:
 *  - Ctrl-C always quits (final escape hatch).
 *  - When the console input is focused, App's handler bails entirely so
 *    every keystroke goes to the input draft.
 *  - When the console is open in view mode, `q`/`c` are owned by the
 *    console (close it) rather than the App.
 *  - `h` toggles the bed mesh overlay; Esc closes it when open.
 *  - Per-sensor toggle keys (configured in {@link DashboardConfig.sensors})
 *    hide/show their chart series and dim their table row.
 *
 * @param props - See {@link AppProps}.
 * @returns The full dashboard view.
 * @source
 */
export const App = ({ client, config }: AppProps) => {
  const { width, height } = useSize();
  const { sensors, status } = useMoonrakerSensors(client, config);
  const printStatus = usePrintStatus(client);
  const printerErrors = usePrinterErrors(client);
  const [debug, setDebug] = useState<boolean>(config.console.debug);
  const gcodeConsole = useGcodeConsole(client, { debug });
  const procStats = useMachineProcStats(client);
  const klipperStats = useKlipperStats(client);
  const bedMesh = useBedMesh(client);
  const showErrorPanel =
    printerErrors.klippyState === 'shutdown' || printerErrors.klippyState === 'error';
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [consoleOpen, setConsoleOpen] = useState(false);
  // Mirrors ConsolePanel.inputFocused. While the console's text input has
  // focus, every keystroke goes into the draft — sensor toggles and other
  // app-level shortcuts must stay out of the way. View-mode is unaffected.
  const [consoleInputFocused, setConsoleInputFocused] = useState(false);
  const [bedMeshOpen, setBedMeshOpen] = useState(false);

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
      if (input === 'h' || input === 'H') {
        // Toggle the bed mesh visualization. When opening, kick off a fresh
        // query so the data shown is current — bed_mesh doesn't change often
        // but the user is explicitly asking to view it, so refresh on entry.
        setBedMeshOpen((open) => {
          if (!open) bedMesh.refresh();
          return !open;
        });
        return;
      }
      if (input === '\x1b' && bedMeshOpen) {
        // Esc closes the bed mesh panel when nothing else owns it.
        setBedMeshOpen(false);
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
    [consoleInputFocused, consoleOpen, bedMeshOpen, bedMesh, toggleKeys, client],
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

  // Header row layout is driven by config.layout.header. Each kind resolves
  // to either a {x, width} block or `null` if it didn't fit.
  const headerLayout = useMemo(
    () => computeHeaderLayout(width, config.layout.header),
    [width, config.layout.header],
  );
  const sensorSlot = findSlot(headerLayout, 'sensor-table');
  const printSlot = findSlot(headerLayout, 'print-status');
  const systemSlot = findSlot(headerLayout, 'system-stats');

  return (
    <>
      <StatusBar status={status} host={host} y={0} width={width} />
      {sensorSlot && (
        <SensorTable
          configs={config.sensors}
          sensors={sensors}
          hidden={hidden}
          y={tableY}
          width={sensorSlot.x + sensorSlot.width}
        />
      )}
      {printSlot && (
        <PrintStatusPanel
          status={printStatus}
          y={tableY}
          x={printSlot.x}
          width={printSlot.width}
        />
      )}
      {systemSlot && (
        <SystemStatsPanel
          procStats={procStats}
          klipper={klipperStats}
          y={tableY}
          x={systemSlot.x}
          width={systemSlot.width}
        />
      )}
      {bedMeshOpen ? (
        <BedMeshPanel
          data={bedMesh.data}
          error={bedMesh.error}
          x={0}
          y={chartY}
          width={width}
          height={chartHeight}
        />
      ) : (
        <TemperatureChartPanel
          sensors={sensors}
          configs={config.sensors}
          hidden={hidden}
          width={width}
          height={chartHeight}
          x={0}
          y={chartY}
        />
      )}
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
