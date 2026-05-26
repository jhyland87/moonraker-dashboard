import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Text } from 'react-curse';

import { PanelFrame } from './PanelFrame';
import type { UseWebcamResult } from '../hooks/useWebcam';
import {
  buildIterm2ImageEscape,
  clearTerminalRect,
  writeInlineImageAt,
} from '../services/inlineImage';
import { decodeJpegToFrame } from '../services/webcamImage';
import { getGraphicsSupport } from '../services/terminalFeatures';


/**
 * Props for {@link WebcamPanel}.
 *
 * @source
 */
export interface WebcamPanelProps {
  readonly webcam: UseWebcamResult;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Cached once per process — env vars don't change at runtime. Using a
 * module-level const so the panel doesn't recompute on every render and
 * the layout-effect closure can rely on a stable value.
 *
 * `GRAPHICS` is the protocol-support matrix from `supports-terminal-graphics`.
 * We currently only emit iTerm2's inline-image protocol; Kitty-only
 * terminals fall through to the half-block path until we add a Kitty
 * emitter. `USE_INLINE_IMAGES` is the gate the panel actually reads.
 */
const GRAPHICS = getGraphicsSupport();
const USE_INLINE_IMAGES = GRAPHICS.iterm2;

/**
 * Short human-readable label for the current webcam mode/status, displayed
 * in the panel's top-border right slot. Captures both the in-progress state
 * (`fetching`) and the steady state (`streaming` / `snapshot`).
 */
const stateLabel = (mode: string, status: string): string => {
  if (status === 'fetching') return mode === 'stream' ? '● streaming' : '● fetching';
  if (status === 'error') return '✕ error';
  if (mode === 'stream') return '● streaming';
  if (status === 'ready') return '○ snapshot';
  return '○ idle';
};

/**
 * Webcam display panel. Two render paths:
 *
 * - **iTerm2** (detected via {@link isITerm2}): hand the raw JPEG to
 *   `terminal-image`, which produces an `\x1b]1337;File=…` inline-image
 *   escape (same protocol `imgcat` uses). We position the cursor at the
 *   panel's inner area and write the escape directly to `process.stdout`
 *   in a `useLayoutEffect` so it lands *after* react-curse's commit and
 *   isn't immediately clobbered. Image quality is identical to `imgcat` —
 *   the terminal does its own scaling and color rendering.
 *
 * - **Fallback** (any other terminal): decode the JPEG with `jpeg-js`,
 *   downsample to the cell grid, and render as a wall of `▀` half-block
 *   `<Text>` elements. Lower fidelity but works everywhere react-curse
 *   does.
 *
 * Render-order detail in the iTerm2 path: the inline-image escape is
 * absolutely-positioned via a cursor-move sequence, so it doesn't compete
 * with `PanelFrame` (which renders react-curse `<Text>` cells around the
 * image area — those cells stay react-curse-managed).
 *
 * @param props - See {@link WebcamPanelProps}.
 * @returns The panel element.
 *
 * @example
 * ```tsx
 * const webcam = useWebcam(config.webcam);
 * <WebcamPanel webcam={webcam} x={0} y={chartY} width={width} height={chartHeight} />
 * ```
 * @source
 */
export const WebcamPanel = ({ webcam, x, y, width, height }: WebcamPanelProps) => {
  const innerX = x + 1;
  const innerY = y + 1;
  const innerW = Math.max(1, width - 2);
  const innerH = Math.max(1, height - 2);

  const { buffer, status, mode, error } = webcam;

  // Protocol chip for the right-side of the panel border. Tells the user
  // which render path is active so quality differences (inline vs
  // half-blocks) aren't mysterious.
  const baseLabel = stateLabel(mode, status);
  const protocolChip = useMemo(() => {
    if (USE_INLINE_IMAGES) return '· inline';
    if (GRAPHICS.kitty) return '· kitty avail';
    if (GRAPHICS.sixel) return '· sixel avail';
    return '';
  }, []);
  const rightLabel = protocolChip ? `${baseLabel} ${protocolChip}` : baseLabel;

  // --- iTerm2 inline-image path ----------------------------------------
  // Re-emit the inline-image escape on every render (no deps array). The
  // image cells live outside react-curse's virtual buffer, so without
  // periodic restamping they'd be lost to any react-curse paint that
  // touches their area. Base64 encoding is cached per buffer / geometry
  // so the per-render cost is just a small stdout write.
  //
  // `writeInlineImageAt` brackets the emit with cursor save/restore so
  // react-curse's cursor-tracking stays correct — otherwise its next
  // cell writes target the wrong row/column.
  const escCacheRef = useRef<{
    buf: Buffer | null;
    w: number;
    h: number;
    esc: string;
  }>({ buf: null, w: 0, h: 0, esc: '' });
  useLayoutEffect(() => {
    if (!USE_INLINE_IMAGES || !buffer || innerW < 1 || innerH < 1) return;
    const cache = escCacheRef.current;
    if (cache.buf !== buffer || cache.w !== innerW || cache.h !== innerH) {
      escCacheRef.current = {
        buf: buffer,
        w: innerW,
        h: innerH,
        esc: buildIterm2ImageEscape(buffer, innerW, innerH, 'webcam.jpg'),
      };
    }
    writeInlineImageAt(escCacheRef.current.esc, innerX, innerY);
  });

  // Track current geometry so the unmount cleanup (below) knows which
  // rectangle to blank. Writing during render is acceptable for "latest
  // value" refs per the React docs — and useEffect cleanups capture refs
  // by reference, so the cleanup always sees the most recent geom.
  const geomRef = useRef({ x: innerX, y: innerY, w: innerW, h: innerH });
  geomRef.current = { x: innerX, y: innerY, w: innerW, h: innerH };

  // --- Unmount cleanup -------------------------------------------------
  // When the user closes the webcam panel (w / Esc), this component
  // unmounts. iTerm2 keeps the inline image painted at those cells —
  // react-curse's cell diff won't touch them because nothing in the new
  // render tree owns those cells, so the chart re-renders *underneath*
  // the image and the image ghosts on top.
  //
  // Fix: write spaces to every cell that held the image just before the
  // unmount completes. Spaces replace the image content in those cells,
  // and react-curse's next render writes the chart cleanly on top.
  useEffect(() => {
    return () => {
      if (!USE_INLINE_IMAGES) return;
      const g = geomRef.current;
      clearTerminalRect(g.x, g.y, g.w, g.h);
    };
  }, []);

  // --- Half-block fallback path ----------------------------------------
  // Decode the buffer into a cell grid ONLY when we're going to render it.
  // `useMemo` keeps decode out of the render path's hot loop and re-runs
  // only when buffer/geometry actually change.
  const frame = useMemo(() => {
    if (USE_INLINE_IMAGES || !buffer || innerW < 1 || innerH < 1) return null;
    try {
      return decodeJpegToFrame(buffer, innerW, innerH);
    } catch {
      return null;
    }
  }, [buffer, innerW, innerH]);

  // --- Render ----------------------------------------------------------
  // Empty / loading / error: same hint regardless of render path. iTerm2
  // path also lands here until the first buffer arrives.
  if (!buffer) {
    return (
      <>
        <Text
          x={innerX + 1}
          y={innerY + Math.max(0, Math.floor(innerH / 2) - 1)}
          color={status === 'error' ? 'Red' : 'BrightBlack'}
        >
          {status === 'fetching'
            ? 'Loading webcam…'
            : status === 'error'
              ? `Webcam error: ${error ?? 'unknown'}`
              : 'press s to snapshot  ·  space to stream'}
        </Text>
        <PanelFrame
          x={x}
          y={y}
          width={width}
          height={height}
          title="Webcam"
          rightLabel={rightLabel}
          rightLabelColor={status === 'error' ? 'Red' : 'BrightBlack'}
        />
      </>
    );
  }

  if (USE_INLINE_IMAGES) {
    // Image is painted by the layoutEffect above; here we only render the
    // border + status. Crucially we render NO Text components in the image
    // area so react-curse doesn't try to repaint cells underneath the
    // inline image.
    return (
      <>
        {status === 'error' && error && (
          <Text x={innerX + 1} y={innerY + innerH - 1} color="Red" bold>
            {error.slice(0, Math.max(0, innerW - 2))}
          </Text>
        )}
        <PanelFrame
          x={x}
          y={y}
          width={width}
          height={height}
          title="Webcam"
          rightLabel={rightLabel}
          rightLabelColor={
            status === 'error' ? 'Red' : mode === 'stream' ? 'Green' : 'BrightBlack'
          }
        />
      </>
    );
  }

  // Half-block fallback. `frame` is null until decode finishes the first
  // time; show the empty-state hint in that brief window.
  if (!frame) {
    return (
      <>
        <Text x={innerX + 1} y={innerY + Math.max(0, Math.floor(innerH / 2) - 1)} color="BrightBlack">
          Decoding…
        </Text>
        <PanelFrame
          x={x}
          y={y}
          width={width}
          height={height}
          title="Webcam"
          rightLabel={rightLabel}
          rightLabelColor="BrightBlack"
        />
      </>
    );
  }

  // Center the frame inside the panel — fitCellGrid preserves aspect, so
  // typically one axis matches the panel and the other has slack.
  const padX = Math.max(0, Math.floor((innerW - frame.width) / 2));
  const padY = Math.max(0, Math.floor((innerH - frame.height) / 2));

  return (
    <>
      {frame.cells.map((row, r) => (
        <Text
          key={`webrow-${r}`}
          x={innerX + padX}
          y={innerY + padY + r}
          width={frame.width}
          height={1}
          block
        >
          {row.map((cell, c) => (
            <Text key={c} x={c} color={cell.top} background={cell.bottom}>
              ▀
            </Text>
          ))}
        </Text>
      ))}
      {status === 'error' && error && (
        <Text x={innerX + 1} y={innerY + innerH - 1} color="Red" bold>
          {error.slice(0, Math.max(0, innerW - 2))}
        </Text>
      )}
      <PanelFrame
        x={x}
        y={y}
        width={width}
        height={height}
        title="Webcam"
        rightLabel={rightLabel}
        rightLabelColor={
          status === 'error' ? 'Red' : mode === 'stream' ? 'Green' : 'BrightBlack'
        }
      />
    </>
  );
};
