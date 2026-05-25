import type {
  GcodeMetadataMap,
  MoonrakerClient,
} from '@jhyland87/moonraker-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  filterByExtension,
  mergeFileMetadata,
  type FileRow,
} from '../services/fileBrowser';

/**
 * Fetch / action lifecycle states surfaced to the UI.
 *
 * @source
 */
export type FileBrowserStatus = 'idle' | 'loading' | 'ready' | 'error' | 'acting';

/**
 * Configuration for {@link useFileBrowser}. Mirrors
 * `DashboardConfig.fileBrowser` — extracted as its own type so the hook
 * can be reused with arbitrary inputs (tests, future tooling).
 *
 * @source
 */
export interface UseFileBrowserConfig {
  /** Moonraker file root. Almost always `'gcodes'`. */
  readonly root: string;
  /**
   * Allowed file extensions (with or without leading `.`). Empty array
   * means no filter. Defaults to `['.gcode']` in the dashboard config.
   */
  readonly extensions: readonly string[];
  /** Absolute path on disk where downloads land. Used by `download()`. */
  readonly downloadDir: string;
}

/**
 * Return shape of {@link useFileBrowser}. The hook owns the file list,
 * the cached metadata, the selection set, and the filter string;
 * components consume the data + call the actions.
 *
 * @source
 */
export interface UseFileBrowserResult {
  readonly rows: readonly FileRow[];
  readonly status: FileBrowserStatus;
  readonly error?: string;
  readonly selected: ReadonlySet<string>;
  /** Optional message surfaced after an action completes (e.g. delete result). */
  readonly actionMessage?: string;
  /** Re-list files + re-fetch metadata cache. */
  readonly refresh: () => void;
  readonly select: (path: string, isSelected: boolean) => void;
  readonly clearSelection: () => void;
  /** Delete every currently-selected file. Resolves after all attempts. */
  readonly deleteSelected: () => Promise<void>;
  /** Trigger `printer.print.start` for a single gcode path. */
  readonly printOne: (path: string) => Promise<void>;
  /**
   * Download every currently-selected file to `config.downloadDir`. One
   * file per HTTP request — slow but predictable.
   */
  readonly downloadSelected: () => Promise<void>;
}

/**
 * Owns the file browser's data + selection state and exposes action
 * callbacks. Stateless about the UI itself — the modal component reads
 * the snapshot fields and dispatches actions on keystrokes.
 *
 * Data flow:
 *  1. `refresh()` (or initial mount) calls `client.listFiles(root)` and
 *     `client.getDatabaseItem<GcodeMetadataMap>('gcode_metadata')` in
 *     parallel.
 *  2. The file list is extension-filtered to the configured types.
 *  3. The two results are merged into one row per file via
 *     {@link mergeFileMetadata}, keyed by path.
 *  4. Selection state lives in a `Set<string>` of file paths; the modal
 *     toggles entries via `select(path, isSelected)`.
 *
 * Actions go straight back to the client — no optimistic UI; the
 * `acting` status flips while a request is in flight, and a final
 * `refresh()` re-syncs on completion.
 *
 * @param client - The shared websocket client.
 * @param config - {@link UseFileBrowserConfig}.
 * @returns Latest {@link UseFileBrowserResult}.
 *
 * @example
 * ```tsx
 * const browser = useFileBrowser(client, config.fileBrowser);
 * <FileBrowserModal browser={browser} … />
 * ```
 * @source
 */
