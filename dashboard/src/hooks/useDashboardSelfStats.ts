import { useEffect, useState } from 'react';

import type { TimedSample } from './useMachineProcStats';

/**
 * Resource usage for the dashboard process itself (Node + react-curse +
 * the in-memory caches / streams the dashboard maintains). Distinct from
 * `MachineProcStats`, which surfaces the *printer-side* host's resource
 * usage from Moonraker.
 *
 * `memSamples` / `cpuSamples` are rolling time series suitable for the
 * sparkline chips in `SystemStatsPanel`.
 *
 * @source
 */
export interface DashboardSelfStats {
  /** RSS (resident set size) in MB at the most recent sample. */
  readonly currentMemMb: number;
  /** Process CPU % over the most recent sampling interval (1 core = 100%). */
  readonly currentCpuPct: number;
  readonly memSamples: readonly TimedSample[];
  readonly cpuSamples: readonly TimedSample[];
}

/** How often we sample process.memoryUsage / process.cpuUsage. */
const SAMPLE_INTERVAL_MS = 1000;
/** Sparkline history depth — enough for ~1 min at 1 Hz. */
const HISTORY_LENGTH = 60;

/**
 * Sample the dashboard process's own RSS + CPU% on a fixed cadence and
 * return rolling history alongside the latest values. CPU% is computed
 * from the delta between successive `process.cpuUsage()` snapshots
 * (microseconds of user + system time) divided by wall-clock elapsed —
 * a single fully-pegged core reads as 100%.
 *
 * @returns A snapshot of self-stats that updates on each sample tick.
 *
 * @source
 */
export const useDashboardSelfStats = (): DashboardSelfStats => {
  const [memSamples, setMemSamples] = useState<readonly TimedSample[]>([]);
  const [cpuSamples, setCpuSamples] = useState<readonly TimedSample[]>([]);

  useEffect(() => {
    let prevCpu = process.cpuUsage();
    let prevTime = Date.now();
    const tick = (): void => {
      const now = Date.now();
      const elapsedMs = now - prevTime;
      // Delta against the previous snapshot, in microseconds. Divide by
      // (elapsed * 1000) µs to get CPU-time-as-fraction-of-wall-time,
      // then ×100 for percent. A single fully-loaded core = 100%; an
      // 8-core machine could in theory read up to 800% but Node is
      // single-threaded so realistic values are well under 100%.
      const delta = process.cpuUsage(prevCpu);
      const cpuPct = elapsedMs > 0 ? ((delta.user + delta.system) / 1000 / elapsedMs) * 100 : 0;
      prevCpu = process.cpuUsage();
      prevTime = now;

      const memMb = process.memoryUsage().rss / (1024 * 1024);

      setMemSamples((prev) => {
        const next = prev.length >= HISTORY_LENGTH ? prev.slice(1) : prev;
        return [...next, { time: now, value: memMb }];
      });
      setCpuSamples((prev) => {
        const next = prev.length >= HISTORY_LENGTH ? prev.slice(1) : prev;
        return [...next, { time: now, value: cpuPct }];
      });
    };
    // Prime an initial sample immediately so the chips don't read "—"
    // for the first second after mount.
    tick();
    const interval = setInterval(tick, SAMPLE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const last = <T extends TimedSample>(arr: readonly T[]): number =>
    arr.length === 0 ? 0 : (arr[arr.length - 1]?.value ?? 0);

  return {
    currentMemMb: last(memSamples),
    currentCpuPct: last(cpuSamples),
    memSamples,
    cpuSamples,
  };
};
