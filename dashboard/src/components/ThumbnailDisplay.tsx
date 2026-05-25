import { useEffect, useLayoutEffect, useRef } from 'react';
import { Text } from 'react-curse';

import {
  buildIterm2ImageEscape,
  clearTerminalRect,
  writeInlineImageAt,
} from '../services/inlineImage';
import { getGraphicsSupport } from '../services/terminalFeatures';

/**
 * Props for {@link ThumbnailDisplay}.
 *
 * @source
 */
export interface ThumbnailDisplayProps {
  /** Raw PNG / JPEG bytes from `useThumbnail`. Null while loading or absent. */
  readonly buffer: Buffer | null;
  readonly x: number;
  readonly y: number;
  /** Width in terminal cells. */
  readonly width: number;
  /** Height in terminal cells. */
  readonly height: number;
}

/**
 * Cached once per process — env vars don't change at runtime.
 */
const USE_INLINE_IMAGES = getGraphicsSupport().iterm2;

/**
 * Tiny inline-image renderer for the print-status thumbnail (and any
 * future per-print preview). On iTerm2 we hand the raw PNG to the
 * terminal via the `\x1b]1337;File=…` escape (same as `imgcat`). On any
 * other terminal we render nothing — the surrounding panel still works,
 * the thumbnail just doesn't appear.
 *
 * Render-order detail: the image escape lands via `useLayoutEffect`,
 * which fires *after* react-curse's commit, so the inline-image bytes go
 * out after the screen has been painted for the frame. The terminal then
 * keeps the image at those cells until something explicitly overwrites
 * them — which is why we need the unmount cleanup to blank the rect when
 * the panel unmounts (e.g. between prints) so the next-frame content
 * doesn't get ghosted by a stale thumbnail.
 *
 * @param props - See {@link ThumbnailDisplayProps}.
 * @returns The component element (or `null` when nothing to render).
 *
 * @example
 * ```tsx
 * const thumb = useThumbnail(client, status.filename);
 * <ThumbnailDisplay buffer={thumb.buffer} x={50} y={2} width={10} height={5} />
 * ```
 * @source
 */
export const ThumbnailDisplay = ({
  buffer,
  x,
  y,
  width,
  height,
}: ThumbnailDisplayProps) => {
  // Re-emit the iTerm2 inline-image escape on **every render** (no deps
  // array), so any re-render of the dashboard restamps the image and
  // keeps it visible. The image cells live outside react-curse's virtual
  // buffer, so without this they'd eventually be clobbered as react-curse
  // diffs against its model.
  //
  // The base64 encoding is cached per buffer / geometry — recomputed only
  // when those actually change. That keeps the per-render cost to a tiny
  // string concatenation + a stdout write of ~8 KB.
  //
  // The image emit is bracketed with cursor save/restore inside
  // `writeInlineImageAt` so react-curse's cursor-tracking stays correct
  // (otherwise its next cell writes target the wrong row/column,
  // splattering other panels' content into our area).
  const escCacheRef = useRef<{
    buf: Buffer | null;
    w: number;
    h: number;
    esc: string;
  }>({ buf: null, w: 0, h: 0, esc: '' });
  useLayoutEffect(() => {
    if (!USE_INLINE_IMAGES || !buffer || width < 1 || height < 1) return;
    const cache = escCacheRef.current;
    if (cache.buf !== buffer || cache.w !== width || cache.h !== height) {
      escCacheRef.current = {
        buf: buffer,
        w: width,
        h: height,
        esc: buildIterm2ImageEscape(buffer, width, height),
      };
    }
    writeInlineImageAt(escCacheRef.current.esc, x, y);
  });

  // Track current geometry so the unmount cleanup knows which rect to
  // blank. Writing to a ref during render is the React-blessed pattern
  // for "latest value" tracking.
  const geomRef = useRef({ x, y, w: width, h: height });
  geomRef.current = { x, y, w: width, h: height };

  // Unmount cleanup: clear the image cells so the next-frame content
  // doesn't ghost beneath whatever this slot's parent renders. Covers
  // both true unmount (panel hidden) AND the parent-driven
  // null-buffer case — `PrintStatusPanel` already unmounts us when
  // `thumbnail` goes null, so we never see a stale buffer reference here.
  useEffect(() => {
    return () => {
      if (!USE_INLINE_IMAGES) return;
      const g = geomRef.current;
      clearTerminalRect(g.x, g.y, g.w, g.h);
    };
  }, []);

  // Non-iTerm2 terminals: show a small placeholder hint so the user knows
  // there *was* a thumbnail available. Only renders when we have a buffer
  // (i.e., the fetch succeeded) — empty/error states are owned by the
  // parent panel.
  if (!USE_INLINE_IMAGES && buffer) {
    return (
      <Text x={x} y={y + Math.floor(height / 2)} color="BrightBlack" dim>
        [thumbnail]
      </Text>
    );
  }

  return null;
};
