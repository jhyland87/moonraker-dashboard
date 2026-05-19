import { Text } from 'react-curse';

import type { ParsedLogError } from '../services/parseKlippyLog';
import type { KlippyState } from '../hooks/usePrinterErrors';

export const ERROR_PANEL_BODY_ROWS = 6;
export const ERROR_PANEL_HEIGHT = 1 + ERROR_PANEL_BODY_ROWS;

interface ErrorPanelProps {
  readonly klippyState: KlippyState;
  readonly stateMessage?: string;
  readonly errors: readonly ParsedLogError[];
  readonly fetchError?: string;
  readonly y: number;
  readonly width: number;
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

const timeOnly = (ts: string | undefined): string =>
  ts ? (ts.length >= 19 ? ts.slice(11, 19) : ts) : '--:--:--';

const formatError = (e: ParsedLogError, width: number): string => {
  const time = timeOnly(e.timestamp);
  const code = e.code ? ` ${e.code}` : '';
  return truncate(`${time} [${e.level}]${code} ${e.message}`, Math.max(8, width - 2));
};

export const ErrorPanel = ({
  klippyState,
  stateMessage,
  errors,
  fetchError,
  y,
  width,
}: ErrorPanelProps) => {
  const header = truncate(
    `Klipper ${klippyState}${stateMessage ? ' — ' + stateMessage : ''}`,
    Math.max(8, width - 2),
  );

  const body: { text: string; key: string; dim?: boolean }[] = [];
  if (fetchError) {
    body.push({ key: 'fetch-err', text: truncate(`klippy.log: ${fetchError}`, width - 2), dim: true });
  }
  // Newest-last → reverse so the most recent is on top.
  const recent = [...errors].reverse().slice(0, ERROR_PANEL_BODY_ROWS - body.length);
  for (let i = 0; i < recent.length; i++) {
    body.push({ key: `e${i}`, text: formatError(recent[i]!, width) });
  }
  while (body.length < ERROR_PANEL_BODY_ROWS) {
    body.push({ key: `pad${body.length}`, text: '' });
  }

  return (
    <>
      <Text x={0} y={y} width={width} height={1} background="Red" block>
        <Text x={1} color="White" bold>
          {header}
        </Text>
      </Text>
      {body.map((row, idx) => (
        <Text
          key={row.key}
          x={0}
          y={y + 1 + idx}
          width={width}
          height={1}
          color={row.dim ? 'BrightBlack' : 'Red'}
          block
        >
          <Text x={1}>{row.text}</Text>
        </Text>
      ))}
    </>
  );
};
