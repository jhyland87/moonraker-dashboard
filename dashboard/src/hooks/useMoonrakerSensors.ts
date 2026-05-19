import type {
  MoonrakerClient,
  PrinterStatus,
  TemperatureStore,
  TemperatureStoreSensor,
} from '@jhyland87/moonraker-client';
import { useEffect, useState } from 'react';

import type { DashboardConfig } from '../config/index';
import type {
  ConnectionStatus,
  SensorConfig,
  SensorState,
  SensorsState,
  TemperatureSample,
} from '../types/index';

interface UseMoonrakerSensorsResult {
  readonly sensors: SensorsState;
  readonly status: ConnectionStatus;
}

const TEMP_STORE_INTERVAL_MS = 1_000;

const buildInitialSensors = (configs: readonly SensorConfig[]): SensorsState =>
  Object.fromEntries(
    configs.map((c) => [
      c.objectName,
      { config: c, current: 0, target: 0, samples: [] } satisfies SensorState,
    ]),
  );

const computeChangeRate = (samples: readonly TemperatureSample[]): number | undefined => {
  if (samples.length < 2) return undefined;
  const last = samples[samples.length - 1]!;
  const prev = samples[samples.length - 2]!;
  const dtSec = (last.timestamp - prev.timestamp) / 1000;
  if (dtSec <= 0) return undefined;
  return (last.temperature - prev.temperature) / dtSec;
};

/**
 * Subscription spec covering everything the dashboard needs from one socket.
 *
 * Moonraker replaces the previous subscription on each `printer.objects.subscribe`
 * call (per connection), so all subscribers on this client must share one spec.
 * Sensor objects use the temperature attribute set; `webhooks` is included so
 * `usePrinterErrors` can react to Klipper state transitions.
 */
const buildSubscriptionSpec = (
  configs: readonly SensorConfig[],
): Record<string, readonly string[]> => ({
  ...Object.fromEntries(
    configs.map((c) => [c.objectName, ['temperature', 'target', 'power', 'speed']]),
  ),
  webhooks: ['state', 'state_message'],
  print_stats: ['state', 'filename', 'total_duration', 'filament_used', 'info'],
  display_status: ['progress', 'message'],
  virtual_sdcard: ['progress', 'layer', 'layer_count'],
});

type SensorPartial = Partial<{
  temperature: number;
  target: number;
  power: number;
  speed: number;
}>;

const updateSensorFromStatus = (
  state: SensorState,
  partial: SensorPartial,
  historyLength: number,
): SensorState => {
  const current = partial.temperature ?? state.current;
  const target = partial.target ?? state.target;
  // Heaters report `power`; fans report `speed`; pure sensors report neither.
  const incomingPower =
    state.config.powerField === 'powers'
      ? partial.power
      : state.config.powerField === 'speeds'
        ? partial.speed
        : undefined;
  const power = incomingPower ?? state.power;
  const sample: TemperatureSample = {
    timestamp: Date.now(),
    temperature: current,
    target,
  };
  const samples = [...state.samples, sample].slice(-historyLength);
  return { ...state, current, target, power, changeRate: computeChangeRate(samples), samples };
};

const mergeStatus = (
  prev: SensorsState,
  status: PrinterStatus,
  historyLength: number,
): SensorsState => {
  let changed = false;
  const next: Record<string, SensorState> = { ...prev };
  for (const [objectName, partial] of Object.entries(status)) {
    const existing = prev[objectName];
    if (!existing || !partial) continue;
    next[objectName] = updateSensorFromStatus(
      existing,
      partial as SensorPartial,
      historyLength,
    );
    changed = true;
  }
  return changed ? next : prev;
};

const samplesFromStore = (
  sensor: TemperatureStoreSensor,
  historyLength: number,
): readonly TemperatureSample[] => {
  const temps = sensor.temperatures;
  const targets = sensor.targets ?? [];
  const slice = Math.min(temps.length, historyLength);
  const start = temps.length - slice;
  const now = Date.now();
  const samples: TemperatureSample[] = new Array(slice);
  for (let i = 0; i < slice; i++) {
    const idx = start + i;
    samples[i] = {
      timestamp: now - (slice - i - 1) * TEMP_STORE_INTERVAL_MS,
      temperature: temps[idx] ?? 0,
      target: targets[idx] ?? 0,
    };
  }
  return samples;
};

const seedFromTemperatureStore = (
  prev: SensorsState,
  store: TemperatureStore,
  historyLength: number,
): SensorsState => {
  const next: Record<string, SensorState> = { ...prev };
  for (const [objectName, state] of Object.entries(prev)) {
    const sensor = store[objectName];
    if (!sensor || sensor.temperatures.length === 0) continue;
    const samples = samplesFromStore(sensor, historyLength);
    const last = samples[samples.length - 1];
    next[objectName] = {
      ...state,
      current: last?.temperature ?? state.current,
      target: last?.target ?? state.target,
      samples,
    };
  }
  return next;
};

/**
 * Connect, seed history from `server.temperature_store`, then subscribe for
 * live deltas. Returns latest readings + websocket status.
 */
export const useMoonrakerSensors = (
  client: MoonrakerClient,
  dashboardConfig: DashboardConfig,
): UseMoonrakerSensorsResult => {
  const [sensors, setSensors] = useState<SensorsState>(() =>
    buildInitialSensors(dashboardConfig.sensors),
  );
  const [status, setStatus] = useState<ConnectionStatus>({ kind: 'connecting' });

  useEffect(() => {
    let cancelled = false;

    const onOpen = async (): Promise<void> => {
      setStatus({ kind: 'open' });
      let seedError: string | undefined;

      try {
        const store = await client.getTemperatureStore();
        if (cancelled) return;
        setSensors((prev) =>
          seedFromTemperatureStore(prev, store, dashboardConfig.historyLength),
        );
      } catch (err) {
        seedError = (err as Error).message;
      }

      try {
        const result = await client.subscribe(buildSubscriptionSpec(dashboardConfig.sensors));
        if (cancelled) return;
        setSensors((prev) => mergeStatus(prev, result.status, dashboardConfig.historyLength));
        if (seedError) {
          setStatus({ kind: 'error', message: `temperature_store: ${seedError}` });
        }
      } catch (err) {
        if (cancelled) return;
        setStatus({ kind: 'error', message: `subscribe: ${(err as Error).message}` });
      }
    };

    const onUpdate = (incoming: PrinterStatus): void => {
      setSensors((prev) => mergeStatus(prev, incoming, dashboardConfig.historyLength));
    };

    const onError = (err: Error): void => {
      setStatus({ kind: 'error', message: err.message });
    };

    const onClose = (code?: number, reason?: string): void => {
      setStatus({ kind: 'closed', code, reason });
    };

    if (client.isOpen) {
      void onOpen();
    } else {
      client.on('open', () => void onOpen());
    }
    client.on('notify:status_update', onUpdate);
    client.on('error', onError);
    client.on('close', onClose);

    return () => {
      cancelled = true;
      client.off('notify:status_update', onUpdate);
      client.off('error', onError);
      client.off('close', onClose);
    };
  }, [client, dashboardConfig]);

  return { sensors, status };
};
