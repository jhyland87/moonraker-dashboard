import { Text } from 'react-curse';

import type { PrintStatus } from '../hooks/usePrintStatus';

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

export const PRINT_PANEL_HEIGHT = 6;

const LABEL_W = 9;
const PANEL_MIN = 40;
const PANEL_MAX = 70;
const PANEL_GAP = 4;

export const PRINT_PANEL_MIN = PANEL_MIN;
export const PRINT_PANEL_GAP = PANEL_GAP;

export interface PanelGeometry {
  readonly width: number;
  readonly x: number;
}

/** Compute the panel's visible width and x-offset given the screen geometry. */
export const computePanelGeometry = (
  termWidth: number,
  tableWidth: number,
): PanelGeometry | null => {
  let width = termWidth - tableWidth - PANEL_GAP;
  if (width > PANEL_MAX) width = PANEL_MAX;
  if (width < PANEL_MIN) return null;
  return { width, x: termWidth - width };
};

const fmtDuration = (sec: number | undefined): string => {
  if (sec === undefined || sec <= 0) return '—';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
};

const basename = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
};

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 3))}...`;

interface PrintStatusPanelProps {
  readonly status: PrintStatus;
  readonly y: number;
  readonly width: number;
  readonly x: number;
}

interface OneColRowProps {
  readonly y: number;
  readonly x: number;
  readonly width: number;
  readonly label: string;
  readonly value: string;
}

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

interface TwoColRowProps {
  readonly y: number;
  readonly x: number;
  readonly width: number;
  readonly labelL: string;
  readonly valueL: string;
  readonly labelR: string;
  readonly valueR: string;
}

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

const HeaderRow = ({ x, y, width }: { x: number; y: number; width: number }) => (
  <Text x={x} y={y} width={width} height={1} block bold underline>
    <Text x={0}>{'Print Status'.padEnd(width)}</Text>
  </Text>
);

export const PrintStatusPanel = ({ status, y, width, x }: PrintStatusPanelProps) => {
  const file = status.filename ? basename(status.filename) : '—';
  const stateLabel = status.state === 'unknown' ? '—' : status.state;
  const isActive = status.state === 'printing' || status.state === 'paused';

  if (!isActive) {
    return (
      <>
        <HeaderRow x={x} y={y} width={width} />
        <OneColRow x={x} y={y + 1} width={width} label="State:" value={stateLabel === '—' ? 'Idle' : stateLabel} />
        <OneColRow x={x} y={y + 2} width={width} label="Last:" value={file} />
        <OneColRow x={x} y={y + 3} width={width} label="" value="" />
        <OneColRow x={x} y={y + 4} width={width} label="" value="" />
        <OneColRow x={x} y={y + 5} width={width} label="" value="" />
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
      <HeaderRow x={x} y={y} width={width} />
      <OneColRow x={x} y={y + 1} width={width} label="File:" value={file} />
      <TwoColRow
        x={x}
        y={y + 2}
        width={width}
        labelL="State:"
        valueL={stateLabel}
        labelR="Layer:"
        valueR={layer}
      />
      <TwoColRow
        x={x}
        y={y + 3}
        width={width}
        labelL="Progress:"
        valueL={pct}
        labelR="Filament:"
        valueR={filament}
      />
      <OneColRow x={x} y={y + 4} width={width} label="Elapsed:" value={fmtDuration(status.elapsedSec)} />
      <OneColRow x={x} y={y + 5} width={width} label="ETA:" value={fmtDuration(status.remainingSec)} />
    </>
  );
};
