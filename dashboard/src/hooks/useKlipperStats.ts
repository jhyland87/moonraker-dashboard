import type { MoonrakerClient, PrinterStatus } from '@jhyland87/moonraker-client';
import { useEffect, useState } from 'react';

import type { TimedSample } from './useMachineProcStats';

/**
 * Klipper-derived stats sourced from `printer.objects` (`system_stats`, `mcu`,
 * `mcu rpi`). Subscription is owned by `useMoonrakerSensors`; this hook does
 * a one-shot `queryObjects` for the initial state and listens to
 * `notify:status_update` for deltas.
 */
export interface McuStats {
  /** mcu_task_avg + 3*stddev, expressed as % of a 1ms task budget. */
  readonly load?: number;
  /** mcu_awake fraction × 100 (Klipper reports as 0..1 of stats window). */
  readonly awakePct?: number;
  readonly loadSamples: readonly TimedSample[];
  readonly awakeSamples: readonly TimedSample[];
}

export interface KlipperStats {
  /** Unix-style load average (1-min). */
  readonly sysload?: number;
  /** Number of CPU cores Klipper sees (denominator for sysload). */
  readonly cpuCores?: number;
  readonly sysloadSamples: readonly TimedSample[];
  /** Klipper's own CPU usage, % of wall time, derived from cputime delta. */
  readonly klipperLoad?: number;
  /** Rolling history of klipperLoad over recent updates. */
  readonly klipperLoadSamples: readonly TimedSample[];
  readonly mainMcu: McuStats;
  readonly rpiMcu: McuStats;
}

interface LastStats {
  readonly mcu_awake?: number;
  readonly mcu_task_avg?: number;
  readonly mcu_task_stddev?: number;
}

interface SystemStatsObject {
  readonly sysload?: number;
  readonly cputime?: number;
  readonly memavail?: number;
}

interface McuObject {
  readonly last_stats?: LastStats;
}

const MAX_HISTORY = 120;

const EMPTY_MCU: McuStats = { loadSamples: [], awakeSamples: [] };

const INITIAL: KlipperStats = {
  klipperLoadSamples: [],
  sysloadSamples: [],
  mainMcu: EMPTY_MCU,
  rpiMcu: EMPTY_MCU,
};

// Klipper's stats describe a task that should never exceed a few hundred μs;
// the "shutdown" threshold is around 2.5ms. We display utilization vs that
// budget as a percentage. Using `mcu_task_avg + 3*stddev` matches Klipper's
// own warning logic (`bandwidth utilization approaching 75%`).
const TASK_BUDGET_S = 0.001; // 1 ms — matches Fluidd's order of magnitude
const computeMcuLoad = (s: LastStats | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const avg = s.mcu_task_avg;
  const stddev = s.mcu_task_stddev ?? 0;
  if (typeof avg !== 'number') return undefined;
  return ((avg + 3 * stddev) / TASK_BUDGET_S) * 100;
};

const computeAwake = (s: LastStats | undefined): number | undefined => {
  if (s === undefined || typeof s.mcu_awake !== 'number') return undefined;
  return s.mcu_awake * 100;
};

const appendCapped = (
  prev: readonly TimedSample[],
  next: TimedSample,
): readonly TimedSample[] => {
  const merged = [...prev, next];
  return merged.length > MAX_HISTORY ? merged.slice(-MAX_HISTORY) : merged;
};

const buildMcuStats = (
  obj: McuObject | undefined,
  prev: McuStats,
  eventtime: number,
): McuStats => {
  if (!obj?.last_stats) return prev;
  const load = computeMcuLoad(obj.last_stats);
  const awake = computeAwake(obj.last_stats);
  return {
    load: load ?? prev.load,
    awakePct: awake ?? prev.awakePct,
    loadSamples:
      load !== undefined
        ? appendCapped(prev.loadSamples, { time: eventtime, value: load })
        : prev.loadSamples,
    awakeSamples:
      awake !== undefined
        ? appendCapped(prev.awakeSamples, { time: eventtime, value: awake })
        : prev.awakeSamples,
  };
};

