import type { GcodeThumbnail, MoonrakerClient } from '@jhyland87/moonraker-client';

/**
 * Pick the thumbnail closest to a target pixel size (without dropping
 * below it when avoidable). Strategy: prefer the smallest thumbnail whose
 * longer edge is `≥ targetPx`; fall back to the largest available when
 * every option is smaller than the target.
 *
 * Slicers commonly emit 32×32 / 100×100 / 320×320 — at a typical terminal
 * cell size, a target of 100 is the right pick for a small inline preview
 * (it'll be downsampled cleanly by the terminal's own image renderer).
 *
 * @param thumbnails - The metadata's `thumbnails` array.
 * @param targetPx - The target longer-edge size in pixels.
 * @returns The chosen thumbnail, or `null` when the array is empty.
 *
 * @example
 * ```ts
 * const meta = await client.getFileMetadata('print.gcode');
 * const thumb = pickBestThumbnail(meta.thumbnails, 100);
 * ```
 * @source
 */
export const pickBestThumbnail = (
  thumbnails: readonly GcodeThumbnail[],
  targetPx: number,
): GcodeThumbnail | null => {
  if (thumbnails.length === 0) return null;
  // Smallest one whose longer edge meets the target.
  const sorted = [...thumbnails].sort(
    (a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height),
  );
  for (const t of sorted) {
    if (Math.max(t.width, t.height) >= targetPx) return t;
  }
  // None met the target — return the largest we have. `sorted[sorted.length - 1]`
  // is non-undefined since we early-returned on empty input.
  return sorted[sorted.length - 1] ?? null;
};

/**
 * Build the HTTP URL to fetch a thumbnail PNG from Moonraker.
 *
 * Delegates scheme/host/port to {@link MoonrakerClient.httpBaseUrl}, so
 * an HTTPS-configured client automatically produces HTTPS thumbnail
 * URLs — no separate plumbing required.
 *
 * Path format mirrors Fluidd / Mainsail:
 * `{baseUrl}/server/files/gcodes/<relative_path>`.
 *
 * @param client - The connected client (provides scheme + host + port).
 * @param relativePath - The `relative_path` from a {@link GcodeThumbnail}.
 * @returns A full URL string.
 *
 * @example
 * ```ts
 * const url = buildThumbnailUrl(client, thumb.relative_path);
 * const res = await fetch(url);
 * ```
 * @source
 */
export const buildThumbnailUrl = (
  client: MoonrakerClient,
  relativePath: string,
): string => {
  // `relative_path` may contain spaces (e.g. ".thumbs/My File-100x100.png").
  // encodeURI preserves path separators while escaping the spaces so the
  // HTTP request is well-formed.
  return `${client.httpBaseUrl}/server/files/gcodes/${encodeURI(relativePath)}`;
};

/**
 * Fetch a thumbnail PNG by URL and return its raw bytes. Tiny convenience
 * wrapper around `fetch` so the hook stays focused on lifecycle.
 *
 * @param url - The full thumbnail URL (from {@link buildThumbnailUrl}).
 * @param signal - Optional cancellation signal.
 * @returns The PNG payload.
 * @throws `Error` on non-2xx HTTP responses or abort.
 *
 * @example
 * ```ts
 * const buf = await fetchThumbnailPng(url);
 * // Pass `buf` to terminal-image rendering or to iTerm2's inline-image escape.
 * ```
 * @source
 */
export const fetchThumbnailPng = async (
  url: string,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`thumbnail HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
};
