import type { MoonrakerClient, PrinterStatus } from '@jhyland87/moonraker-client';
import { useEffect, useState } from 'react';

export type PrintState =
  | 'standby'
  | 'printing'
  | 'paused'
  | 'complete'
  | 'cancelled'
  | 'error'
  | 'unknown';

export interface PrintStatus {
  readonly state: PrintState;
  readonly filename?: string;
  readonly progress?: number;
  readonly elapsedSec?: number;
  readonly remainingSec?: number;
  readonly currentLayer?: number;
  readonly totalLayers?: number;
  readonly filamentUsedMm?: number;
  readonly filamentTotalMm?: number;
}

interface PrintStatsObject {
  readonly state?: string;
  readonly filename?: string;
  readonly total_duration?: number;
  readonly filament_used?: number;
  readonly info?: { readonly start_time?: number };
}

interface DisplayStatusObject {
  readonly progress?: number;
}

interface VirtualSdcardObject {
  readonly progress?: number;
  readonly layer?: number;
  readonly layer_count?: number;
}

interface MetadataResponse {
  readonly estimated_time?: number;
  readonly filament_total?: number;
}

const normalizeState = (raw: unknown): PrintState => {
  if (
    raw === 'standby' ||
    raw === 'printing' ||
    raw === 'paused' ||
    raw === 'complete' ||
    raw === 'cancelled' ||
    raw === 'error'
  ) {
    return raw;
  }
  return 'unknown';
};

const INITIAL: PrintStatus = { state: 'unknown' };

/**
 * Track Moonraker's print-status objects + the file metadata needed to compute
 * an ETA and filament-total. The websocket subscription is owned by
 * `useMoonrakerSensors` (Moonraker replaces the subscription spec per
 * connection); this hook reads initial values via `queryObjects` and applies
 * deltas from `notify:status_update`.
 *
 * `server.files.metadata` is fetched once per `(filename, start_time)` to keep
 * the per-file estimate cached across status updates.
 */
export const usePrintStatus = (client: MoonrakerClient): PrintStatus => {
  const [status, setStatus] = useState<PrintStatus>(INITIAL);

  useEffect(() => {
    let cancelled = false;

    let printStats: PrintStatsObject = {};
    let displayStatus: DisplayStatusObject = {};
    let virtualSdcard: VirtualSdcardObject = {};
    let metaCache: { key: string; data: MetadataResponse } | undefined;
    let inFlightMetaKey: string | undefined;

    const buildStatus = (meta: MetadataResponse | undefined): PrintStatus => {
      const state = normalizeState(printStats.state);
      const progress =
        displayStatus.progress ?? virtualSdcard.progress ?? undefined;
      const elapsedSec = printStats.total_duration;
      const estimated = meta?.estimated_time;
      let remainingSec: number | undefined;
      if (estimated && estimated > 0 && elapsedSec !== undefined) {
        const r = estimated - elapsedSec;
        remainingSec = r > 0 ? r : 0;
      }
      return {
        state,
        filename: printStats.filename || undefined,
        progress,
        elapsedSec,
        remainingSec,
        currentLayer: virtualSdcard.layer,
        totalLayers: virtualSdcard.layer_count,
        filamentUsedMm: printStats.filament_used,
        filamentTotalMm: meta?.filament_total,
      };
    };

    const fetchMeta = async (filename: string, startTime: number | undefined): Promise<void> => {
      const key = `${filename}|${startTime ?? ''}`;
      if (metaCache?.key === key || inFlightMetaKey === key) return;
      inFlightMetaKey = key;
      try {
        const res = await client.request<MetadataResponse>('server.files.metadata', {
          filename,
        });
        if (cancelled) return;
        metaCache = { key, data: res };
        setStatus(buildStatus(res));
      } catch {
        if (cancelled) return;
        metaCache = { key, data: {} };
        setStatus(buildStatus({}));
      } finally {
        if (inFlightMetaKey === key) inFlightMetaKey = undefined;
      }
    };

    const refresh = (): void => {
      setStatus(buildStatus(metaCache?.data));
      const fn = printStats.filename;
      if (fn) void fetchMeta(fn, printStats.info?.start_time);
    };

    const applyPartials = (incoming: PrinterStatus): void => {
      let touched = false;
      const ps = incoming.print_stats as PrintStatsObject | undefined;
      if (ps) {
        printStats = { ...printStats, ...ps, info: ps.info ?? printStats.info };
        touched = true;
      }
      const ds = incoming.display_status as DisplayStatusObject | undefined;
      if (ds) {
        displayStatus = { ...displayStatus, ...ds };
        touched = true;
      }
      const vs = incoming.virtual_sdcard as VirtualSdcardObject | undefined;
      if (vs) {
        virtualSdcard = { ...virtualSdcard, ...vs };
        touched = true;
      }
      if (touched) refresh();
    };

    const onOpen = async (): Promise<void> => {
      try {
        const res = await client.queryObjects({
          print_stats: ['state', 'filename', 'total_duration', 'filament_used', 'info'],
          display_status: ['progress', 'message'],
          virtual_sdcard: ['progress', 'layer', 'layer_count'],
        });
        if (cancelled) return;
        applyPartials(res.status);
      } catch {
        // Leave status at the previous value; deltas will fill it in once the
        // shared sensors subscription begins flowing.
      }
    };

    const onUpdate = (incoming: PrinterStatus): void => {
      applyPartials(incoming);
    };

    if (client.isOpen) void onOpen();
    else client.on('open', () => void onOpen());
    client.on('notify:status_update', onUpdate);

    return () => {
      cancelled = true;
      client.off('notify:status_update', onUpdate);
    };
  }, [client]);

  return status;
};
