import type { MoonrakerClient } from '@jhyland87/moonraker-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInput, useSize } from 'react-curse';

import { BedMeshPanel, computeBedMeshPanelHeight } from './components/BedMeshPanel';
import { ConfigEditorModal } from './components/ConfigEditorModal';
import { ConsolePanel } from './components/ConsolePanel';
import type { ConfigUpdater } from './components/DashboardRoot';
import { ErrorPanel, ERROR_PANEL_HEIGHT } from './components/ErrorPanel';
import { FileBrowserModal } from './components/FileBrowserModal';
import { HelpModal } from './components/HelpModal';
import { PrintStatusPanel, PRINT_PANEL_HEIGHT } from './components/PrintStatusPanel';
import { SensorTable, sensorTableHeight } from './components/SensorTable';
import { StatusBar } from './components/StatusBar';
import { SystemStatsPanel, SYSTEM_PANEL_HEIGHT } from './components/SystemStatsPanel';
import { TemperatureChartPanel } from './components/TemperatureChartPanel';
import { WebcamPanel } from './components/WebcamPanel';
import type { DashboardConfig } from './config/index';
import { useBedMesh } from './hooks/useBedMesh';
import { useDashboardSelfStats } from './hooks/useDashboardSelfStats';
import { useGcodeConsole } from './hooks/useGcodeConsole';
import { useGcodeHelp } from './hooks/useGcodeHelp';
import { useKlipperStats } from './hooks/useKlipperStats';
import { useMachineProcStats } from './hooks/useMachineProcStats';
import { useWebcam } from './hooks/useWebcam';
import { useMoonrakerSensors } from './hooks/useMoonrakerSensors';
import { usePrintStatus } from './hooks/usePrintStatus';
import { usePrinterErrors } from './hooks/usePrinterErrors';
import { useFileBrowser } from './hooks/useFileBrowser';
import { useThumbnail } from './hooks/useThumbnail';
import { solveColumn, type PanelSpec } from './services/columnLayout';
import {
  buildHotkeys,
  dispatchHotkey,
  type HotkeyActions,
  type HotkeyContext,
  type HotkeyState,
} from './services/hotkeys';
import { restoreTerminalNow } from './terminal';

/**
 * Props for the {@link App} root component.
 * @source
 */
