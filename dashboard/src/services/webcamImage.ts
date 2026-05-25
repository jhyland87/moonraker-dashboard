import { Readable } from 'node:stream';

import jpeg from 'jpeg-js';
import MjpegConsumer from 'mjpeg-consumer';

/**
 * One terminal cell rendered as an upper-half-block (`▀`) with two distinct
 * colors — foreground paints the top source row, background paints the bottom
 * source row. Identical to the encoding the bed-mesh heatmap uses, which lets
 * us reuse the same render path.
 *
 * @source
 */
export interface WebcamCell {
  /** Hex color of the top half-cell (top source pixel row). */
  readonly top: string;
  /** Hex color of the bottom half-cell (bottom source pixel row). */
  readonly bottom: string;
}

/**
 * A decoded webcam frame at the resolution it should render at — already
 * downsampled to the target terminal cell grid. Each entry in `cells[r][c]`
 * is one terminal character cell ({@link WebcamCell}).
 *
 * @source
 */
export interface WebcamFrame {
  /** Visible cell columns. */
  readonly width: number;
  /** Visible cell rows (each row consumes 2 source pixel rows via `▀`). */
  readonly height: number;
  /** Grid indexed `[row][col]`; aspect-ratio-preserving, capped at the dims passed in. */
  readonly cells: readonly (readonly WebcamCell[])[];
}

/**
 * Pack one RGB triplet into a 6-digit `#rrggbb` string. Allocates once per
 * pixel; for a 80×30 cell grid (4800 pixels worth of cells) we issue ~9600
 * of these per frame, which is fine.
 */
const rgbHex = (r: number, g: number, b: number): string => {
  const h = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
  return `#${h.toString(16).padStart(6, '0')}`;
};

/**
 * Nearest-neighbor sample from a decoded RGBA buffer at integer (x, y).
 * Returns `[r, g, b]` (alpha ignored — JPEGs are always opaque). Clamps
 * coordinates so callers can be sloppy at the edges.
 */
const samplePixel = (
  data: Uint8Array | Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
): readonly [number, number, number] => {
  const cx = Math.min(width - 1, Math.max(0, x));
  const cy = Math.min(height - 1, Math.max(0, y));
  const i = (cy * width + cx) * 4;
  return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
};

/**
 * Compute the maximum (cellW, cellH) that fits inside the panel while
 * preserving the source aspect ratio. Terminal cells are roughly twice as
 * tall as they are wide, so for an `srcW × srcH` source image, a cell grid
 * of `cellW × cellH` covers `cellW × (cellH × 2)` source pixels — that's
 * the 2:1 cell aspect baked in.
 *
 * @param srcW - Source image width in pixels.
 * @param srcH - Source image height in pixels.
 * @param maxCellW - Cap on cell columns.
 * @param maxCellH - Cap on cell rows.
 * @returns Best-fit `{ cellW, cellH }`.
 *
 * @source
 */
export const fitCellGrid = (
  srcW: number,
  srcH: number,
  maxCellW: number,
  maxCellH: number,
): { cellW: number; cellH: number } => {
  if (srcW <= 0 || srcH <= 0 || maxCellW < 1 || maxCellH < 1) {
    return { cellW: 0, cellH: 0 };
  }
  // The cell grid's "logical" pixel aspect is cellW : cellH * 2 (since each
  // cell row covers 2 source rows). Pick the dimension that exhausts first.
  const widthLimited = maxCellW;
  const heightLimited = Math.floor((maxCellH * 2 * srcW) / srcH);
  if (heightLimited <= widthLimited) {
    return { cellW: heightLimited, cellH: maxCellH };
  }
  const cellW = widthLimited;
  const cellH = Math.max(1, Math.floor((cellW * srcH) / (srcW * 2)));
  return { cellW, cellH };
};

/**
 * Fetch a webcam snapshot URL and return the raw JPEG bytes. Doesn't decode —
 * that's the caller's job when (and only when) they need a downsampled
 * cell grid. iTerm2 inline-image rendering takes the buffer as-is.
 *
 * @param url - The webcam snapshot URL.
 * @param signal - Optional cancellation signal.
 * @returns The raw JPEG payload.
 * @throws {Error} on HTTP failure or abort.
 *
 * @example
 * ```ts
 * const buf = await fetchJpegBuffer('http://192.168.0.96:8080/?action=snapshot');
 * // pass buf to terminal-image, or to decodeJpegToFrame for half-block render
 * ```
 * @source
 */
