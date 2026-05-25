import { Text } from 'react-curse';

import { PanelFrame } from './PanelFrame';
import type { BedMeshData } from '../hooks/useBedMesh';
import {
  DEFAULT_DOMAIN_MAX,
  DEFAULT_DOMAIN_MIN,
  interpolateMesh,
  meshValToHex,
} from '../services/bedMesh';
import { fmtFixed } from '../services/format';
import { toSubscript, toSuperscript } from '../services/unicodeCase';

/**
 * Bed mesh visualization, modeled on `bed.mesh()` /
 * `hotbed_mesh_map.awk` from moonraker-cli.
 *
 * Resolution trick (from the awk script): double the matrix in both
 * dimensions by inserting "synthetic" cells averaged from their neighbors.
 * An N×N matrix becomes (2N-1)×(2N-1). Combined with the half-block
 * compression below, this gives roughly-square visual cells against a
 * typical 2:1 terminal cell aspect.
 *
 * Half-block compression: each terminal row covers two interpolated rows
 * via `▀` (upper half block) — foreground colors the top mesh row,
 * background colors the bottom row. Odd final row uses `▀` with no
 * background. Same trick is reused for the gradient legend on the right.
 *
 * The matrix is *flipped vertically* before interpolation so the display's
 * top corresponds to the highest Y on the bed (matches bash, which `jq
 * reverse`s the matrix before piping into awk).
 */

const Y_LABEL_W = 3;
const HEAT_GAP = 3;
const GRADIENT_W = 2;
/** Reserved width (cells) for the gradient legend's numeric labels. Sized
 *  to hold "-0.500" in superscript glyphs. */
const GRADIENT_LABEL_W = 6;
/** Visual gap (cells) between the left details column and the right
 *  heatmap column. */
const SIDE_GAP = 2;
/**
 * Width (cells) reserved for each metadata row's right-justified label.
 * Tightened from the panel's old full-width layout (when it was 17)
 * because the details column now shares horizontal space with the
 * heatmap, so we have less to work with.
 */
const LABEL_COL_W = 15;

interface BedMeshPanelProps {
  readonly data: BedMeshData | null;
  readonly error?: string;
  readonly y: number;
  readonly x: number;
  readonly width: number;
  readonly height: number;
}

/** Detail rows in the left column — used by the height calculator below. */
const DETAILS_ROW_COUNT = 6;
/** Column-label rows above the heatmap (tens + ones digits). */
const COL_LABEL_ROWS = 2;
/** Top/bottom border total. */
const BORDER_ROWS = 2;
/** Loading / error state height — just enough for a centered message. */
const LOADING_PANEL_HEIGHT = 8;

/**
 * Compute the natural height (cells) the panel needs to render its
 * current data without wasted vertical space. Exposed so the App-level
 * column-layout solver can cap the panel here — bed-mesh content is
 * fixed-size for a given mesh resolution, unlike the chart / console /
 * webcam panels which scale to whatever vertical they're handed.
 *
 * Right side: column labels (2 rows) + one heatmap row per row in the
 * mesh matrix. Each terminal cell renders two interpolated rows via `▀`,
 * and interpolation expands the matrix to `2N-1` rows, so
 * `heatTermRows = ceil((2N-1)/2) = N` where `N = meshMatrix.length`.
 * Important: this is the *mesh* matrix, not the probed matrix —
 * `params.y_count` reports the probed count (e.g. 5) but the mesh
 * matrix after Klipper's Lagrange/bicubic interpolation can be much
 * larger (e.g. 13 for a 5×5 probe with 'lagrange' algorithm).
 *
 * Left side: 6 detail rows.
 *
 * Returns the larger of the two plus the border rows.
 *
 * @param data - The current bed-mesh data, or `null` when still loading.
 * @returns The exact panel height the content wants.
 * @source
 */
export const computeBedMeshPanelHeight = (data: BedMeshData | null): number => {
  if (!data) return LOADING_PANEL_HEIGHT;
  const heatmapRows = data.meshMatrix.length + COL_LABEL_ROWS;
  return Math.max(DETAILS_ROW_COUNT, heatmapRows) + BORDER_ROWS;
};