export interface AppProps {
  readonly client: MoonrakerClient;
  readonly config: DashboardConfig;
  /**
   * Hot-update + persist callback owned by {@link DashboardRoot}. Each
   * call writes the new config to `~/.moonraker-dashboard/config.yaml`
   * synchronously, then updates React state so the dashboard re-renders
   * with the new values. Used by the in-TUI editor modal.
   */
  readonly setConfig: ConfigUpdater;
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
export const App = ({ client, config, setConfig }: AppProps) => {
  const { width, height } = useSize();
  const { sensors, status } = useMoonrakerSensors(client, config);
  const printStatus = usePrintStatus(client);
  const printerErrors = usePrinterErrors(client);
  const [debug, setDebug] = useState<boolean>(config.console.debug);
  const gcodeConsole = useGcodeConsole(client, { debug });
  const gcodeHelp = useGcodeHelp(client);
  const bedMesh = useBedMesh(client);
  const webcam = useWebcam(config.webcam);
  const procStats = useMachineProcStats(client);
  const klipperStats = useKlipperStats(client);
  const selfStats = useDashboardSelfStats();
  // Thumbnail for the currently-loaded gcode (whatever print_stats.filename
  // says). Updates automatically when the filename changes between prints.
  const thumbnail = useThumbnail(client, printStatus.filename);
  const showErrorPanel =
    printerErrors.klippyState === 'shutdown' || printerErrors.klippyState === 'error';
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  // Console feed is open by default — it's a passive panel like the
  // others, not a modal. Users can still hide it with `c` if they want
  // the chart area back.
  const [consoleOpen, setConsoleOpen] = useState(true);
  // Mirrors ConsolePanel.inputFocused. While the console's text input has
  // focus, every keystroke goes into the draft — sensor toggles and other
  // app-level shortcuts must stay out of the way. View-mode is unaffected.
  const [consoleInputFocused, setConsoleInputFocused] = useState(false);
  const [bedMeshOpen, setBedMeshOpen] = useState(false);
  const [webcamOpen, setWebcamOpen] = useState(false);
  // Fullscreen webcam — covers every other panel except the status bar.
  // Only meaningful when `webcamOpen` is also true; closing the webcam
  // panel via `w` resets this so we never end up with a phantom flag.
  const [webcamFullscreen, setWebcamFullscreen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [configEditorOpen, setConfigEditorOpen] = useState(false);
  const fileBrowser = useFileBrowser(client, config.fileBrowser);

  // ----- Auto-stream gate ------------------------------------------------
  // Per spec: the webcam should stream automatically *only* during an
  // active print. Outside a print, users fetch snapshots manually (`s`)
  // when the panel is visible. The ref tracks the last observed
  // print-state to detect transitions — we only `startStream` / `stopStream`
  // on the change, not every render, so a manual `space` override isn't
  // re-undone on the next React tick.
  const lastPrintingRef = useRef(false);
  useEffect(() => {
    const isPrinting = printStatus.state === 'printing';
    if (isPrinting && !lastPrintingRef.current) {
      webcam.startStream();
    } else if (!isPrinting && lastPrintingRef.current) {
      webcam.stopStream();
    }
    lastPrintingRef.current = isPrinting;
  }, [printStatus.state, webcam]);

  // ----- Hotkey dispatch -------------------------------------------------
  // Every keystroke flows through `services/hotkeys.ts` — the single
  // source of truth for which keys exist, what they do, and when they
  // fire. App.tsx supplies the state snapshot + the action callbacks;
  // the dispatcher walks the list in declaration order and fires the
  // first matching entry. Adding a hotkey is a one-place edit in
  // `hotkeys.ts` and it appears in both the dispatcher and the help
  // modal automatically.
  const hotkeys = useMemo(() => buildHotkeys(config.sensors), [config.sensors]);
  // Stable quit closure — used by both `q` and Ctrl-C hotkeys.
  const quit = useCallback((): void => {
    client.close();
    // Bypass react-curse's exit path — write the rmcup sequence directly to
    // the stdout fd (blocking syscall) and exit immediately. Guarantees the
    // alt-screen is left before tear-down, regardless of any stream-level
    // buffering in `process.stdout`.
    restoreTerminalNow();
    process.exit(0);
  }, [client]);
  // Toggle a single sensor's visibility. Bound here (rather than in
  // `hotkeys.ts`) so the closure can capture `setHidden`.
  const toggleSensorVisibility = useCallback((toggleKey: string): void => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(toggleKey)) next.delete(toggleKey);
      else next.add(toggleKey);
      return next;
    });
  }, []);
  const toggleConsole = useCallback((): void => setConsoleOpen((prev) => !prev), []);
  const refreshBedMesh = useCallback((): void => {
    bedMesh.refresh();
  }, [bedMesh]);
  const webcamSnapshot = useCallback((): void => webcam.snapshot(), [webcam]);
  const webcamToggleStream = useCallback((): void => {
    if (webcam.mode === 'stream') webcam.stopStream();
    else webcam.startStream();
  }, [webcam]);
  const toggleWebcamFullscreen = useCallback(
    (): void => setWebcamFullscreen((prev) => !prev),
    [],
  );

  // ----- Diagnostic clear + force-redraw ---------------------------------
  // `renderTick` is a no-op state used to force a re-render of App after
  // we emit a synthetic resize event. react-curse listens to `process.
  // stdout.on('resize')` and flips its `isResized` flag, but the flag is
  // only consulted on the next render — so we need to schedule one.
  // The state value itself is unused in JSX; React schedules a render
  // for any setState call.
  const [renderTick, setRenderTick] = useState(0);
  void renderTick;
  const forceRedraw = useCallback((): void => {
    // Synthetic resize. react-curse's Term sets isResized=true on this
    // event; its next render sets `full = true` and writes every cell
    // regardless of whether it matches prevBuffer. That repaints
    // anything cells outside react-curse's awareness (inline-image
    // OSCs, sixel pixels) had left in a stale state.
    process.stdout.emit('resize');
    setRenderTick((t) => t + 1);
  }, []);
  const diagnosticClear = useCallback((): void => {
    // CSI 2J = clear entire display, CSI H = cursor home. Writes
    // directly to stdout (sync on TTY) without invalidating
    // react-curse's prevBuffer — its next diff still skips
    // "unchanged" cells, so only animating cells get redrawn. Pair
    // with Ctrl-R to restore.
    process.stdout.write('\x1b[2J\x1b[H');
  }, []);

  // Auto force-redraw when leaving webcam fullscreen. While fullscreen
  // is on the JPEG lives in iTerm2's image layer and react-curse has
  // no record of those cells; on exit, its diff thinks every cell
  // matches prevBuffer (whatever was there before fullscreen mounted),
  // so the unmount cleanup blanks the cells and the new render writes
  // nothing — leaving the screen mostly empty except for currently-
  // updating values. `forceRedraw` repaints everything.
  const prevFullscreenRef = useRef(webcamFullscreen);
  useEffect(() => {
    const wasFullscreen = prevFullscreenRef.current;
    prevFullscreenRef.current = webcamFullscreen;
    if (wasFullscreen && !webcamFullscreen) {
      forceRedraw();
    }
  }, [webcamFullscreen, forceRedraw]);
  // Wrapper around setWebcamOpen that also clears fullscreen on close —
  // prevents a stale fullscreen flag from suppressing the rest of the
  // UI the next time the panel is opened.
  const toggleWebcamOpen = useCallback(
    (updater: boolean | ((prev: boolean) => boolean)): void => {
      setWebcamOpen((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        if (!next) setWebcamFullscreen(false);
        return next;
      });
    },
    [],
  );

  // Bundle state + actions into a HotkeyContext. Refresh on every render
  // via a ref so the input handler's deps stay minimal — the closure
  // always reads the latest values without re-registering the listener.
  const ctxRef = useRef<HotkeyContext | null>(null);
  const hotkeyState: HotkeyState = {
    consoleInputFocused,
    consoleOpen,
    bedMeshOpen,
    webcamOpen,
    helpOpen,
    fileBrowserOpen,
    webcamStreaming: webcam.mode === 'stream',
    webcamFullscreen,
    configEditorOpen,
  };
  const hotkeyActions: HotkeyActions = {
    setHelpOpen,
    setBedMeshOpen,
    setWebcamOpen: toggleWebcamOpen,
    setFileBrowserOpen,
    setConfigEditorOpen,
    toggleConsole,
    refreshBedMesh,
    webcamSnapshot,
    webcamToggleStream,
    toggleWebcamFullscreen,
    forceRedraw,
    diagnosticClear,
    toggleSensorVisibility,
    quit,
  };
  ctxRef.current = { state: hotkeyState, actions: hotkeyActions };

  useInput(
    (input) => {
      // ctxRef.current is set synchronously every render above — it's
      // never null by the time the handler fires.
      if (ctxRef.current !== null) {
        dispatchHotkey(input, hotkeys, ctxRef.current);
      }
    },
    [hotkeys],
  );

  // Stable callbacks for ConsolePanel — its `useInput` deps include these
  // (so it sees current values), and stable refs prevent unnecessary
  // re-registration of the keystroke listener on every App render.
  const sendCommand = gcodeConsole.send;
  const handleSubmitConsole = useCallback(
    (s: string) => void sendCommand(s),
    [sendCommand],
  );
  const handleToggleDebug = useCallback(() => setDebug((d) => !d), []);

  const host = `${config.client.API.connection.server}:${config.client.API.connection.port ?? 80}`;

  // ----- Two-column layout (Fluidd-style) --------------------------------
  // Left column: PrintStatus (fixed) → SensorTable (fixed) → TempChart
  //   (flex) → BedMesh (flex, when visible).
  // Right column: Webcam (flex, when visible) → Console (flex, when visible).
  // Error overlay sits at the bottom across both columns when Klipper
  // signals an error.
  //
  // Visible flexible panels in each column share the remaining vertical
  // space after fixed panels claim theirs — driven by `solveColumn`. Adding
  // or removing a flex panel (via the toggle hotkeys) rescales the
  // neighbors automatically.
  const errorH = showErrorPanel ? ERROR_PANEL_HEIGHT : 0;
  // SystemStats is a full-width strip directly under the columns and
  // directly above the error overlay. The columns get whatever's left.
  const systemH = SYSTEM_PANEL_HEIGHT;
  const totalColumnH = Math.max(8, height - STATUSBAR_HEIGHT - systemH - errorH);
  const splitRatio = config.layout.columnSplit;
  const leftW = Math.max(20, Math.floor(width * splitRatio));
  const rightW = Math.max(20, width - leftW);
  const colStartY = STATUSBAR_HEIGHT;
  const systemY = colStartY + totalColumnH;
  const sensorH = sensorTableHeight(config.sensors);

  // When the bed mesh is open we treat the heatmap as the column's
  // priority claim — it needs enough vertical rows to render its full
  // square grid (one terminal row per mesh-matrix row, which can be
  // ~13 for a Lagrange-interpolated 5×5 probe). The chart yields
  // entirely, collapsing to 1 row if necessary. When the mesh is
  // closed the chart enforces its usual 10-row floor so it stays
  // readable.
  const CHART_MIN_DEFAULT = 10;
  const CHART_MIN_WITH_MESH = 1;
  const chartMin = bedMeshOpen ? CHART_MIN_WITH_MESH : CHART_MIN_DEFAULT;
  const leftSpecs: PanelSpec[] = [
    { id: 'print-status', fixedHeight: PRINT_PANEL_HEIGHT },
    { id: 'sensors', fixedHeight: sensorH },
    { id: 'chart', minHeight: chartMin },
  ];
  if (bedMeshOpen) {
    // Cap `fixedHeight` at what the column can actually host without
    // pushing past the system-stats strip below — the solver allocates
    // positions strictly from cumulative heights, so an oversized
    // `fixedHeight` produces a `y + height` that runs into systemY.
    // With the reduced chart floor above, the cap typically equals the
    // mesh's natural height, so the heatmap stays square.
    const natural = computeBedMeshPanelHeight(bedMesh.data);
    const available = Math.max(
      1,
      totalColumnH - PRINT_PANEL_HEIGHT - sensorH - chartMin,
    );
    leftSpecs.push({
      id: 'bed-mesh',
      fixedHeight: Math.min(natural, available),
    });
  }
  const { positions: leftPos } = solveColumn(leftSpecs, totalColumnH);

  const rightSpecs: PanelSpec[] = [];
  if (webcamOpen) rightSpecs.push({ id: 'webcam', minHeight: 10 });
  if (consoleOpen) rightSpecs.push({ id: 'console', minHeight: 9 });
  const { positions: rightPos } = solveColumn(rightSpecs, totalColumnH);

  // Helper: look up a panel's resolved geometry, returning a safe zero
  // default for panels that weren't included this render (so the lookup
  // doesn't crash if we accidentally try to read a hidden panel's pos).
  const ZERO = { y: 0, height: 0 };
  const ll = (id: string): { y: number; height: number } => leftPos.get(id) ?? ZERO;
  const rl = (id: string): { y: number; height: number } => rightPos.get(id) ?? ZERO;

  const chartGeom = ll('chart');
  const bedMeshGeom = ll('bed-mesh');
  const webcamGeom = rl('webcam');
  const consoleGeom = rl('console');

  // Fullscreen-webcam fast-path: the panel covers everything below the
  // status bar. Distinct React `key`s for the inline vs. fullscreen
  // variants force a full remount on toggle — the unmount cleanup
  // blanks the old image cells before the new geometry paints, so
  // we never leave a ghost rectangle behind.
  const webcamFs = webcamFullscreen && webcamOpen;

  return (
    <>
      <StatusBar status={status} host={host} y={0} width={width} />

      {webcamFs ? (
        // Suppress while a modal is up — same reasoning as the inline
        // variant. The unmount cleanup blanks the image cells so the
        // modal repaints cleanly over them.
        !helpOpen && !fileBrowserOpen && !configEditorOpen && (
          <WebcamPanel
            key="webcam-fullscreen"
            webcam={webcam}
            x={0}
            y={colStartY}
            width={width}
            height={Math.max(1, height - colStartY)}
          />
        )
      ) : (
        <>
          {/* --- Left column ----------------------------------------- */}
          <PrintStatusPanel
            status={printStatus}
            // Suppress the inline thumbnail while a modal is open — its
            // re-emit-every-render layoutEffect would otherwise paint
            // over the modal. Passing `null` causes PrintStatusPanel to
            // skip mounting ThumbnailDisplay, and its unmount cleanup
            // clears the image cells before the modal renders on top.
            //
            // ThumbnailDisplay itself is wrapped in React.memo (see its
            // doc), so during normal operation the OSC emits exactly
            // once on mount + once per genuine prop change. That's
            // what keeps it from racing the webcam's per-frame OSC
            // (which was triggering iTerm2's phantom file-download
            // widget on every parser-state collision).
            thumbnail={helpOpen || fileBrowserOpen || configEditorOpen ? null : thumbnail.buffer}
            x={0}
            y={colStartY + ll('print-status').y}
            width={leftW}
          />
          <SensorTable
            configs={config.sensors}
            sensors={sensors}
            hidden={hidden}
            x={0}
            y={colStartY + ll('sensors').y}
            width={leftW}
          />
          <TemperatureChartPanel
            sensors={sensors}
            configs={config.sensors}
            hidden={hidden}
            renderer={config.charts.renderer}
            x={0}
            y={colStartY + chartGeom.y}
            width={leftW}
            height={chartGeom.height}
          />
          {bedMeshOpen && (
            <BedMeshPanel
              data={bedMesh.data}
              error={bedMesh.error}
              x={0}
              y={colStartY + bedMeshGeom.y}
              width={leftW}
              height={bedMeshGeom.height}
            />
          )}

          {/* --- Right column ---------------------------------------- */}
          {/* Suppressed while the help modal is open — see thumbnail
              comment above. Unmounting the panel triggers its
              clearTerminalRect cleanup so the inline-image cells are
              blanked before the modal repaints over them. */}
          {webcamOpen && !helpOpen && !fileBrowserOpen && !configEditorOpen && (
            <WebcamPanel
              key="webcam-inline"
              webcam={webcam}
              x={leftW}
              y={colStartY + webcamGeom.y}
              width={rightW}
              height={webcamGeom.height}
            />
          )}
          {consoleOpen && (
            <ConsolePanel
              entries={gcodeConsole.entries}
              onSubmit={handleSubmitConsole}
              naturalScroll={config.console.naturalScroll}
              debug={debug}
              onToggleDebug={handleToggleDebug}
              onInputFocusChange={setConsoleInputFocused}
              commands={gcodeHelp}
              x={leftW}
              y={colStartY + consoleGeom.y}
              width={rightW}
              height={consoleGeom.height}
            />
          )}

          {/* --- System stats strip (full width, below both columns) - */}
          <SystemStatsPanel
            procStats={procStats}
            klipper={klipperStats}
            selfStats={selfStats}
            x={0}
            y={systemY}
            width={width}
          />

          {/* --- Bottom error overlay -------------------------------- */}
          {showErrorPanel && (
            <ErrorPanel
              klippyState={printerErrors.klippyState}
              stateMessage={printerErrors.stateMessage}
              errors={printerErrors.errors}
              fetchError={printerErrors.fetchError}
              y={height - errorH}
              width={width}
            />
          )}
        </>
      )}

      {/* --- File browser modal (rendered on top of normal panels) ----- */}
      {fileBrowserOpen && (
        <FileBrowserModal
          browser={fileBrowser}
          client={client}
          termWidth={width}
          termHeight={height}
          visibleColumns={config.fileBrowser.visibleColumns}
          extensionsHint={config.fileBrowser.extensions}
          showThumbnails={config.fileBrowser.showThumbnails}
          thumbnailCellW={config.fileBrowser.thumbnailCellW}
          thumbnailCellH={config.fileBrowser.thumbnailCellH}
          onClose={() => setFileBrowserOpen(false)}
        />
      )}

      {/* --- Config editor modal --------------------------------------- */}
      {configEditorOpen && (
        <ConfigEditorModal
          config={config}
          setConfig={setConfig}
          onClose={() => setConfigEditorOpen(false)}
          termWidth={width}
          termHeight={height}
        />
      )}

      {/* --- Help modal (rendered last so it draws on top of all panels) - */}
      {helpOpen && (
        <HelpModal termWidth={width} termHeight={height} hotkeys={hotkeys} />
      )}
    </>
  );
};
