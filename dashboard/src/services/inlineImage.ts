/**
 * @fileoverview Helpers for rendering inline images via the iTerm2 protocol.
 *
 * Shared by the webcam panel and the print-status thumbnail. We deliberately
 * speak iTerm2's own `\x1b]1337;File=…` protocol (same as `imgcat`) rather
 * than going through `terminal-image`, which guessed wrong about Kitty
 * support and produced `ENOENT:Image not found` smear in practice.
 *
 * Detection (whether the host terminal supports the protocol) lives in
 * `services/terminalFeatures.ts` — `getGraphicsSupport().iterm2`. The
 * builder here is unconditional; callers gate emission on that signal.
 */

/**
 * Construct the iTerm2 native inline-image escape sequence for an image
 * buffer (PNG / JPEG / GIF — iTerm2 detects the format from the bytes).
 *
 * The escape places the image starting at the current cursor position and
 * the image consumes `cellW × cellH` terminal cells. Preserving the
 * aspect ratio means the image scales to fit inside that box without
 * being stretched — so it's safe to oversize the box (e.g. `cellH = 30`
 * for a 100×100 thumbnail) and let the terminal pick the smaller of
 * the two dimensions.
 *
 * @param buf - Raw image bytes (PNG / JPEG / GIF).
 * @param cellW - Width to claim, in terminal cells.
 * @param cellH - Height to claim, in terminal cells.
 * @returns The complete OSC 1337 escape — write directly to stdout
 *   (preceded by a CSI H cursor-move sequence to position it).
 *
 * @example
 * ```ts
 * const cursorEsc = `\x1b[${y + 1};${x + 1}H`;
 * const imgEsc = buildIterm2ImageEscape(buf, 20, 10);
 * process.stdout.write(cursorEsc + imgEsc);
 * ```
 * @source
 */
export const buildIterm2ImageEscape = (
  buf: Buffer,
  cellW: number,
  cellH: number,
): string => {
  const args = [
    'inline=1',
    `size=${buf.byteLength}`,
    `width=${cellW}`,
    `height=${cellH}`,
    'preserveAspectRatio=1',
  ].join(';');
  return `\x1b]1337;File=${args}:${buf.toString('base64')}\x07`;
};

/**
 * Write an iTerm2 inline-image escape to stdout at an absolute cell
 * position, bracketed with cursor save/restore so react-curse's
 * cursor-tracking bookkeeping isn't perturbed.
 *
 * Why save/restore matters:
 * the inline-image escape moves the terminal cursor to wherever the
 * terminal decides to land after rendering the image (iTerm2 puts it
 * just past the bottom-right of the image). react-curse has an
 * optimization that elides cursor-move escapes when it believes the
 * cursor is already at the target cell — and that optimization is wrong
 * after our write, so subsequent react-curse cell writes target the
 * wrong row/column. Symptom: random text from one panel appears inside
 * the bounds of another.
 *
 * Wrapping with `CSI s` (DECSC-equivalent — save cursor) and `CSI u`
 * (restore cursor) returns the cursor to wherever react-curse left it,
 * so its internal state stays accurate.
 *
 * @param escape - The image escape from {@link buildIterm2ImageEscape}.
 * @param x - Leftmost column to draw the image at (0-indexed).
 * @param y - Topmost row to draw the image at (0-indexed).
 *
 * @example
 * ```ts
 * const esc = buildIterm2ImageEscape(buf, 20, 10);
 * writeInlineImageAt(esc, 80, 5);
 * ```
 * @source
 */
export const writeInlineImageAt = (escape: string, x: number, y: number): void => {
  // CSI s = save cursor, CSI <y>;<x> H = move cursor, image escape, CSI u = restore.
  // One write call so the whole sequence is atomic — no chance for
  // react-curse to slip a write between our position and our restore.
  process.stdout.write(`\x1b[s\x1b[${y + 1};${x + 1}H${escape}\x1b[u`);
};

/**
 * Overwrite a rectangular region of the terminal with blank cells.
 *
 * Used on panel unmount to evict an iTerm2 inline image before react-curse
 * repaints the area with its next-frame content. Without this, the image
 * persists as a ghost beneath whatever react-curse draws next, because
 * react-curse's cell diff doesn't know to repaint cells it never owned in
 * the previous frame.
 *
 * Writes one row of spaces per row in the rect, each prefixed with a
 * CSI cursor-move so the spaces land at the exact cells. Coordinates are
 * 0-indexed; CSI is 1-indexed, hence the `+1`s.
 *
 * @param x - Leftmost column to clear (0-indexed).
 * @param y - Topmost row to clear (0-indexed).
 * @param w - Width in cells.
 * @param h - Height in cells.
 *
 * @example
 * ```ts
 * useEffect(() => {
 *   return () => clearTerminalRect(panel.x, panel.y, panel.width, panel.height);
 * }, []);
 * ```
 * @source
 */
export const clearTerminalRect = (x: number, y: number, w: number, h: number): void => {
  if (w < 1 || h < 1) return;
  const blank = ' '.repeat(w);
  let out = '';
  for (let r = 0; r < h; r++) {
    out += `\x1b[${y + 1 + r};${x + 1}H${blank}`;
  }
  process.stdout.write(out);
};
