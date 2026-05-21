/**
 * Diverging colormap and value→color resolver for the bed-mesh heatmap.
 *
 * Palette is `RdYlBu_r` from ColorBrewer (11 stops) — the same set
 * Fluidd's `BedMeshChart.vue` hands to ECharts' `visualMap.inRange.color`
 * (see [Fluidd's BedMeshChart](https://github.com/fluidd-core/fluidd/blob/develop/src/components/widgets/bedmesh/BedMeshChart.vue)).
 * Mapping is linear over an explicit `[min, max]` domain, matching how
 * ECharts' continuous visualMap interprets the same input.
 *
 * Defaults follow Fluidd: domain `[-0.5, +0.5]`. Bed-mesh values outside
 * that window are clamped to the endpoint colors. Callers can override
 * the domain — useful for low-noise meshes where ±0.5 swamps the signal
 * with the central pale-yellow band.
 */

/**
 * 11-stop diverging palette in ascending-value order (lowest first).
 * Lifted verbatim from Fluidd's bed mesh chart.
 * @source
 */
export const PALETTE = [
  '#313695',
  '#4575b4',
  '#74add1',
  '#abd9e9',
  '#e0f3f8',
  '#ffffbf',
  '#fee090',
  '#fdae61',
  '#f46d43',
  '#d73027',
  '#a50026',
] as const;

/**
 * Default lower bound of the visualization domain. Values at or below
 * this map to {@link PALETTE}'s first color.
 * @source
 */
export const DEFAULT_DOMAIN_MIN = -0.5;

/**
 * Default upper bound of the visualization domain. Values at or above
 * this map to {@link PALETTE}'s last color.
 * @source
 */
export const DEFAULT_DOMAIN_MAX = 0.5;

/**
 * Cached RGB triples for {@link PALETTE} so we don't re-parse the hex on
 * every cell of every render.
 */
const PALETTE_RGB: ReadonlyArray<readonly [number, number, number]> = PALETTE.map(
  (hex): readonly [number, number, number] => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b];
  },
);

const HEX = '0123456789abcdef';

/**
 * Format a 0-255 byte as a 2-character lowercase hex string.
 *
 * @param n - Byte value.
 * @returns Two-character hex.
 * @source
 */
const hex2 = (n: number): string => HEX[(n >> 4) & 15]! + HEX[n & 15]!;

/**
 * Format an RGB triple as a `#rrggbb` hex string suitable for
 * `react-curse`'s `color` / `background` props.
 *
 * @param rgb - The triple.
 * @returns The hex string.
 * @source
 */
export const rgbHex = (rgb: readonly [number, number, number]): string =>
  `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;

/**
 * Linearly interpolate one byte channel.
 *
 * @param a - Start value.
 * @param b - End value.
 * @param t - Interpolation factor in [0, 1].
 * @returns The interpolated byte, rounded to the nearest integer.
 * @source
 */
const lerp = (a: number, b: number, t: number): number =>
  Math.round(a + (b - a) * t);

/**
 * Map a mesh value to its display color using linear interpolation
 * between adjacent {@link PALETTE} stops.
 *
 * The input value is first clamped into `[min, max]`, then normalized to
 * `[0, 1]` and used to pick the surrounding pair of stops. Returns the
 * mid-palette color when `max <= min` (degenerate domain) or when the
 * input is non-finite.
 *
 * @param v - The mesh value.
 * @param min - Lower bound of the domain. Defaults to {@link DEFAULT_DOMAIN_MIN}.
 * @param max - Upper bound of the domain. Defaults to {@link DEFAULT_DOMAIN_MAX}.
 * @returns A `#rrggbb` hex color.
 * @source
 */
export const meshValToHex = (
  v: number,
  min: number = DEFAULT_DOMAIN_MIN,
  max: number = DEFAULT_DOMAIN_MAX,
): string => {
  if (!Number.isFinite(v) || max <= min) {
    return PALETTE[Math.floor(PALETTE.length / 2)]!;
  }
  const t = Math.max(0, Math.min(1, (v - min) / (max - min)));
  const scaled = t * (PALETTE_RGB.length - 1);
  const idx = Math.floor(scaled);
  if (idx >= PALETTE_RGB.length - 1) return PALETTE[PALETTE.length - 1]!;
  const frac = scaled - idx;
  const a = PALETTE_RGB[idx]!;
  const b = PALETTE_RGB[idx + 1]!;
  return rgbHex([
    lerp(a[0], b[0], frac),
    lerp(a[1], b[1], frac),
    lerp(a[2], b[2], frac),
  ]);
};