export const useKlipperStats = (client: MoonrakerClient): KlipperStats => {
  const [stats, setStats] = useState<KlipperStats>(INITIAL);

  useEffect(() => {
    let cancelled = false;

    // Closures keep the prior cputime/eventtime for delta math. We never
    // store these in state — only the *derived* load — so the chart doesn't
    // re-render on every tracked-but-unused field change.
    let prevCputime: number | undefined;
    let prevEventtime: number | undefined;
    let cpuCores: number | undefined;

    const apply = (status: PrinterStatus, eventtime: number): void => {
      setStats((prev) => {
        const sys = status.system_stats as SystemStatsObject | undefined;
        const mcuObj = status.mcu as McuObject | undefined;
        const rpiObj = status['mcu rpi'] as McuObject | undefined;

        let klipperLoad = prev.klipperLoad;
        let klipperLoadSamples = prev.klipperLoadSamples;
        if (sys?.cputime !== undefined) {
          if (prevCputime !== undefined && prevEventtime !== undefined) {
            const wallDelta = eventtime - prevEventtime;
            const cpuDelta = sys.cputime - prevCputime;
            if (wallDelta > 0 && cpuDelta >= 0) {
              klipperLoad = (cpuDelta / wallDelta) * 100;
              klipperLoadSamples = appendCapped(prev.klipperLoadSamples, {
                time: eventtime,
                value: klipperLoad,
              });
            }
          }
          prevCputime = sys.cputime;
          prevEventtime = eventtime;
        }

        const sysloadValue = sys?.sysload;
        const sysloadSamples =
          sysloadValue !== undefined
            ? appendCapped(prev.sysloadSamples, { time: eventtime, value: sysloadValue })
            : prev.sysloadSamples;

        return {
          sysload: sysloadValue ?? prev.sysload,
          cpuCores: cpuCores ?? prev.cpuCores,
          sysloadSamples,
          klipperLoad,
          klipperLoadSamples,
          mainMcu: buildMcuStats(mcuObj, prev.mainMcu, eventtime),
          rpiMcu: buildMcuStats(rpiObj, prev.rpiMcu, eventtime),
        };
      });
    };

    const onOpen = async (): Promise<void> => {
      try {
        // queryObjects returns a SubscribeResult with status + eventtime —
        // we use the eventtime so cputime delta math has a reference point.
        const res = await client.queryObjects({
          system_stats: ['sysload', 'cputime', 'memavail'],
          mcu: ['last_stats'],
          'mcu rpi': ['last_stats'],
        });
        if (cancelled) return;
        apply(res.status, res.eventtime);
      } catch {
        // Live deltas will populate things as they flow.
      }
      // Also try to learn the core count from machine.proc_stats for sysload
      // denominator. Keys other than 'cpu' in system_cpu_usage = per-core.
      try {
        const proc = await client.request<{
          system_cpu_usage?: Record<string, number>;
        }>('machine.proc_stats');
        if (cancelled) return;
        const keys = Object.keys(proc.system_cpu_usage ?? {}).filter((k) => k !== 'cpu');
        if (keys.length > 0) {
          cpuCores = keys.length;
          setStats((prev) => ({ ...prev, cpuCores }));
        }
      } catch {
        // ignore
      }
    };

    const onUpdate = (incoming: PrinterStatus, eventtime: number): void => {
      // Cheap pre-filter: only enter the setState path if something we track changed.
      if (
        incoming.system_stats === undefined &&
        incoming.mcu === undefined &&
        incoming['mcu rpi'] === undefined
      ) {
        return;
      }
      apply(incoming, eventtime);
    };

    if (client.isOpen) void onOpen();
    else client.on('open', () => void onOpen());
    client.on('notify:status_update', onUpdate);

    return () => {
      cancelled = true;
      client.off('notify:status_update', onUpdate);
    };
  }, [client]);

  return stats;
};
