import type { ChartRow, ColoredRun } from './types';

/**
 * Collapse adjacent cells with the same color into a single text run, so we
 * emit one `<Text>` per color change in a row instead of one per cell.
 */
export const buildRuns = (row: ChartRow): readonly ColoredRun[] => {
  const runs: ColoredRun[] = [];
  let buffer: string[] = [];
  let currentColor: string | undefined;
  let started = false;

  for (const cell of row) {
    if (!started || cell.color !== currentColor) {
      if (buffer.length > 0) {
        runs.push({ text: buffer.join(''), color: currentColor });
      }
      buffer = [cell.char];
      currentColor = cell.color;
      started = true;
    } else {
      buffer.push(cell.char);
    }
  }
  if (buffer.length > 0) {
    runs.push({ text: buffer.join(''), color: currentColor });
  }
  return runs;
};