/**
 * Wrapper around {@link fmtFixed} that returns an em-dash for
 * `undefined`. The bed-mesh details surface a placeholder where the
 * stats engine couldn't compute a value.
 *
 * @param v - The value to format.
 * @param digits - Digits after the decimal point.
 * @returns The formatted number, or `'—'` when missing.
 * @source
 */
const fmt = (v: number | undefined, digits: number): string =>
  v === undefined ? '—' : fmtFixed(v, digits);

/** Width of each metadata value (right-padded) in cells. */
const VALUE_COL_W = 10;
/** Gap between the left value and the right label in a {@link MetaRow}. */
const COL_GAP = 1;

/**
 * Props for the internal {@link MetaRow} — a paired label/value row
 * with two label/value columns side-by-side. Lets the left-side details
 * area pack twice as many rows into the same vertical space.
 *
 * @source
 */
interface MetaRowProps {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly leftLabel: string;
  readonly leftValue: string;
  readonly rightLabel: string;
  readonly rightValue: string;
}

/**
 * One row in the details column: two `label: value` pairs side-by-side.
 * Right pair is optional — pass empty strings to leave it blank.
 *
 * @source
 */
const MetaRow = ({
  x,
  y,
  width,
  leftLabel,
  leftValue,
  rightLabel,
  rightValue,
}: MetaRowProps) => (
  <Text x={x} y={y} width={width} height={1} block>
    <Text x={0} color="BrightBlack" dim>
      {leftLabel.padStart(LABEL_COL_W)}:
    </Text>
    <Text x={LABEL_COL_W + 2} color="White" bold>
      {leftValue.padEnd(VALUE_COL_W)}
    </Text>
    {rightLabel !== '' && (
      <>
        <Text x={LABEL_COL_W + 2 + VALUE_COL_W + COL_GAP} color="BrightBlack" dim>
          {rightLabel.padStart(LABEL_COL_W)}:
        </Text>
        <Text
          x={LABEL_COL_W + 2 + VALUE_COL_W + COL_GAP + LABEL_COL_W + 2}
          color="White"
          bold
        >
          {rightValue}
        </Text>
      </>
    )}
  </Text>
);

