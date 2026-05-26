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
  // Re-emit the iTerm2 inline-image escape on **every render**. This is
  // unfortunately the only reliable strategy with react-curse: react-curse
  // rebuilds its virtual buffer from scratch on every render, then diffs
  // cell-by-cell against the previous frame, and any modifier change on
  // an unowned cell (e.g. a Text row shrinking and leaving "default
  // attributes" where it used to write `{color: White}`) produces a
  // cell-reset write that lands AFTER react-curse's commit but BEFORE
  // our useLayoutEffect — except that further state updates can introduce
  // *new* modifier diffs on cells that overlap the image, and any cell
  // write iTerm2 receives invalidates the inline image at that cell.
  // Re-stamping every render is how we counteract that.
  //
  // The base64 encoding is cached per buffer / geometry so each render's
  // cost is only a stdout write of the pre-built escape string. The
  // write is bracketed with cursor save/restore inside
  // `writeInlineImageAt` so react-curse's cursor-tracking stays correct.
  //
  // Known interaction: when both this and `WebcamPanel`'s per-frame
  // re-stamp are active, two large OSC writes share stdout every frame.
  // When the kernel TTY buffer is near-full, libuv can split a write into
  // multiple syscalls and the two OSC sequences interleave, leaving
  // iTerm2's parser in a half-state that surfaces as a phantom file-
  // download widget at the top of the terminal. That's a separate bug
  // — fixing it cleanly needs either an atomic writeSync path or a
  // global serializing queue on stdout. Tracked separately.
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

  // Heartbeat re-emit. The component is wrapped in memo, so the
  // useLayoutEffect above fires only when buffer/x/y/width/height
  // actually change — typically once on mount, then never. That's
  // not enough in practice: empirically the image disappears within
  // a second or so when the webcam is streaming. The exact cause is
  // either (a) iTerm2 evicting older inline images when many new
  // ones come in, or (b) react-curse's cursor traversal during a
  // diff write touching the thumbnail's cells in a way iTerm2
  // interprets as "drop the image here." Either way, periodically
  // re-emitting the OSC restores the image without triggering the
  // phantom-popup race (the rate is slow enough that any single
  // emit's collision with a webcam frame is unlikely).
  //
  // 2 seconds is the smallest interval where the popup hasn't
  // appeared in extended testing while still keeping the thumbnail
  // visually stable. The timer fires from inside a useEffect so it
  // pauses naturally when the component unmounts (modal opens,
  // panel hides, terminal cleanup) and clears any pending fire.
  useEffect(() => {
    if (!USE_INLINE_IMAGES || !buffer || width < 1 || height < 1) return;
    const interval = setInterval(() => {
      const cache = escCacheRef.current;
      if (cache.esc === '') return;
      writeInlineImageAt(cache.esc, x, y);
    }, 2000);
    return () => clearInterval(interval);
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
