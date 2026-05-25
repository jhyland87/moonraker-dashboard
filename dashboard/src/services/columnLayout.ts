/**
 * @fileoverview Vertical layout solver for one column of stacked panels.
 *
 * The dashboard splits the screen into two columns (Fluidd-style); each
 * column is a stack of panels with one of two height behaviors:
 *
 * - **Fixed**: panel claims a known number of rows (e.g. PrintStatusPanel
 *   is always 7 rows tall — its content is fully prescribed).
 * - **Flexible**: panel grows/shrinks to consume the remaining space after
 *   fixed panels claim theirs. Multiple flexibles in the same column
 *   share that remainder equally, bounded below by `minHeight`.
 *
 * Toggling a panel's visibility re-runs the solver, so chart / bed-mesh /
 * webcam / console naturally rescale as the user hides or shows
 * neighbors without any per-panel resize choreography.
 */

/**
 * Input spec for one panel in a column.
 *
 * @source
 */
export interface PanelSpec {
  /** Stable identifier — used as the key in the returned position map. */
  readonly id: string;
  /**
   * Fixed row count when the panel has a known size (`undefined` for
   * flexible panels). When set, `minHeight` / `maxHeight` are ignored —
   * the panel always gets exactly this many rows.
   */
  readonly fixedHeight?: number;
  /**
   * Minimum row count for flexible panels. The solver still gives flexible
   * panels at least this many rows even when the column is short — if the
   * column is *too* short to satisfy every visible panel's minimum, callers
   * can detect overflow by comparing the solved total to the input total.
   * Defaults to `1`.
   */
  readonly minHeight?: number;
  /**
   * Maximum row count for flexible panels — used for content whose
   * natural height is fixed (bed-mesh heatmap, etc). When the equal-share
   * allocation would exceed this, the panel is capped at `maxHeight` and
   * the surplus is redistributed across the other (uncapped) flexibles.
   * Omit on truly elastic panels (chart, console, webcam) that should
   * always take whatever vertical space is offered.
   */
  readonly maxHeight?: number;
}

/**
 * Solved geometry for one panel — its top-row offset within the column and
 * the row count it should render at.
 *
 * @source
 */
export interface PanelLayout {
  readonly y: number;
  readonly height: number;
}

/**
 * Solve a single column. Returns a map keyed by `PanelSpec.id` so callers
 * can look up positions by name regardless of input order.
 *
 * Algorithm:
 *  1. Sum every fixed panel's `fixedHeight`.
 *  2. The remainder (`total - fixedSum`) goes to flexibles. Each gets
 *     `floor(remainder / flexibleCount)`; the last one absorbs the
 *     rounding remainder so the column ends exactly at `total`.
 *  3. If any flexible's share dips below its `minHeight`, it claims its
 *     minimum and the deficit comes out of the *other* flexibles' shares
 *     (which may in turn drop below their own minimum — the column is
 *     simply too short). No panel is ever dropped; the caller chooses
 *     what to do about overflow.
 *
 * @param panels - Panels in the order they should stack, top to bottom.
 * @param total - Total vertical rows the column can occupy.
 * @returns A map of `panelId → { y, height }` plus the computed total
 *   so callers can detect overflow vs the input `total`.
 *
 * @example
 * ```ts
 * const layout = solveColumn(
 *   [
 *     { id: 'header', fixedHeight: 7 },
 *     { id: 'chart',  minHeight: 10 },
 *     { id: 'mesh',   minHeight: 12 },
 *   ],
 *   40,
 * );
 * // layout.positions.get('header') → { y: 0, height: 7 }
 * // layout.positions.get('chart')  → { y: 7, height: 16 }
 * // layout.positions.get('mesh')   → { y: 23, height: 17 }
 * ```
 *
 * @source
 */
export const solveColumn = (
  panels: readonly PanelSpec[],
  total: number,
): { positions: ReadonlyMap<string, PanelLayout>; usedHeight: number } => {
  const positions = new Map<string, PanelLayout>();
  if (panels.length === 0) return { positions, usedHeight: 0 };

  // Step 1: classify.
  let fixedSum = 0;
  const flexibles: PanelSpec[] = [];
  for (const p of panels) {
    if (p.fixedHeight !== undefined) {
      fixedSum += Math.max(0, p.fixedHeight);
    } else {
      flexibles.push(p);
    }
  }
  const remainder = Math.max(0, total - fixedSum);

  // Step 2: iteratively cap flexibles that exceed their `maxHeight`,
  // returning the surplus to the uncapped pool. Each iteration recomputes
  // the per-flexible share against the shrinking budget; the loop stops
  // when an iteration caps no new panels (either everyone fits under
  // their cap, or no maxHeight was specified anywhere).
  //
  // The settled heights end up in `heights`; remaining flexibles go in
  // `unsettled` for the final equal-share pass.
  const heights = new Map<string, number>();
  let budget = remainder;
  let unsettled = [...flexibles];
  // Bounded loop — every iteration removes at least one panel from
  // `unsettled` (or breaks), so we can never exceed `flexibles.length`.
  for (let iter = 0; iter <= flexibles.length; iter++) {
    if (unsettled.length === 0) break;
    const share = Math.floor(budget / unsettled.length);
    const newlyCapped = unsettled.filter(
      (p) => p.maxHeight !== undefined && share >= p.maxHeight,
    );
    if (newlyCapped.length === 0) break;
    for (const p of newlyCapped) {
      // maxHeight is defined here (we filtered for it); the non-null
      // assertion would be safer expressed with a fallback.
      const capped = p.maxHeight ?? 0;
      const h = Math.max(p.minHeight ?? 1, capped);
      heights.set(p.id, h);
      budget -= h;
    }
    unsettled = unsettled.filter((p) => !heights.has(p.id));
  }

  // Step 3: distribute whatever's left equally among uncapped flexibles.
  // The last one absorbs rounding so the column ends exactly at `total`.
  if (unsettled.length > 0) {
    const share = Math.floor(budget / unsettled.length);
    let assigned = 0;
    for (let i = 0; i < unsettled.length; i++) {
      const p = unsettled[i];
      if (p === undefined) continue;
      const isLast = i === unsettled.length - 1;
      const base = isLast ? Math.max(0, budget - assigned) : share;
      heights.set(p.id, Math.max(p.minHeight ?? 1, base));
      if (!isLast) assigned += share;
    }
  }

  // Step 4: emit positions in input order.
  let y = 0;
  let usedHeight = 0;
  for (const p of panels) {
    const h =
      p.fixedHeight !== undefined
        ? Math.max(0, p.fixedHeight)
        : heights.get(p.id) ?? Math.max(0, p.minHeight ?? 1);
    positions.set(p.id, { y, height: h });
    y += h;
    usedHeight += h;
  }
  return { positions, usedHeight };
};