export const fetchJpegBuffer = async (
  url: string,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`webcam HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
};

/**
 * Decode a JPEG buffer and downsample it into a {@link WebcamFrame} sized to
 * fit inside `maxCellW × maxCellH` while preserving aspect. JPEG decode is
 * CPU-bound (~50ms for a typical 640×480 frame) so callers should only do
 * this when the renderer actually needs cells (the half-block fallback) —
 * iTerm2 inline rendering hands the buffer to the terminal directly and
 * skips this step entirely.
 *
 * @param buf - Raw JPEG bytes (from {@link fetchJpegBuffer}).
 * @param maxCellW - Maximum cell columns to use.
 * @param maxCellH - Maximum cell rows (each row spans 2 source pixel rows).
 * @returns A decoded {@link WebcamFrame} ready to render.
 * @throws {Error} on decode failure.
 *
 * @example
 * ```ts
 * const buf = await fetchJpegBuffer(url);
 * const frame = decodeJpegToFrame(buf, 80, 30);
 * // frame.cells[0][0] → { top: '#a3b5c8', bottom: '#9aa3b0' }
 * ```
 * @source
 */
export const decodeJpegToFrame = (
  buf: Buffer,
  maxCellW: number,
  maxCellH: number,
): WebcamFrame => {
  // `jpeg-js` does the heavy lifting; `useTArray: true` returns a Uint8Array
  // RGBA buffer instead of a Buffer, saving one copy.
  const decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  const { width: srcW, height: srcH, data } = decoded;

  const { cellW, cellH } = fitCellGrid(srcW, srcH, maxCellW, maxCellH);
  if (cellW === 0 || cellH === 0) {
    return { width: 0, height: 0, cells: [] };
  }

  // Each cell consumes a 2-row block of source pixels mapped via nearest-
  // neighbor. With `useTArray + formatAsRGBA`, `data` is RGBA bytes
  // (length = srcW * srcH * 4).
  const stepX = srcW / cellW;
  const stepY = srcH / (cellH * 2);
  const cells: WebcamCell[][] = [];
  for (let r = 0; r < cellH; r++) {
    const row: WebcamCell[] = [];
    const yTop = Math.floor((r * 2 + 0.5) * stepY);
    const yBot = Math.floor((r * 2 + 1.5) * stepY);
    for (let c = 0; c < cellW; c++) {
      const x = Math.floor((c + 0.5) * stepX);
      const [tr, tg, tb] = samplePixel(data, srcW, srcH, x, yTop);
      const [br, bg, bb] = samplePixel(data, srcW, srcH, x, yBot);
      row.push({ top: rgbHex(tr, tg, tb), bottom: rgbHex(br, bg, bb) });
    }
    cells.push(row);
  }
  return { width: cellW, height: cellH, cells };
};

/**
 * Connect to an MJPEG stream URL and yield each JPEG frame as a Buffer.
 *
 * Bridges the modern fetch API to `mjpeg-consumer`'s Node-stream model:
 * `fetch(url).body` is a Web `ReadableStream`, which `Readable.fromWeb`
 * converts to a Node `Readable`; piping that into `MjpegConsumer` (a
 * Transform stream) yields whole-JPEG buffers via the consumer's
 * `'data'` events, which we surface here as async-iteration values.
 *
 * Cancellation: pass an `AbortSignal`. When aborted, fetch tears down
 * the HTTP connection, the response stream errors, the pipe propagates
 * to the consumer, and the for-await caller's `for-of` exits via the
 * normal error path. Callers should wrap the iteration in try/catch
 * and ignore aborted-signal errors.
 *
 * Backpressure: callers control the consumption rate. The MJPEG server
 * produces frames as fast as the camera does (often 15–30 FPS); if the
 * caller can't process that fast, frames accumulate in the consumer's
 * buffer. Real-time consumers should throttle (e.g. skip frames whose
 * arrival is within `1000/maxFps` ms of the previous one).
 *
 * @param url - The full stream URL (e.g.
 *   `http://192.168.0.96:8080/?action=stream`).
 * @param signal - Optional cancellation signal.
 * @yields Each complete JPEG frame as a Buffer.
 * @throws `Error` on non-2xx HTTP responses, missing body, or stream
 *   errors. Aborted requests surface as `AbortError`.
 *
 * @example
 * ```ts
 * const ctrl = new AbortController();
 * try {
 *   for await (const frame of mjpegStream(url, ctrl.signal)) {
 *     setBuffer(frame);
 *   }
 * } catch (err) {
 *   if (!ctrl.signal.aborted) console.error(err);
 * }
 * ```
 * @source
 */
export async function* mjpegStream(
  url: string,
  signal?: AbortSignal,
): AsyncGenerator<Buffer, void, void> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`mjpegStream HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error('mjpegStream: response has no body');
  }
  // `Readable.fromWeb` arrived in Node 17; we're on Node 25 so this is
  // safe. The cast through `unknown` works around fetch's Web stream
  // type vs Node's `ReadableStream` import not being perfectly aligned.
  const nodeStream = Readable.fromWeb(
    res.body as unknown as Parameters<typeof Readable.fromWeb>[0],
  );
  const consumer = new MjpegConsumer();

  // Attach explicit `'error'` listeners on both streams BEFORE piping.
  //
  // Why: when an `AbortController` is aborted, `fetch`'s signal listener
  // closes the response body synchronously. `Readable.fromWeb` then
  // emits `'error'` on `nodeStream` — also synchronously — which Node
  // throws as "Unhandled 'error' event" if nothing is listening. The
  // throw bubbles right back up through `abort()` → whatever called it
  // (e.g. `stopStream` from the spacebar hotkey), crashing the
  // input loop.
  //
  // The async iterator below surfaces stream errors via its own
  // rejection path, so we don't lose any error information by absorbing
  // the event here — we just stop Node from treating it as an unhandled
  // crash. Same logic applies to `consumer`: if a malformed JPEG (or a
  // forwarded error from the pipe) lands when nobody's iterating, the
  // unhandled-error throw would take everything down.
  nodeStream.on('error', () => {});
  consumer.on('error', () => {});

  nodeStream.pipe(consumer);
  try {
    for await (const chunk of consumer) {
      yield chunk as Buffer;
    }
  } finally {
    // Ensure the response body is drained / closed when iteration ends
    // for any reason — abort, error, or normal completion. Without this,
    // the underlying socket can stay open until GC.
    nodeStream.destroy();
    consumer.destroy();
  }
}
