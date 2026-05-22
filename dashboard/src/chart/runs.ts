import type { ChartRow, ColoredRun } from './types';

/**
 * Collapse adjacent cells that share the same `(color, bold)` attribute
 * pair into a single text run, so the renderer can emit one `<Text>`
 * element per attribute change in a row rather than one per cell.
 *
 * @param row - The row to scan.
 * @returns Runs in left-to-right order. Each run's `text` is the
 *          concatenation of its source cells' chars; `color` and `bold`
 *          come from any cell within the run (they are all equal by
 *          construction).
 * @source
 */
export const buildRuns = (row: ChartRow): readonly ColoredRun[] => {
  const runs: ColoredRun[] = [];
  let buffer: string[] = [];
  let currentColor: string | undefined;
  let currentBold: boolean | undefined;
  let started = false;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const run: ColoredRun = currentBold
      ? { text: buffer.join(''), color: currentColor, bold: true }
      : { text: buffer.join(''), color: currentColor };
    runs.push(run);
  };

  for (const cell of row) {
    const cellBold = cell.bold === true;
    if (!started || cell.color !== currentColor || cellBold !== currentBold) {
      flush();
      buffer = [cell.char];
      currentColor = cell.color;
      currentBold = cellBold;
      started = true;
    } else {
      buffer.push(cell.char);
    }
  }
  flush();
  return runs;
};
