import type { MoonrakerClient } from '@jhyland87/moonraker-client';
import { useMemo, useState } from 'react';
import { useInput, useSize } from 'react-curse';

import { AsciiLineChart } from './components/AsciiLineChart';
import { ErrorPanel, ERROR_PANEL_HEIGHT } from './components/ErrorPanel';
import {
  PrintStatusPanel,
  PRINT_PANEL_HEIGHT,
  computePanelGeometry,
} from './components/PrintStatusPanel';
import { SensorTable, SENSOR_TABLE_WIDTH, sensorTableHeight } from './components/SensorTable';
import { StatusBar } from './components/StatusBar';
import type { ChartSeries } from './chart/index';
import type { DashboardConfig } from './config/index';
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
  const showErrorPanel =
    printerErrors.klippyState === 'shutdown' || printerErrors.klippyState === 'error';
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());

  // Map case-insensitive toggle key → sensor; built once per config change so
  // the input handler stays cheap.
  const toggleKeys = useMemo(() => {
    const m = new Map<string, string>();
    for (const cfg of config.sensors) m.set(cfg.toggleKey.toLowerCase(), cfg.toggleKey);
    return m;
  }, [config.sensors]);

  useInput((input) => {
    if (input === 'q' || input === '\x03') {
      client.close();
      // Bypass react-curse's exit path — write the rmcup sequence directly to
      // the stdout fd (blocking syscall) and exit immediately. This guarantees
      // the alt-screen is left before the process tears down, regardless of
      // any stream-level buffering in `process.stdout`.
      restoreTerminalNow();
      process.exit(0);
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
  });

  const series = useMemo(
    () => buildSeries(sensors, config.sensors, hidden),
    [sensors, config.sensors, hidden],
  );

  const host = `${config.client.API.connection.server}:${config.client.API.connection.port ?? 80}`;

  const tableY = STATUSBAR_HEIGHT;
  // The table block must fit the print-panel rows too, so reserve at least
  // PRINT_PANEL_HEIGHT rows even when there are fewer sensors than panel rows.
  const tableBlockHeight = Math.max(sensorTableHeight(config.sensors), PRINT_PANEL_HEIGHT);
  const chartY = tableY + tableBlockHeight + TABLE_BOTTOM_GAP;
  const chartHeight = Math.max(
    8,
    height - chartY - (showErrorPanel ? ERROR_PANEL_HEIGHT : 0),
  );

  const panelGeom = computePanelGeometry(width, SENSOR_TABLE_WIDTH);

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
      {panelGeom && (
        <PrintStatusPanel
          status={printStatus}
          y={tableY}
          x={panelGeom.x}
          width={panelGeom.width}
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
      {showErrorPanel && (
        <ErrorPanel
          klippyState={printerErrors.klippyState}
          stateMessage={printerErrors.stateMessage}
          errors={printerErrors.errors}
          fetchError={printerErrors.fetchError}
          y={chartY + chartHeight}
          width={width}
        />
      )}
    </>
  );
};
