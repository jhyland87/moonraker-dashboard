import { SENSOR_TABLE_WIDTH } from '../components/SensorTable';
import type {
  Dimension,
  DimensionSpec,
  HeaderPanelLayoutEntry,
  HeaderSlotKind,
} from '../config/index';

/**
 * Resolved geometry for a single header slot — its x position and width
 * in the rendered top row.
 * @source
 */
export interface SlotGeometry {
  readonly kind: HeaderSlotKind;
  readonly x: number;
  readonly width: number;
}

/**
 * Per-component intrinsic width policy. `preferred` is what the panel
 * gets when the user writes `width: 'auto'` (or omits width entirely).
 * `min` / `max` are the floor / ceiling the panel can render at without
 * looking broken; user-supplied `min` / `max` override these.
 *
 * Keeping the table here (rather than threading constants through every
 * panel file) means the dashboard's geometry layer has *one* place to
 * look at when something looks off.
 * @source
 */
export const HEADER_DEFAULTS = {
  'sensor-table': {
    preferred: SENSOR_TABLE_WIDTH,
    min: SENSOR_TABLE_WIDTH,
    max: SENSOR_TABLE_WIDTH,
  },
  'print-status': { preferred: 70, min: 40, max: 70 },
  'system-stats': { preferred: 60, min: 36, max: 60 },
} as const satisfies Readonly<
  Record<HeaderSlotKind, { preferred: number; min: number; max: number }>
>;

/**
 * Horizontal gap, in character cells, between adjacent header slots.
 * @source
 */
export const HEADER_SLOT_GAP = 4;

/**
 * Normalize a width shorthand (`number`, `"NN%"`, or `"auto"`) or a
 * verbose {@link DimensionSpec} object into a {@link DimensionSpec}.
 *
 * @param v - The user-supplied dimension or undefined.
 * @returns A DimensionSpec (empty when the caller passed undefined).
 * @source
 */
const toSpec = (v: Dimension | DimensionSpec | undefined): DimensionSpec => {
  if (v === undefined) return {};
  if (typeof v === 'number' || typeof v === 'string') return { value: v };
  return v;
};

/**
 * Resolve a {@link Dimension} value into a concrete cell count for the
 * given parent width.
 *
 * - `undefined` or `'auto'` → `componentDefault`.
 * - A number → returned unchanged.
 * - A `"NN%"` string → `floor(NN / 100 * parentWidth)`.
 *
 * @param value - The dimension to resolve.
 * @param parentWidth - Width that percentages are interpreted against.
 * @param componentDefault - Fallback for `auto` / missing values.
 * @returns The resolved cell count.
 * @source
 */
export const resolveDimensionToCells = (
  value: Dimension | undefined,
  parentWidth: number,
  componentDefault: number,
): number => {
  if (value === undefined || value === 'auto') return componentDefault;
  if (typeof value === 'number') return value;
  // String of the form 'NN%'. Anything else is treated as a parse failure
  // and falls back to the component default.
  const match = /^(-?\d+(?:\.\d+)?)%$/.exec(value);
  // `match[1]` is the captured group; the regex guarantees it's present
  // when `match` is non-null, but `noUncheckedIndexedAccess` still types
  // it as `string | undefined`. Read it through a local + guard.
  const captured = match?.[1];
  if (captured === undefined) return componentDefault;
  // Google style prefers `Number()` + `Number.isFinite` over `parseFloat`,
  // which silently accepts trailing garbage (`parseFloat('1abc') === 1`).
  // Our regex already strips the `%`, so a clean Number() is appropriate.
  const pct = Number(captured);
  if (!Number.isFinite(pct)) return componentDefault;
  return Math.max(0, Math.floor((pct / 100) * parentWidth));
};

/**
 * Compute a left-to-right header layout for the given entry list and
 * terminal width.
 *
 * Algorithm (single pass, greedy):
 *   1. Deduplicate entries by `component`, preserving the first occurrence.
 *   2. For each entry in order:
 *      - Resolve its width to a target cell count via the user's spec
 *        and the per-component defaults (`HEADER_DEFAULTS`).
 *      - Clamp the result to the user's `min` / `max` (falling back to
 *        the component defaults).
 *      - Place the panel immediately after the previous one, separated by
 *        {@link HEADER_SLOT_GAP}.
 *      - Drop the panel (and everything after) if even `min` doesn't fit.
 *
 * Width values are interpreted as follows:
 *   - `width: 70` → fixed 70 cells (subject to `min` / `max`).
 *   - `width: '40%'` → 40% of the terminal width.
 *   - `width: 'auto'` (default) → component's intrinsic preferred width.
 *   - `width: { value, min, max }` → verbose form.
 *
 * @param termWidth - Available terminal width in character cells.
 * @param entries - Configured header entries (from `DashboardConfig.layout.header`).
 * @returns Geometry per surviving slot, in render order.
 * @source
 */
export const computeHeaderLayout = (
  termWidth: number,
  entries: readonly HeaderPanelLayoutEntry[],
): readonly SlotGeometry[] => {
  // Dedupe by component, keep first occurrence.
  const seen = new Set<HeaderSlotKind>();
  const ordered: HeaderPanelLayoutEntry[] = [];
  for (const e of entries) {
    if (!seen.has(e.component)) {
      seen.add(e.component);
      ordered.push(e);
    }
  }

  const out: SlotGeometry[] = [];
  let x = 0;
  // `forEach` would prevent early termination — we need a real loop to
  // bail when a slot can't fit. Iterate via `entries()` so the index
  // (for first-slot gap suppression) and the entry value flow together
  // without indexed-access reads.
  for (const [i, entry] of ordered.entries()) {
    const defaults = HEADER_DEFAULTS[entry.component];
    const spec = toSpec(entry.width);
    const min = spec.min ?? defaults.min;
    const max = spec.max ?? defaults.max;
    const preferred = resolveDimensionToCells(spec.value, termWidth, defaults.preferred);
    // Clamp preferred into [min, max].
    const clamped = Math.min(Math.max(preferred, min), max);

    const gap = i === 0 ? 0 : HEADER_SLOT_GAP;
    const remaining = termWidth - (x + gap);
    if (remaining < min) break;
    x += gap;
    // Don't reach past the right edge of the terminal even if the spec
    // asked for more (e.g. `width: 9999`); cap at remaining.
    const width = Math.min(clamped, remaining);
    out.push({ kind: entry.component, x, width });
    x += width;
  }
  return out;
};

/**
 * Look up a slot's resolved geometry by kind from a layout result.
 * Returns `null` when that kind didn't make the cut.
 *
 * @param layout - The result of {@link computeHeaderLayout}.
 * @param kind - The slot kind to find.
 * @returns The geometry, or `null` if not present.
 * @source
 */
export const findSlot = (
  layout: readonly SlotGeometry[],
  kind: HeaderSlotKind,
): SlotGeometry | null => layout.find((s) => s.kind === kind) ?? null;