export const BedMeshPanel = ({ data, error, y, x, width, height }: BedMeshPanelProps) => {
  // Border carries the title; close-hint goes in its right label.
  const frame = (
    <PanelFrame
      x={x}
      y={y}
      width={width}
      height={height}
      title="Bed Mesh"
      rightLabel="h/Esc close"
    />
  );

  if (!data) {
    return (
      <>
        <Text x={x + 2} y={y + 2} color={error ? 'Red' : 'BrightBlack'}>
          {error ?? 'Loading bed mesh…'}
        </Text>
        {frame}
      </>
    );
  }

  const { profileName, meshMatrix, params, stats } = data;
  const rawRows = meshMatrix.length;
  const rawCols = meshMatrix[0]?.length ?? 0;
  // Matches Fluidd's bed-mesh chart: the visualization domain is fixed
  // at ±0.5mm regardless of actual data range. Cells beyond that are
  // clamped to the endpoint colors (deep blue / deep red), making
  // out-of-spec areas visually obvious.
  const domainMin = DEFAULT_DOMAIN_MIN;
  const domainMax = DEFAULT_DOMAIN_MAX;

  // Flip rows so the display's top corresponds to the back of the bed
  // (highest Y), matching the bash `jq | reverse` step.
  const flipped: readonly (readonly number[])[] = [...meshMatrix].slice().reverse();

  const interp = interpolateMesh(flipped);
  const interpRows = interp.length;
  const interpCols = interp[0]?.length ?? 0;
  const colorGrid: string[][] = interp.map((row) => row.map((v) => meshValToHex(v, domainMin, domainMax)));

  // ----- Side-by-side geometry ---------------------------------------
  // Details column on the left, heatmap + gradient on the right.
  // Compute the right side's footprint first, then give the rest to
  // details. If the panel is too narrow to host the heatmap, the right
  // side still anchors to the right edge and the details column just
  // shrinks (or shows truncated values).
  const innerX = x + 1;
  const innerY = y + 1;
  const innerW = Math.max(1, width - 2);
  // Right column width: Y-axis labels + heatmap cells + gap + gradient
  // bar + label gap + gradient label text.
  const rightSideW =
    Y_LABEL_W + interpCols + HEAT_GAP + GRADIENT_W + 1 + GRADIENT_LABEL_W;
  // Anchor the right side flush against the panel's right edge.
  const rightSideX = innerX + Math.max(0, innerW - rightSideW);
  // Details column gets whatever's left of the visual gap before the
  // heatmap (floored at 0 to avoid negative widths on tiny panels).
  const detailsW = Math.max(0, rightSideX - innerX - SIDE_GAP);

  // Right-side Y geometry: 2 rows for column index labels (tens above,
  // ones below) followed by the heatmap. The heatmap and gradient
  // start at the same Y so they stay vertically aligned.
  const colLabelY1 = innerY;
  const colLabelY2 = colLabelY1 + 1;
  const heatTopY = colLabelY2 + 1;
  const heatStartX = rightSideX + Y_LABEL_W;
  const heatTermRows = Math.ceil(interpRows / 2);

  const gradientX = heatStartX + interpCols + HEAT_GAP;
  const gradientStops = interpRows;
  // Legend spans the *visualization* domain, not the data range — that
  // way the gradient bar's colors actually correspond to the values
  // shown alongside, even when data extends beyond [domainMin, domainMax].
  const gradientValues: number[] = [];
  for (let i = 0; i < gradientStops; i++) {
    const t = i / Math.max(1, gradientStops - 1);
    gradientValues.push(domainMax + (domainMin - domainMax) * t);
  }
  const gradientColors = gradientValues.map((v) => meshValToHex(v, domainMin, domainMax));
  const gradientTermRows = Math.ceil(gradientStops / 2);
  const labelX = gradientX + GRADIENT_W + 1;

  // Hard ceiling on rendered rows so the heatmap never paints past the
  // panel's bottom border (and into the system-stats strip below). When
  // the column-layout solver can't honor the panel's natural height
  // (e.g. the terminal is short and the chart is already at minHeight),
  // we get fewer rows than `computeBedMeshPanelHeight` asked for —
  // clip here rather than silently overflow.
  const maxHeatRows = Math.max(0, height - BORDER_ROWS - COL_LABEL_ROWS);
  const heatTermRowsClipped = Math.min(heatTermRows, maxHeatRows);
  const gradientTermRowsClipped = Math.min(gradientTermRows, maxHeatRows);

  // ----- Details column (left side, two-column packing) --------------
  // Same field set as the old top-of-panel layout, just relocated to
  // the left side. Six rows of `label: value | label: value`, then a
  // trailing single-value row for the odd-one-out.
  return (
    <>
      {detailsW > 0 && (
        <>
          <MetaRow
            x={innerX}
            y={innerY}
            width={detailsW}
            leftLabel="Mesh profile"
            leftValue={profileName || '—'}
            rightLabel="Algorithm"
            rightValue={params.algo ?? '—'}
          />
          <MetaRow
            x={innerX}
            y={innerY + 1}
            width={detailsW}
            leftLabel="Min coordinates"
            leftValue={`${params.min_x}/${params.min_y}`}
            rightLabel="Probed matrix"
            rightValue={`${params.x_count}x${params.y_count}`}
          />
          <MetaRow
            x={innerX}
            y={innerY + 2}
            width={detailsW}
            leftLabel="Max coordinates"
            leftValue={`${params.max_x}/${params.max_y}`}
            rightLabel="Mesh matrix"
            rightValue={`${rawCols}x${rawRows}`}
          />
          <MetaRow
            x={innerX}
            y={innerY + 3}
            width={detailsW}
            leftLabel="Probed range"
            leftValue={fmt(stats.range, 5)}
            rightLabel="Mesh highest"
            rightValue={fmt(stats.highest, 6)}
          />
          <MetaRow
            x={innerX}
            y={innerY + 4}
            width={detailsW}
            leftLabel="Std deviation"
            leftValue={fmt(stats.stddev, 5)}
            rightLabel="Mesh lowest"
            rightValue={fmt(stats.lowest, 6)}
          />
          <MetaRow
            x={innerX}
            y={innerY + 5}
            width={detailsW}
            leftLabel="Variance"
            leftValue={fmt(stats.variance, 5)}
            rightLabel=""
            rightValue=""
          />
        </>
      )}

      {/* Column index rows on the right side — two rows so double-digit
          labels stack vertically (tens above, ones below) over each
          source column. Source col `c` lands at heatStartX + c*2
          (each interpolated col is 1 char; source cols are at even
          interpolated indices). */}
      <Text x={rightSideX} y={colLabelY1} width={rightSideW} height={1} block>
        {Array.from({ length: rawCols }, (_, c) => {
          if (c < 10) return null;
          const tens = Math.floor(c / 10).toString();
          return (
            <Text key={c} x={heatStartX - rightSideX + c * 2} color="BrightBlack">
              {toSubscript(tens)}
            </Text>
          );
        })}
      </Text>
      <Text x={rightSideX} y={colLabelY2} width={rightSideW} height={1} block>
        {Array.from({ length: rawCols }, (_, c) => (
          <Text key={c} x={heatStartX - rightSideX + c * 2} color="BrightBlack">
            {toSubscript((c % 10).toString())}
          </Text>
        ))}
      </Text>

      {/* Heatmap + Y-axis labels (subscript). Each terminal row covers
          two interpolated rows via `▀`. The top half is always a source
          row (interp index 2r); odd interpolated heights leave the
          final row's bottom half empty. */}
      {Array.from({ length: heatTermRowsClipped }, (_, termRow) => {
        const topRow = termRow * 2;
        const bottomRow = topRow + 1;
        const topColors = colorGrid[topRow] ?? [];
        const bottomColors = bottomRow < interpRows ? colorGrid[bottomRow] : null;
        const yLabel = toSubscript(String(termRow).padStart(2));
        return (
          <Text
            key={termRow}
            x={rightSideX}
            y={heatTopY + termRow}
            width={rightSideW}
            height={1}
            block
          >
            <Text x={0} color="BrightBlack">
              {yLabel}
            </Text>
            {topColors.map((top, ci) => {
              const bottom = bottomColors ? bottomColors[ci] : undefined;
              return (
                <Text
                  key={ci}
                  x={heatStartX - rightSideX + ci}
                  color={top}
                  {...(bottom !== undefined ? { background: bottom } : {})}
                >
                  ▀
                </Text>
              );
            })}
          </Text>
        );
      })}

      {/* Smooth gradient legend, with superscript value labels. */}
      {Array.from({ length: gradientTermRowsClipped }, (_, gr) => {
        const topIdx = gr * 2;
        const bottomIdx = topIdx + 1;
        const top = gradientColors[topIdx];
        const labelValue = gradientValues[topIdx];
        // `gradientTermRows = ceil(gradientStops / 2)` so `topIdx`
        // always falls within `gradientColors` / `gradientValues`. The
        // guards keep `noUncheckedIndexedAccess` happy and bail
        // gracefully if those invariants ever change.
        if (top === undefined || labelValue === undefined) return null;
        const bottom = bottomIdx < gradientStops ? gradientColors[bottomIdx] : undefined;
        const rowY = heatTopY + gr;
        return (
          <Text
            key={`g${gr}`}
            x={rightSideX}
            y={rowY}
            width={rightSideW}
            height={1}
            block
          >
            <Text
              x={gradientX - rightSideX}
              color={top}
              {...(bottom !== undefined ? { background: bottom } : {})}
            >
              {'▀'.repeat(GRADIENT_W)}
            </Text>
            <Text x={labelX - rightSideX} color="White">
              {toSuperscript(fmt(labelValue, 3))}
            </Text>
          </Text>
        );
      })}
      {frame}
    </>
  );
};
