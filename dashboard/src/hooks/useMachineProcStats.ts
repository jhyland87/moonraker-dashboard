import type { MoonrakerClient } from '@jhyland87/moonraker-client';
import { useEffect, useState } from 'react';

/**
 * One sample for a single time series. The "value" semantics differ between
 * the CPU and Mem series — see `MachineProcStats` for which source feeds each.
 */
export interface TimedSample {
  readonly time: number;
  readonly value: number;
}

export interface NetworkInterfaceStats {
  readonly rxBytes: number;
  readonly txBytes: number;
  readonly bandwidth: number;
}

export interface MachineProcStats {
  /**
   * Per-process moonraker CPU usage, %. Seeded from `moonraker_stats[]` in
   * the initial `machine.proc_stats` response (~30 historical samples) and
   * extended live by each `notify:proc_stat_update`.
   */
  readonly cpuSamples: readonly TimedSample[];
  /**
   * System-wide memory usage, % (used / total × 100). No historical source
   * exists; grows tick-by-tick from `notify:proc_stat_update`. Seeded with
   * one sample at startup so the chart isn't blank.
   */
  readonly memSamples: readonly TimedSample[];

  /** Most recent CPU% (same series as `cpuSamples`). */
  readonly cpuPct?: number;
  readonly cpuTemp?: number;
  readonly memUsedKb?: number;
  readonly memTotalKb?: number;
  /** System-wide CPU snapshot for reference / labels. */
  readonly systemCpuPct?: number;
  readonly network: Readonly<Record<string, NetworkInterfaceStats>>;
  readonly systemUptimeSec?: number;
  readonly websocketConnections?: number;
  readonly throttledFlags: readonly string[];
}

interface RawMoonrakerStat {
  readonly time?: number;
  readonly cpu_usage?: number;
  readonly memory?: number | null;
  readonly mem_units?: string | null;
}

interface RawNetworkStat {
  readonly rx_bytes?: number;
  readonly tx_bytes?: number;
  readonly bandwidth?: number;
}

interface RawSystemMemory {
  readonly total?: number;
  readonly available?: number;
  readonly used?: number;
}

interface RawProcStats {
  readonly moonraker_stats?: RawMoonrakerStat | RawMoonrakerStat[];
  readonly cpu_temp?: number | null;
  readonly network?: Record<string, RawNetworkStat>;
  readonly system_cpu_usage?: Record<string, number>;
  readonly system_memory?: RawSystemMemory;
  readonly system_uptime?: number;
  readonly websocket_connections?: number;
  readonly throttled_state?: { readonly flags?: readonly string[] } | null;
}

const MAX_HISTORY = 120; // ~2 minutes at the 1Hz proc_stat cadence

const INITIAL: MachineProcStats = {
  cpuSamples: [],
  memSamples: [],
  network: {},
  throttledFlags: [],
};

const normalizeNetwork = (
  raw: RawProcStats['network'],
): Record<string, NetworkInterfaceStats> => {
  if (!raw) return {};
  const out: Record<string, NetworkInterfaceStats> = {};
  for (const [name, stat] of Object.entries(raw)) {
    out[name] = {
      rxBytes: stat.rx_bytes ?? 0,
      txBytes: stat.tx_bytes ?? 0,
      bandwidth: stat.bandwidth ?? 0,
    };
  }
  return out;
};

const asArray = (raw: RawProcStats['moonraker_stats']): readonly RawMoonrakerStat[] => {
  if (Array.isArray(raw)) return raw;
  if (raw !== undefined) return [raw];
  return [];
};

const memoryPctFromSystem = (mem: RawSystemMemory | undefined): number | undefined => {
  const total = mem?.total;
  const used = mem?.used;
  if (typeof total !== 'number' || total <= 0 || typeof used !== 'number') return undefined;
  return (used / total) * 100;
};

const appendCapped = <T>(prev: readonly T[], next: readonly T[]): readonly T[] => {
  const merged = [...prev, ...next];
  return merged.length > MAX_HISTORY ? merged.slice(-MAX_HISTORY) : merged;
};

/**
 * Track Moonraker's process / system stats over time. Seeds via
 * `machine.proc_stats` (which carries ~30 seconds of per-process CPU history)
 * and accumulates per-tick deltas from `notify:proc_stat_update`.
 *
 * `cpuSamples` is per-process *moonraker* CPU since that's the only thing
 * Moonraker provides historically; `memSamples` is system-wide RAM% (no
 * historical source, so it grows tick-by-tick from a single seed value).
 */
export const useMachineProcStats = (client: MoonrakerClient): MachineProcStats => {
  const [stats, setStats] = useState<MachineProcStats>(INITIAL);

  useEffect(() => {
    let cancelled = false;

    const apply = (raw: RawProcStats, isSeed: boolean): void => {
      setStats((prev) => {
        const moonrakerArr = asArray(raw.moonraker_stats);
        // CPU samples — moonraker_stats carries time + cpu_usage. The seed
        // call gives ~30 entries; live notifications add one at a time.
        const cpuIncoming: TimedSample[] = moonrakerArr
          .filter((s) => typeof s.time === 'number' && typeof s.cpu_usage === 'number')
          .map((s) => ({ time: s.time as number, value: s.cpu_usage as number }));
        const cpuSamples = isSeed
          ? cpuIncoming.slice(-MAX_HISTORY)
          : appendCapped(prev.cpuSamples, cpuIncoming);

        // Memory % — derived from system_memory. No historical source, so the
        // seed call contributes a single sample using the latest moonraker
        // timestamp; afterwards every notification adds one more.
        const memPct = memoryPctFromSystem(raw.system_memory);
        const latestTime =
          moonrakerArr[moonrakerArr.length - 1]?.time ?? Date.now() / 1000;
        let memSamples = prev.memSamples;
        if (memPct !== undefined) {
          const memSample: TimedSample = { time: latestTime, value: memPct };
          memSamples = isSeed ? [memSample] : appendCapped(prev.memSamples, [memSample]);
        }

        const latestCpu = cpuIncoming[cpuIncoming.length - 1]?.value ?? prev.cpuPct;

        return {
          cpuSamples,
          memSamples,
          cpuPct: latestCpu,
          cpuTemp:
            raw.cpu_temp === null || raw.cpu_temp === undefined ? prev.cpuTemp : raw.cpu_temp,
          memUsedKb: raw.system_memory?.used ?? prev.memUsedKb,
          memTotalKb: raw.system_memory?.total ?? prev.memTotalKb,
          systemCpuPct:
            typeof raw.system_cpu_usage?.cpu === 'number'
              ? raw.system_cpu_usage.cpu
              : prev.systemCpuPct,
          network: raw.network ? normalizeNetwork(raw.network) : prev.network,
          systemUptimeSec: raw.system_uptime ?? prev.systemUptimeSec,
          websocketConnections: raw.websocket_connections ?? prev.websocketConnections,
          throttledFlags: raw.throttled_state?.flags ?? prev.throttledFlags,
        };
      });
    };

    const onOpen = async (): Promise<void> => {
      try {
        const res = await client.request<RawProcStats>('machine.proc_stats');
        if (cancelled) return;
        apply(res, true);
      } catch {
        // Leave at initial — deltas will fill it in.
      }
    };

    const onUpdate = (raw: Record<string, unknown>): void => {
      apply(raw as RawProcStats, false);
    };

    if (client.isOpen) void onOpen();
    else client.on('open', () => void onOpen());
    client.on('notify:proc_stat_update', onUpdate);

    return () => {
      cancelled = true;
      client.off('notify:proc_stat_update', onUpdate);
    };
  }, [client]);

  return stats;
};
