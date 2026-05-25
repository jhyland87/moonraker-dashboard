import { Text } from 'react-curse';

import { PanelFrame } from './PanelFrame';
import { ThumbnailDisplay } from './ThumbnailDisplay';
import type { PrintStatus } from '../hooks/usePrintStatus';
import { fmtDuration, truncate } from '../services/format';

/**
 * 5-line print-status panel modeled after `_status_temps_panel_lines` in
 * status.sh:
 *   ┌──────────────────────────────────┐
 *   │ Print Status                     │  (bold + underline header)
 *   │ File:     <name>                 │
 *   │ State:    <state>    Layer:   X/Y│  (two-column)
 *   │ Progress: NN%        Filament:T/U│  (two-column)
 *   │ Elapsed:  Hm Ms                  │
 *   │ ETA:      Hm Ms                  │
 *   └──────────────────────────────────┘
 *
 * Idle/standby renders a shorter "State: Idle / Last: filename" form.
 */

/**
 * Number of vertical rows the panel always occupies — used by App.tsx to
 * reserve space below the panel for the temperature chart.
 *
 * Breakdown: top border (1) + 5 data rows + bottom border (1) = 7.
 * @source
 */
export const PRINT_PANEL_HEIGHT = 7;

/** Width (in chars) of the bold label column. */
const LABEL_W = 9;
const PANEL_MIN = 40;
const PANEL_MAX = 70;
const PANEL_GAP = 4;

/**
 * Minimum width the panel will accept before
 * {@link computePanelGeometry} declines to render. Exported for layout
 * planners outside this module.
 * @source
 */
export const PRINT_PANEL_MIN = PANEL_MIN;

/**
 * Horizontal gap (chars) the panel expects between itself and its left
 * neighbor.
 * @source
 */
export const PRINT_PANEL_GAP = PANEL_GAP;

/**
 * Resolved geometry for placing the panel.
 * @source
 */
export interface PanelGeometry {
  readonly width: number;
  readonly x: number;
}

/**
 * Compute the panel's right-aligned width and x-offset given the screen
 * geometry and a fixed `tableWidth` to its left.
 *
 * Returns `null` when the screen is too narrow to satisfy {@link PRINT_PANEL_MIN}.
 *
 * @param termWidth - Total terminal width.
 * @param tableWidth - Width occupied by content to the panel's left.
 * @returns Geometry or `null`.
 * @source
 */
export const computePanelGeometry = (
  termWidth: number,
  tableWidth: number,
): PanelGeometry | null => {
  let width = termWidth - tableWidth - PANEL_GAP;
  if (width > PANEL_MAX) width = PANEL_MAX;
  if (width < PANEL_MIN) return null;
  return { width, x: termWidth - width };
};

/**
 * Strip a leading directory prefix from a path-like string.
 *
 * @param path - The path or filename (may already be a bare name).
 * @returns The basename (everything after the last `/`).
 * @source
 */
const basename = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
};

/**
 * Width (in cells) reserved on the right of the panel for the gcode
 * thumbnail, when one is available. Sized to host a roughly-square
 * preview (terminal cells are ~2:1, so 10 cells wide × 5 cells tall
 * displays a square image). One extra cell of left-padding separates
 * the thumbnail from the text column.
 */
const THUMBNAIL_W = 10;
const THUMBNAIL_H = 5;
const THUMBNAIL_PAD = 1;
/** Total cells the thumbnail slot consumes from the inner content area. */
const THUMBNAIL_SLOT = THUMBNAIL_W + THUMBNAIL_PAD;

/**
 * Props for {@link PrintStatusPanel}.
 * @source
 */
interface PrintStatusPanelProps {
  readonly status: PrintStatus;
  /**
   * PNG bytes from {@link useThumbnail} for the currently-loaded gcode.
   * When non-null and the terminal supports inline images (iTerm2), the
   * panel reserves {@link THUMBNAIL_SLOT} cells on the right and draws
   * the thumbnail there. Text columns shrink to fit the remainder.
   * `null` (no print loaded, or fetch failed) → text uses the full width.
   */
  readonly thumbnail?: Buffer | null;
  readonly y: number;
  readonly width: number;
  readonly x: number;
}

/**
 * Props for the internal {@link OneColRow}: single label + single value
 * spanning the full panel width.
 * @source
 */
interface OneColRowProps {
  readonly y: number;
  readonly x: number;
  readonly width: number;
  readonly label: string;
  readonly value: string;
}

/**
 * One-column metadata row. Used by full-width fields like `File:` and
 * `Elapsed:`.
 * @source
 */
const OneColRow = ({ y, x, width, label, value }: OneColRowProps) => {
  const valWidth = width - LABEL_W - 2;
  return (
    <Text x={x} y={y} width={width} height={1} block>
      <Text x={0} color="Yellow" bold>
        {label.padEnd(LABEL_W)}
      </Text>
      <Text x={LABEL_W + 1} color="White">
        {truncate(value, valWidth).padEnd(valWidth)}
      </Text>
    </Text>
  );
};

/**
 * Props for the internal {@link TwoColRow}: two label/value pairs split
 * across the width.
 * @source
 */
