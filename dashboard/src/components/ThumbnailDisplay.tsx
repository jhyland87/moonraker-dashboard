import { memo, useEffect, useLayoutEffect, useRef } from 'react';
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
 * Wrapped in {@link memo} at the export site. Every parent render
 * (sensor tick, MJPEG frame, status update, etc.) would otherwise
 * trigger this component's render — and its no-deps `useLayoutEffect`
 * would re-emit the OSC 1337 sequence each time. That per-frame restamp
 * is what was racing with the webcam's 30 KB OSC payload and surfacing
 * as iTerm2's phantom file-download widget. With memo, the function
 * only runs (and the effect only fires) when one of `buffer`, `x`, `y`,
 * `width`, `height` actually changes — typically once on mount, then
 * again only on modal-overlay toggles or terminal resize. The image
 * cells stay painted in iTerm2's image layer between emits, so the
 * thumbnail remains visible without continuous re-stamping.
 */
const ThumbnailDisplayImpl = ({
  buffer,
  x,
  y,
  width,
  height,
}: ThumbnailDisplayProps) => {
  // Emit the iTerm2 inline-image escape. Memo at the export site
  // gates this effect to genuine prop changes (mount, modal toggle,
  // resize), so this is effectively a "stamp once per state change"
  // path — not a per-render restamp. The encoded escape string is
  // cached per buffer/geometry so prop-stable renders cost nothing
  // beyond the stdout write itself. `writeInlineImageAt` brackets
  // the emit with cursor save/restore to keep react-curse's
  // cursor-tracking accurate.
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
        esc: buildIterm2ImageEscape(buffer, width, height, 'thumbnail.png'),
      };
    }
    writeInlineImageAt(escCacheRef.current.esc, x, y);
  });

  // One-shot re-stamp 200ms after mount. The post-mount render flurry
  // (sensor tick, elapsed-time, etc.) produces diff writes near the
  // image cells that can drop the inline image; after the flurry
  // settles those cells stay static (verified via Ctrl-L), so a
  // single delayed restamp is sufficient. No clearTimeout — a stale
  // fire after unmount is harmless because whatever replaced the
  // panel overwrites the cells on its next render.
  useEffect(() => {
    if (!USE_INLINE_IMAGES || !buffer || width < 1 || height < 1) return;
    setTimeout(() => {
      const cache = escCacheRef.current;
      if (cache.esc === '') return;
      writeInlineImageAt(cache.esc, x, y);
    }, 200);
  }, [buffer, x, y, width, height]);

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

/**
 * Memoized export — see {@link ThumbnailDisplayImpl}'s doc for why.
 *
 * Default shallow comparison is correct here: every prop is either a
 * primitive number (`x`, `y`, `width`, `height`) or a reference-stable
 * `Buffer | null` from `useThumbnail`'s `useState`. The Buffer
 * reference only changes when a new thumbnail is fetched (filename
 * change between prints) or when the App layer flips it to `null` to
 * suppress emission during a modal overlay. Both cases legitimately
 * need a re-emit, and memo's default comparator catches them.
 *
 * @source
 */
export const ThumbnailDisplay = memo(ThumbnailDisplayImpl);
