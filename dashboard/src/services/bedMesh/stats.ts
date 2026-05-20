/**
 * Aggregate statistics computed across every value in a 2D mesh matrix.
 *
 * Pulled into its own module so it can be unit-tested independently and
 * shared between `useBedMesh` and any future consumer (e.g. a CLI export).
 * @source
 */
export interface BedMeshStats {
  /** Highest mesh value across every cell. */
  readonly highest: number;
  /** Lowest mesh value across every cell. */
  readonly lowest: number;
  /** `highest - lowest`. */
  readonly range: number;
  /** Sample standard deviation of all cells. */
  readonly stddev: number;
  /** Sample variance of all cells. */
  readonly variance: number;
}

/**
 * Compute aggregate stats over every numeric cell in `matrix`. Non-finite
 * cells are skipped. Returns `null` when there are no numeric cells.
 *
 * @param matrix - The mesh matrix.
 * @returns The stats, or `null` when the matrix is empty / fully non-finite.
 * @source
 */
export const computeBedMeshStats = (
  matrix: readonly (readonly number[])[],
): BedMeshStats | null => {
  let n = 0;
  let highest = -Infinity;
  let lowest = Infinity;
  let sum = 0;
  for (const row of matrix) {
    for (const v of row) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (v > highest) highest = v;
      if (v < lowest) lowest = v;
      sum += v;
      n++;
    }
  }
  if (n === 0) return null;
  const mean = sum / n;
  let sq = 0;
  for (const row of matrix) {
    for (const v of row) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const d = v - mean;
      sq += d * d;
    }
  }
  const variance = sq / n;
  return {
    highest,
    lowest,
    range: highest - lowest,
    variance,
    stddev: Math.sqrt(variance),
  };
};