export const useFileBrowser = (
  client: MoonrakerClient,
  config: UseFileBrowserConfig,
): UseFileBrowserResult => {
  const [rows, setRows] = useState<readonly FileRow[]>([]);
  const [status, setStatus] = useState<FileBrowserStatus>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [actionMessage, setActionMessage] = useState<string | undefined>(undefined);

  // Track whether the hook is still mounted so async actions don't try
  // to setState after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return;
    setStatus('loading');
    setError(undefined);
    try {
      const [entries, metaMap] = await Promise.all([
        client.listFiles(config.root),
        client
          .getDatabaseItem<GcodeMetadataMap>('gcode_metadata')
          // The metadata cache may genuinely be empty on a fresh Moonraker —
          // treat a missing-namespace error as "no metadata", not failure.
          .catch(() => ({}) as GcodeMetadataMap),
      ]);
      if (!mountedRef.current) return;
      const filtered = filterByExtension(entries, config.extensions);
      // Newest-first ordering by modified — matches what Fluidd shows by
      // default, which is what most users expect when scanning for "the
      // file I just sliced."
      const sorted = [...filtered].sort((a, b) => b.modified - a.modified);
      setRows(mergeFileMetadata(sorted, metaMap));
      setStatus('ready');
    } catch (err) {
      if (!mountedRef.current) return;
      setError((err as Error).message);
      setStatus('error');
    }
  }, [client, config.root, config.extensions]);

  // Stable wrapper for the public API — async-callback-friendly signature
  // (`() => void`) so it can be wired to keystroke handlers without await.
  const refreshSync = useCallback((): void => {
    void refresh();
  }, [refresh]);

  // Initial load on mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const select = useCallback((path: string, isSelected: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (isSelected) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const clearSelection = useCallback((): void => {
    setSelected(new Set());
  }, []);

  const deleteSelected = useCallback(async (): Promise<void> => {
    const targets = Array.from(selected);
    if (targets.length === 0) return;
    if (!mountedRef.current) return;
    setStatus('acting');
    setActionMessage(undefined);
    let succeeded = 0;
    let failed = 0;
    const failures: string[] = [];
    for (const path of targets) {
      try {
        await client.deleteFile(`${config.root}/${path}`);
        succeeded++;
      } catch (err) {
        failed++;
        failures.push(`${path}: ${(err as Error).message}`);
      }
    }
    if (!mountedRef.current) return;
    setSelected(new Set());
    setActionMessage(
      failed === 0
        ? `Deleted ${succeeded} file${succeeded === 1 ? '' : 's'}.`
        : `Deleted ${succeeded}, ${failed} failed: ${failures[0] ?? ''}`,
    );
    await refresh();
  }, [client, config.root, selected, refresh]);

  const printOne = useCallback(
    async (path: string): Promise<void> => {
      if (!mountedRef.current) return;
      setStatus('acting');
      setActionMessage(undefined);
      try {
        await client.startPrint(path);
        if (!mountedRef.current) return;
        setActionMessage(`Started print: ${path}`);
        setStatus('ready');
      } catch (err) {
        if (!mountedRef.current) return;
        setActionMessage(`Print failed: ${(err as Error).message}`);
        setStatus('ready');
      }
    },
    [client],
  );

  const downloadSelected = useCallback(async (): Promise<void> => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');

    const targets = Array.from(selected);
    if (targets.length === 0) return;
    if (!mountedRef.current) return;
    setStatus('acting');
    setActionMessage(undefined);
    let succeeded = 0;
    let failed = 0;
    let lastFailure = '';
    for (const path of targets) {
      try {
        const url = `${client.httpBaseUrl}/server/files/${config.root}/${encodeURI(path)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const outPath = join(config.downloadDir, path);
        // Preserve the printer-side subdirectory layout under downloadDir.
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, buf);
        succeeded++;
      } catch (err) {
        failed++;
        lastFailure = `${path}: ${(err as Error).message}`;
      }
    }
    if (!mountedRef.current) return;
    setStatus('ready');
    setActionMessage(
      failed === 0
        ? `Saved ${succeeded} file${succeeded === 1 ? '' : 's'} to ${config.downloadDir}`
        : `Saved ${succeeded}, ${failed} failed: ${lastFailure}`,
    );
  }, [client, config.root, config.downloadDir, selected]);

  return useMemo(
    () => ({
      rows,
      status,
      error,
      selected,
      actionMessage,
      refresh: refreshSync,
      select,
      clearSelection,
      deleteSelected,
      printOne,
      downloadSelected,
    }),
    [
      rows,
      status,
      error,
      selected,
      actionMessage,
      refreshSync,
      select,
      clearSelection,
      deleteSelected,
      printOne,
      downloadSelected,
    ],
  );
};
