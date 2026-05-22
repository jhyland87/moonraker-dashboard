import { useEffect, useState } from 'react';
import { Text, useSize } from 'react-curse';

import type { ConnectionPhase } from '../hooks/useReconnectingClient';

/**
 * Props for {@link LoadingDialog}.
 * @source
 */
export interface LoadingDialogProps {
  /** Connection phase from {@link useReconnectingClient}. */
  readonly phase: ConnectionPhase;
  /** Number of attempts made so far (starts at 1). */
  readonly attempt: number;
  /** "host:port" string for display. */
  readonly host: string;
  /** Last underlying error message, if the websocket reported one. */
  readonly lastError?: string;
  /**
   * `true` if the dashboard has ever been successfully connected. Drives
   * the "Reconnecting…" vs. "Connecting…" copy so the user can tell the
   * difference between a slow initial bring-up and a mid-session drop.
   */
  readonly wasEverConnected: boolean;
}

const BOX_WIDTH = 56;
const BOX_HEIGHT = 7;

/**
 * Centered "Connecting…" modal shown before any of the dashboard panels
 * mount. Driven by {@link useReconnectingClient}'s phase so the message
 * updates as we retry / cross the configured timeout. Renders a
 * single-line box-drawing frame with four content rows: title, host,
 * status, and an optional hint after the timeout.
 *
 * @param props - See {@link LoadingDialogProps}.
 * @returns The centered dialog element.
 * @source
 */
export const LoadingDialog = ({
  phase,
  attempt,
  host,
  lastError,
  wasEverConnected,
}: LoadingDialogProps) => {
  const { width: termWidth, height: termHeight } = useSize();
  // Three-step ellipsis animation on a 400 ms tick.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 4), 400);
    return () => clearInterval(id);
  }, []);

  // Non-TTY contexts (e.g. running under a wrapper without a real
  // terminal) report `undefined` for stdout dimensions, which would
  // crash react-curse's buffer if we tried to render into it. Bail
  // *after* the hooks have all been called so the call order stays
  // stable across renders.
  if (!termWidth || !termHeight || termHeight < BOX_HEIGHT) return null;

  const x = Math.max(0, Math.floor((termWidth - BOX_WIDTH) / 2));
  const y = Math.max(0, Math.floor((termHeight - BOX_HEIGHT) / 2));
  const dots = '.'.repeat(tick);

  const isTimedOut = phase === 'timed-out';
  const statusColor = isTimedOut ? 'Yellow' : 'White';
  // Title + status copy switch when we're recovering from a mid-session
  // drop, so the user knows the dashboard *was* live and is trying to
  // come back online (vs. a slow first-time connect).
  const verbing = wasEverConnected ? 'Reconnecting' : 'Connecting';
  const title = wasEverConnected ? 'Reconnecting to Moonraker' : 'Connecting to Moonraker';
  const sleepHint = wasEverConnected
    ? 'printer may have gone to sleep'
    : 'printer may be asleep';
  const statusLine =
    phase === 'connecting'
      ? `${verbing}${dots}`
      : phase === 'retrying'
        ? `${verbing}${dots} (attempt ${attempt})`
        : phase === 'timed-out'
          ? `Still trying${dots} (attempt ${attempt}) — ${sleepHint}`
          : 'Connected';

  const innerW = BOX_WIDTH - 2;
  const topBorder = `┌${'─'.repeat(innerW)}┐`;
  const blankBorder = `│${' '.repeat(innerW)}│`;
  const bottomBorder = `└${'─'.repeat(innerW)}┘`;

  const hint = isTimedOut
    ? lastError
      ? `last error: ${lastError}`
      : 'Press Ctrl-C to cancel'
    : '';

  return (
    <>
      <Text x={x} y={y} color="BrightBlack">
        {topBorder}
      </Text>
      <Text x={x} y={y + 1} color="BrightBlack">
        {blankBorder}
      </Text>
      <Text x={x + 2} y={y + 1} color="Cyan" bold>
        {title}
      </Text>
      <Text x={x} y={y + 2} color="BrightBlack">
        {blankBorder}
      </Text>
      <Text x={x + 2} y={y + 2} color="White" dim>
        {host}
      </Text>
      <Text x={x} y={y + 3} color="BrightBlack">
        {blankBorder}
      </Text>
      <Text x={x + 2} y={y + 3} color={statusColor}>
        {statusLine}
      </Text>
      <Text x={x} y={y + 4} color="BrightBlack">
        {blankBorder}
      </Text>
      {hint !== '' && (
        <Text x={x + 2} y={y + 4} color="BrightBlack" dim>
          {hint}
        </Text>
      )}
      <Text x={x} y={y + 5} color="BrightBlack">
        {blankBorder}
      </Text>
      <Text x={x} y={y + 6} color="BrightBlack">
        {bottomBorder}
      </Text>
    </>
  );
};
