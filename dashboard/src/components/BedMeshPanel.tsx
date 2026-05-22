import { Text } from 'react-curse';

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
const HEADER_ROWS = 7; // panel header (1) + 6 metadata rows

interface BedMeshPanelProps {
  readonly data: BedMeshData | null;
  readonly error?: string;
  readonly y: number;
  readonly x: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Wrapper around {@link fmtFixed} that returns an empty string for
 * `undefined`. The bed-mesh metadata grid prefers showing nothing rather
 * than the em-dash placeholder when a value is missing.
 *
 * @param v - The value to format.
 * @param digits - Digits after the decimal point.
 * @returns Either the formatted number, or `''` when missing.
 * @source
 */
const fmt = (v: number | undefined, digits: number): string =>
  v === undefined ? '' : fmtFixed(v, digits);

/**
 * Props for the internal {@link MetaRow} two-column metadata row.
 * @source
 */
interface MetaRowProps {
  readonly y: number;
  readonly x: number;
  readonly width: number;
  readonly leftLabel: string;
  readonly leftValue: string;
  readonly rightLabel: string;
  readonly rightValue: string;
}

const LABEL_COL_W = 17;
const VALUE_COL_W = 12;
const COL_GAP = 4;

const MetaRow = ({ y, x, width, leftLabel, leftValue, rightLabel, rightValue }: MetaRowProps) => (
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
        <Text x={LABEL_COL_W + 2 + VALUE_COL_W + COL_GAP + LABEL_COL_W + 2} color="White" bold>
          {rightValue}
        </Text>
      </>
    )}
  </Text>
);

export const BedMeshPanel = ({ data, error, y, x, width, height }: BedMeshPanelProps) => {
  const header = (
    <Text x={x} y={y} width={width} height={1} block background="BrightBlack">
      <Text x={1} color="White" bold>
        Bed Mesh
      </Text>
      <Text x="100%-14" color="White" dim>
        h/Esc close
      </Text>
    </Text>
  );

  if (!data) {
    return (
      <>
        {header}
        <Text x={x + 2} y={y + 2} color={error ? 'Red' : 'BrightBlack'}>
          {error ?? 'Loading bed mesh…'}
        </Text>
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
  const ir = interp.length;
  const ic = interp[0]?.length ?? 0;
  const colorGrid: string[][] = interp.map((row) => row.map((v) => meshValToHex(v, domainMin, domainMax)));

  // Geometry.
  const colLabelY1 = y + HEADER_ROWS; // tens digit row (or just blank for single-digit cols)
  const colLabelY2 = colLabelY1 + 1; // ones digit row
  const heatTopY = colLabelY2 + 1;
  const heatStartX = x + 1 + Y_LABEL_W; // panel pad + Y label column
  const heatTermRows = Math.ceil(ir / 2);

  // Gradient legend — same half-block trick as the heatmap so the bar
  // reads as a smooth color sweep. Matches heatmap height visually.
  const gradientX = heatStartX + ic + HEAT_GAP;
  const gradientStops = ir;
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

  // Avoid an "unused" warning on `height` while keeping it in the API for
  // future use (e.g., abort rendering if the panel is too short).
  void height;

  return (
    <>
      {header}
      <MetaRow
        x={x + 1}
        y={y + 1}
        width={width - 2}
        leftLabel="Mesh profile"
        leftValue={profileName || '—'}
        rightLabel="Algorithm"
        rightValue={params.algo ?? '—'}
      />
      <MetaRow
        x={x + 1}
        y={y + 2}
        width={width - 2}
        leftLabel="Min coordinates"
        leftValue={`${params.min_x}/${params.min_y}`}
        rightLabel="Probed matrix"
        rightValue={`${params.x_count}x${params.y_count}`}
      />
      <MetaRow
        x={x + 1}
        y={y + 3}
        width={width - 2}
        leftLabel="Max coordinates"
        leftValue={`${params.max_x}/${params.max_y}`}
        rightLabel="Mesh matrix"
        rightValue={`${rawCols}x${rawRows}`}
      />
      <MetaRow
        x={x + 1}
        y={y + 4}
        width={width - 2}
        leftLabel="Probed range"
        leftValue={fmt(stats.range, 5)}
        rightLabel="Mesh highest"
        rightValue={fmt(stats.highest, 6)}
      />
      <MetaRow
        x={x + 1}
        y={y + 5}
        width={width - 2}
        leftLabel="Std deviation"
        leftValue={fmt(stats.stddev, 5)}
        rightLabel="Mesh lowest"
        rightValue={fmt(stats.lowest, 6)}
      />
      <MetaRow
        x={x + 1}
        y={y + 6}
        width={width - 2}
        leftLabel="Variance"
        leftValue={fmt(stats.variance, 5)}
        rightLabel=""
        rightValue=""
      />

      {/* Column index rows — two rows so double-digit labels stack vertically
          (tens digit on top, ones digit below) above each source column.
          Source col `c` lands at heat-start-x + c*2 (each interpolated col is
          1 char; source cols are at even interpolated indices). */}
      <Text x={x} y={colLabelY1} width={width} height={1} block>
        {Array.from({ length: rawCols }, (_, c) => {
          if (c < 10) return null;
          const tens = Math.floor(c / 10).toString();
          return (
            <Text key={c} x={heatStartX - x + c * 2} color="BrightBlack">
              {toSubscript(tens)}
            </Text>
          );
        })}
      </Text>
      <Text x={x} y={colLabelY2} width={width} height={1} block>
        {Array.from({ length: rawCols }, (_, c) => (
          <Text key={c} x={heatStartX - x + c * 2} color="BrightBlack">
            {toSubscript((c % 10).toString())}
          </Text>
        ))}
      </Text>

      {/* Heatmap + Y-axis labels (subscript). Each terminal row covers two
          interpolated rows via `▀`. The top half is always a source row
          (interp index 2r); odd interpolated heights leave the final row's
          bottom half empty. */}
      {Array.from({ length: heatTermRows }, (_, termRow) => {
        const topRow = termRow * 2;
        const bottomRow = topRow + 1;
        const topColors = colorGrid[topRow] ?? [];
        const bottomColors = bottomRow < ir ? colorGrid[bottomRow] : null;
        const yLabel = toSubscript(String(termRow).padStart(2));
        return (
          <Text key={termRow} x={x} y={heatTopY + termRow} width={width} height={1} block>
            <Text x={1} color="BrightBlack">
              {yLabel}
            </Text>
            {topColors.map((top, ci) => {
              const bottom = bottomColors ? bottomColors[ci] : undefined;
              return (
                <Text
                  key={ci}
                  x={heatStartX - x + ci}
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

      {/* Smooth gradient legend, with subscript value labels. */}
      {Array.from({ length: gradientTermRows }, (_, gr) => {
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
          <Text key={`g${gr}`} x={x} y={rowY} width={width} height={1} block>
            <Text
              x={gradientX - x}
              color={top}
              {...(bottom !== undefined ? { background: bottom } : {})}
            >
              {'▀'.repeat(GRADIENT_W)}
            </Text>
            <Text x={labelX - x} color="White">
              {toSuperscript(fmt(labelValue, 3))}
            </Text>
          </Text>
        );
      })}
    </>
  );
};