interface TwoColRowProps {
  readonly y: number;
  readonly x: number;
  readonly width: number;
  readonly labelL: string;
  readonly valueL: string;
  readonly labelR: string;
  readonly valueR: string;
}

/**
 * Two-column metadata row. Used for pairs like `State:` + `Layer:` that
 * fit naturally side-by-side.
 * @source
 */
const TwoColRow = ({ y, x, width, labelL, valueL, labelR, valueR }: TwoColRowProps) => {
  const lW = Math.floor((width - 22) / 2);
  const rW = width - 22 - lW;
  return (
    <Text x={x} y={y} width={width} height={1} block>
      <Text x={0} color="Yellow" bold>
        {labelL.padEnd(LABEL_W)}
      </Text>
      <Text x={LABEL_W + 1} color="White">
        {truncate(valueL, lW).padEnd(lW)}
      </Text>
      <Text x={LABEL_W + 1 + lW + 1} color="Yellow" bold>
        {labelR.padEnd(LABEL_W)}
      </Text>
      <Text x={LABEL_W + 1 + lW + 1 + LABEL_W + 1} color="White">
        {truncate(valueR, rW).padEnd(rW)}
      </Text>
    </Text>
  );
};

/**
 * Render a 7-row print-job summary panel (1 top border + 5 data rows + 1
 * bottom border).
 *
 * When the printer is idle/standby/complete, the panel shrinks to a
 * "State: Idle / Last: <filename>" form. While printing or paused, the
 * full File / State+Layer / Progress+Filament / Elapsed / ETA layout
 * shows.
 *
 * @param props - See {@link PrintStatusPanelProps}.
 * @returns The panel element.
 * @source
 */
export const PrintStatusPanel = ({ status, thumbnail, y, width, x }: PrintStatusPanelProps) => {
  const file = status.filename ? basename(status.filename) : '—';
  const stateLabel = status.state === 'unknown' ? '—' : status.state;
  const isActive = status.state === 'printing' || status.state === 'paused';
  // Content rows are inset by 1 column on each side so the side bars of
  // PanelFrame (rendered last so its strokes win at the edge columns) sit
  // in margin space the row's block-fill doesn't touch.
  const innerX = x + 1;
  const innerWFull = Math.max(1, width - 2);
  // When a thumbnail is available AND the panel is wide enough to make
  // room, shrink the text column to leave a slot on the right for the
  // image. Falls back to full-width text otherwise so a tiny terminal
  // still gets all the status info.
  const hasThumbnail = thumbnail !== null && thumbnail !== undefined;
  const showThumbnail = hasThumbnail && innerWFull > THUMBNAIL_SLOT + 20;
  const innerW = showThumbnail ? innerWFull - THUMBNAIL_SLOT : innerWFull;
  const thumbnailX = x + width - 1 - THUMBNAIL_W;
  const thumbnailY = y + 1;
  const frame = (
    <PanelFrame x={x} y={y} width={width} height={PRINT_PANEL_HEIGHT} title="Print Status" />
  );
  const thumbEl = showThumbnail ? (
    <ThumbnailDisplay
      buffer={thumbnail}
      x={thumbnailX}
      y={thumbnailY}
      width={THUMBNAIL_W}
      height={THUMBNAIL_H}
    />
  ) : null;

  if (!isActive) {
    return (
      <>
        <OneColRow x={innerX} y={y + 1} width={innerW} label="State:" value={stateLabel === '—' ? 'Idle' : stateLabel} />
        <OneColRow x={innerX} y={y + 2} width={innerW} label="Last:" value={file} />
        <OneColRow x={innerX} y={y + 3} width={innerW} label="" value="" />
        <OneColRow x={innerX} y={y + 4} width={innerW} label="" value="" />
        <OneColRow x={innerX} y={y + 5} width={innerW} label="" value="" />
        {thumbEl}
        {frame}
      </>
    );
  }

  const pct =
    status.progress !== undefined ? `${(status.progress * 100).toFixed(1)}%` : '—';
  const layer =
    status.currentLayer !== undefined && status.totalLayers !== undefined
      ? `${status.currentLayer}/${status.totalLayers}`
      : '—';
  const filament =
    status.filamentTotalMm !== undefined && status.filamentUsedMm !== undefined
      ? `${Math.round(status.filamentUsedMm)}mm/${Math.round(status.filamentTotalMm)}mm`
      : status.filamentUsedMm !== undefined
        ? `${Math.round(status.filamentUsedMm)}mm`
        : '—';

  return (
    <>
      <OneColRow x={innerX} y={y + 1} width={innerW} label="File:" value={file} />
      <TwoColRow
        x={innerX}
        y={y + 2}
        width={innerW}
        labelL="State:"
        valueL={stateLabel}
        labelR="Layer:"
        valueR={layer}
      />
      <TwoColRow
        x={innerX}
        y={y + 3}
        width={innerW}
        labelL="Progress:"
        valueL={pct}
        labelR="Filament:"
        valueR={filament}
      />
      <OneColRow x={innerX} y={y + 4} width={innerW} label="Elapsed:" value={fmtDuration(status.elapsedSec)} />
      <OneColRow x={innerX} y={y + 5} width={innerW} label="ETA:" value={fmtDuration(status.remainingSec)} />
      {thumbEl}
      {frame}
    </>
  );
};
