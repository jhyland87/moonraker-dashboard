/**
 * Pure resolution-doubling helper for bed-mesh visualization. Replicates
 * the synthetic-row/column averaging from `hotbed_mesh_map.awk` so the
 * bash CLI and this dashboard render bed meshes the same way.
 *
 * Kept as a separate module so vitest can exercise it without instantiating
 * the React component.
 */

/**
 * Insert a synthetic averaged cell between every adjacent pair of cells
 * in both axes, turning an `N×M` matrix into a `(2N-1)×(2M-1)` matrix.
 *
 * Original cells land on even output indices; synthetic cells fill the
 * odd indices and are the arithmetic mean of their two neighbors.
 * Corner synthetic cells (odd row AND odd column) average their two
 * vertical neighbors, which after the first pass are themselves averages
 * of horizontal neighbors — net effect is the four-cell mean.
 *
 * Returns an empty array when the input has any zero-length dimension.
 *
 * @param matrix - Source 2D matrix.
 * @returns The interpolated matrix.
 * @source
 */
export const interpolateMesh = (
  matrix: readonly (readonly number[])[],
): number[][] => {
  const rows = matrix.length;
  const cols = matrix[0]?.length ?? 0;
  if (rows === 0 || cols === 0) return [];
  const newRows = rows * 2 - 1;
  const newCols = cols * 2 - 1;
  // Avoid `new Array(newCols)` per the Google style guide — it produces
  // a sparse array. `Array.from` gives a dense one.
  const out: number[][] = Array.from({ length: newRows }, () =>
    Array.from<number>({ length: newCols }).fill(0),
  );
  // Place originals + horizontal synthetic columns on even rows.
  // Use forEach so the row variable is a plain `number[]` (not
  // `number[] | undefined`) at each iteration, avoiding indexed-access
  // reads that would otherwise need non-null assertions.
  matrix.forEach((srcRow, r) => {
    const dstRow = out[r * 2];
    if (dstRow === undefined) return;
    for (let c = 0; c < cols; c++) {
      const v = srcRow[c];
      if (v === undefined) continue;
      dstRow[c * 2] = v;
    }
    for (let c = 0; c < cols - 1; c++) {
      const a = srcRow[c];
      const b = srcRow[c + 1];
      if (a === undefined || b === undefined) continue;
      dstRow[c * 2 + 1] = (a + b) / 2;
    }
  });
  // Fill synthetic rows as the mean of the rows above and below.
  for (let r = 0; r < rows - 1; r++) {
    const above = out[r * 2];
    const below = out[(r + 1) * 2];
    const mid = out[r * 2 + 1];
    if (above === undefined || below === undefined || mid === undefined) continue;
    for (let c = 0; c < newCols; c++) {
      const a = above[c];
      const b = below[c];
      if (a === undefined || b === undefined) continue;
      mid[c] = (a + b) / 2;
    }
  }
  return out;
};
