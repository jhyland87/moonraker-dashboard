import type { MoonrakerClient, PrinterStatus } from '@jhyland87/moonraker-client';
import { useCallback, useEffect, useState } from 'react';

import { computeBedMeshStats, type BedMeshStats } from '../services/bedMesh';

/**
 * Subset of Klipper's `bed_mesh.profiles[<name>].mesh_params` that the
 * dashboard surfaces in the visualization panel.
 * @source
 */
export interface BedMeshParams {
  readonly min_x: number;
  readonly max_x: number;
  readonly min_y: number;
  readonly max_y: number;
  readonly x_count: number;
  readonly y_count: number;
  readonly algo?: string;
  readonly tension?: number;
}

/**
 * Parsed bed-mesh data as the dashboard consumes it. All raw Klipper
 * fields are normalized to their useful TypeScript shape here so the
 * downstream component never has to deal with snake_case or unknowns.
 * @source
 */
export interface BedMeshData {
  readonly profileName: string;
  /** Raw probed values, `y_count` rows by `x_count` cols. */
  readonly probedMatrix: readonly (readonly number[])[];
  /** Interpolated grid Moonraker built from `probedMatrix`. */
  readonly meshMatrix: readonly (readonly number[])[];
  readonly params: BedMeshParams;
  readonly stats: BedMeshStats;
}

interface RawBedMesh {
  readonly profile_name?: string;
  readonly mesh_min?: readonly [number, number];
  readonly mesh_max?: readonly [number, number];
  readonly probed_matrix?: readonly (readonly number[])[];
  readonly mesh_matrix?: readonly (readonly number[])[];
  readonly profiles?: Record<
    string,
    { readonly mesh_params?: Partial<BedMeshParams> }
  >;
}

/**
 * Convert Moonraker's raw `bed_mesh` printer-object payload into the
 * dashboard's normalized shape. Returns `null` when the payload contains
 * no usable matrix.
 *
 * Kept as a free function so unit tests can verify the conversion without
 * mounting the React hook.
 *
 * @param raw - Raw `bed_mesh` object as returned by Moonraker.
 * @returns Parsed bed-mesh data or `null`.
 * @source
 */
const parseBedMesh = (raw: RawBedMesh | undefined): BedMeshData | null => {
  if (!raw) return null;
  const profileName = raw.profile_name ?? '';
  const meshMatrix = raw.mesh_matrix ?? [];
  if (meshMatrix.length === 0 || meshMatrix[0]?.length === 0) return null;
  const stats = computeBedMeshStats(meshMatrix);
  if (!stats) return null;
  const profParams = raw.profiles?.[profileName]?.mesh_params;
  const params: BedMeshParams = {
    min_x: profParams?.min_x ?? raw.mesh_min?.[0] ?? 0,
    max_x: profParams?.max_x ?? raw.mesh_max?.[0] ?? 0,
    min_y: profParams?.min_y ?? raw.mesh_min?.[1] ?? 0,
    max_y: profParams?.max_y ?? raw.mesh_max?.[1] ?? 0,
    x_count: profParams?.x_count ?? (raw.probed_matrix?.[0]?.length ?? 0),
    y_count: profParams?.y_count ?? (raw.probed_matrix?.length ?? 0),
    algo: profParams?.algo,
    tension: profParams?.tension,
  };
  return {
    profileName,
    probedMatrix: raw.probed_matrix ?? [],
    meshMatrix,
    params,
    stats,
  };
};

/**
 * Return value of {@link useBedMesh}.
 * @source
 */
export interface UseBedMeshResult {
  readonly data: BedMeshData | null;
  readonly error?: string;
  readonly refresh: () => void;
}

/**
 * Fetches the current `bed_mesh` printer object via `queryObjects`
 * (one-shot, doesn't touch the shared subscription) and listens to
 * `notify:status_update` for inline changes. The hook is cheap when
 * idle — it doesn't poll. Call `refresh()` to force a re-fetch (e.g.
 * when the bed mesh panel opens).
 *
 * This hook never sends any gcode commands — only queries — making it
 * safe to mount alongside the rest of the dashboard.
 *
 * @param client - The websocket client.
 * @returns The latest parsed mesh data + a `refresh()` trigger.
 * @source
 */
export const useBedMesh = (client: MoonrakerClient): UseBedMeshResult => {
  const [data, setData] = useState<BedMeshData | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const fetchOnce = useCallback(async (): Promise<void> => {
    try {
      const res = await client.queryObjects({
        bed_mesh: ['profile_name', 'mesh_min', 'mesh_max', 'probed_matrix', 'mesh_matrix', 'profiles'],
      });
      const raw = res.status.bed_mesh as RawBedMesh | undefined;
      const parsed = parseBedMesh(raw);
      setData(parsed);
      setError(parsed ? undefined : 'bed_mesh has no mesh_matrix — has a mesh been calibrated?');
    } catch (err) {
      setError(`bed_mesh query failed: ${(err as Error).message}`);
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    const onOpen = (): void => {
      if (cancelled) return;
      void fetchOnce();
    };
    const onUpdate = (status: PrinterStatus): void => {
      const partial = status.bed_mesh as RawBedMesh | undefined;
      if (!partial) return;
      // status_update deltas are partial — but a bed_mesh update covers the
      // whole thing in practice. Re-parse defensively from a merge with what
      // we already have so a partial doesn't drop the matrix.
      setData((prev) => {
        const merged: RawBedMesh = {
          profile_name: partial.profile_name ?? prev?.profileName,
          mesh_min: partial.mesh_min,
          mesh_max: partial.mesh_max,
          probed_matrix: partial.probed_matrix ?? prev?.probedMatrix,
          mesh_matrix: partial.mesh_matrix ?? prev?.meshMatrix,
          profiles: partial.profiles,
        };
        return parseBedMesh(merged) ?? prev;
      });
    };

    if (client.isOpen) onOpen();
    else client.on('open', onOpen);
    client.on('notify:status_update', onUpdate);

    return () => {
      cancelled = true;
      client.off('open', onOpen);
      client.off('notify:status_update', onUpdate);
    };
  }, [client, fetchOnce]);

  return { data, error, refresh: () => void fetchOnce() };
};
