import type { MoonrakerClient } from '@jhyland87/moonraker-client';
import { useEffect, useRef, useState } from 'react';

import {
  buildThumbnailUrl,
  fetchThumbnailPng,
  pickBestThumbnail,
} from '../services/thumbnail';

/**
 * Return shape of {@link useThumbnail}. `buffer` is the raw PNG bytes of
 * the most recently fetched thumbnail (or `null` when there's no current
 * print or the fetch is still in flight / failed). `loading` and `error`
 * track the request lifecycle for the panel to surface.
 *
 * @source
 */
export interface UseThumbnailResult {
  readonly buffer: Buffer | null;
  readonly loading: boolean;
  readonly error?: string;
}

/**
 * Fetch and cache the thumbnail PNG for the currently-loaded gcode file.
 *
 * Lifecycle:
 *  1. When `filename` changes (or becomes set), call
 *     `client.getFileMetadata(filename)` to enumerate the available
 *     thumbnails.
 *  2. Pick the smallest thumbnail whose longer edge is `≥ targetPx`
 *     (defaults to 100px — small enough to download fast, large enough
 *     to render cleanly when iTerm2 downscales it for inline display).
 *  3. Download that PNG over HTTP via `server.files.metadata`'s host.
 *  4. Store the buffer in state for the renderer to consume.
 *
 * Any in-flight metadata fetch or PNG download is aborted on filename
 * change so the latest print's thumbnail wins. Errors are swallowed into
 * the `error` field — the dashboard keeps running.
 *
 * @param client - The shared {@link MoonrakerClient}.
 * @param filename - Gcode filename as Moonraker knows it (no leading
 *   `gcodes/`). `undefined` / empty when there's no current print —
 *   the hook returns `null` buffer in that case.
 * @param targetPx - Target longer-edge size for the thumbnail in pixels.
 *   Defaults to `100`.
 * @returns The current {@link UseThumbnailResult}.
 *
 * @example
 * ```tsx
 * const printStatus = usePrintStatus(client);
 * const thumb = useThumbnail(client, printStatus.filename);
 * <PrintStatusPanel ... thumbnail={thumb.buffer} />
 * ```
 * @source
 */
export const useThumbnail = (
  client: MoonrakerClient,
  filename: string | undefined,
  targetPx: number = 100,
): UseThumbnailResult => {
  const [buffer, setBuffer] = useState<Buffer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // No filename → no thumbnail to fetch. Clear any stale buffer so the
    // panel doesn't keep showing the previous print's image.
    if (!filename) {
      abortRef.current?.abort();
      setBuffer(null);
      setError(undefined);
      setLoading(false);
      return;
    }

    // Supersede any in-flight fetch.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let cancelled = false;
    const run = async (): Promise<void> => {
      setLoading(true);
      setError(undefined);
      try {
        const meta = await client.getFileMetadata(filename);
        if (cancelled || ctrl.signal.aborted) return;
        const thumb = pickBestThumbnail(meta.thumbnails ?? [], targetPx);
        if (!thumb) {
          throw new Error('no thumbnails available');
        }
        const url = buildThumbnailUrl(client, thumb.relative_path);
        const png = await fetchThumbnailPng(url, ctrl.signal);
        if (cancelled || ctrl.signal.aborted) return;
        setBuffer(png);
      } catch (err) {
        if (cancelled || ctrl.signal.aborted) return;
        setError((err as Error).message);
        setBuffer(null);
      } finally {
        if (!cancelled && !ctrl.signal.aborted) setLoading(false);
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [client, filename, targetPx]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  return { buffer, loading, error };
};
