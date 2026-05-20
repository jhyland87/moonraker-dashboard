import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, useInput, useMouse } from 'react-curse';

import type { GcodeEntry } from '../hooks/useGcodeConsole';

interface ConsolePanelProps {
  readonly entries: readonly GcodeEntry[];
  readonly onSubmit: (script: string) => void;
  readonly onClose: () => void;
  /** See ConsoleConfig.naturalScroll. */
  readonly naturalScroll: boolean;
  readonly debug: boolean;
  readonly onToggleDebug: () => void;
  /**
   * Called whenever the console's text input gains or loses focus. The
   * parent uses this to suspend its own keyboard shortcuts while the user
   * is typing a command (so a typed letter doesn't double-trigger a graph
   * toggle, for example).
   */
  readonly onInputFocusChange?: (focused: boolean) => void;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const formatTime = (epochSec: number): string => {
  const d = new Date(epochSec * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

/**
 * Console panel — replaces the chart area while open. Two interaction modes
 * routed by the same keystroke handler:
 *
 * - **View mode** (default on open): the user is just watching the feed.
 *   `q` / `Esc` close the console. `i` focuses the input. `↑/↓` step-scroll
 *   one line. Wheel scrolls. No keys are typed.
 *
 * - **Input mode**: the input is focused, and every keystroke is for typing
 *   a gcode command. `Esc` returns to view mode (without closing). `↑/↓`
 *   cycle command history. `Enter` sends and keeps focus. `q` is just `q`.
 *
 * The mode split lets users keep an active print's console open as a passive
 * feed without their keystrokes being eaten by a focused text input.
 */
export const ConsolePanel = ({
  entries,
  onSubmit,
  onClose,
  naturalScroll,
  debug,
  onToggleDebug,
  onInputFocusChange,
  y,
  width,
  height,
}: ConsolePanelProps) => {
  const [draft, setDraft] = useState('');
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  // Distance from the live tail, in entries. 0 = following live; >0 = paused.
  const [scrollOffset, setScrollOffset] = useState(0);
  const [inputFocused, setInputFocused] = useState(false);
  // The shape of "sent commands" the user has cycled through with Up/Down.
  const sentHistory = useMemo(
    () => entries.filter((e) => e.type === 'command').map((e) => e.message),
    [entries],
  );

  useInput((input) => {
    // react-curse delivers control sequences as raw strings.
    // Enter: \r ; Backspace/Delete: 0x7f or 0x08 ; Esc: 0x1b ; arrows: CSI codes.

    if (!inputFocused) {
      // View mode — passive feed. Keystrokes drive navigation, never the input.
      if (input === 'q' || input === 'Q' || input === 'c' || input === 'C' || input === '\x1b') {
        onClose();
        return;
      }
      if (input === 'i' || input === 'I') {
        setInputFocused(true);
        return;
      }
      if (input === 'd' || input === 'D') {
        onToggleDebug();
        return;
      }
      if (input === '\x1b[A' || input === '\x10') {
        // Up arrow → scroll one line back into history.
        setScrollOffset((prev) => Math.min(Math.max(0, entries.length - 1), prev + 1));
        return;
      }
      if (input === '\x1b[B' || input === '\x0e') {
        // Down arrow → scroll one line toward the live tail.
        setScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      return;
    }

    // Input mode — typing/editing.
    if (input === '\x1b') {
      // Esc defocuses (back to view), without closing.
      setInputFocused(false);
      setHistoryIdx(null);
      return;
    }
    if (input === '\r' || input === '\n') {
      if (draft.trim()) onSubmit(draft);
      setDraft('');
      setHistoryIdx(null);
      setScrollOffset(0); // Snap to live tail so the response is visible.
      return;
    }
    if (input === '\x7f' || input === '\b') {
      setDraft((d) => d.slice(0, -1));
      setHistoryIdx(null);
      return;
    }
    if (input === '\x1b[A' || input === '\x10') {
      // Up arrow / Ctrl-P → previous command
      if (sentHistory.length === 0) return;
      setHistoryIdx((idx) => {
        if (idx === null) {
          const next = sentHistory.length - 1;
          setDraft(sentHistory[next] ?? '');
          return next;
        }
        const next = Math.max(0, idx - 1);
        setDraft(sentHistory[next] ?? '');
        return next;
      });
      return;
    }
    if (input === '\x1b[B' || input === '\x0e') {
      // Down arrow / Ctrl-N → next command. Past the end (or when not in
      // history mode), clear the draft so the input is empty.
      if (historyIdx === null) {
        if (draft !== '') setDraft('');
        return;
      }
      const next = historyIdx + 1;
      if (next >= sentHistory.length) {
        setHistoryIdx(null);
        setDraft('');
        return;
      }
      setHistoryIdx(next);
      setDraft(sentHistory[next] ?? '');
      return;
    }
    // Printable single chars — including space and `q`.
    if (input.length === 1 && input >= ' ' && input !== '\x7f') {
      setDraft((d) => d + input);
      setHistoryIdx(null);
    }
  },
  // Deps: react-curse defaults to `[]`, which would freeze the callback's
  // closure at first mount — meaning `inputFocused` would always read as
  // `false` and typing/history-nav would be broken. Re-register the handler
  // whenever any state it reads changes.
  [inputFocused, draft, historyIdx, sentHistory, entries.length, onClose, onSubmit, onToggleDebug],
  );

  // Auto-clear historyIdx if the underlying history shrinks/grows under us.
  useEffect(() => {
    if (historyIdx !== null && historyIdx >= sentHistory.length) setHistoryIdx(null);
  }, [historyIdx, sentHistory.length]);

  // Mirror inputFocused to the parent so it can gate its own keyboard
  // shortcuts. On unmount (console closing) we explicitly report `false` so
  // the parent never gets stuck thinking the input is focused.
  useEffect(() => {
    onInputFocusChange?.(inputFocused);
    return () => onInputFocusChange?.(false);
  }, [inputFocused, onInputFocusChange]);

  const headerH = 1;
  const footerH = 2; // hint row + input row
  const bodyH = Math.max(1, height - headerH - footerH);

  // When new entries arrive while scrolled back, advance the offset so the
  // user's view stays put on the *same* entries instead of drifting downward.
  // The cap ensures we never point past the top of the buffer.
  const maxScroll = Math.max(0, entries.length - bodyH);
  const prevLenRef = useRef(entries.length);
  useEffect(() => {
    const delta = entries.length - prevLenRef.current;
    prevLenRef.current = entries.length;
    if (delta > 0 && scrollOffset > 0) {
      setScrollOffset((prev) => Math.min(maxScroll, prev + delta));
    }
  }, [entries.length, scrollOffset, maxScroll]);

  // Clamp scrollOffset if the buffer shrunk (or bodyH grew).
  useEffect(() => {
    if (scrollOffset > maxScroll) setScrollOffset(maxScroll);
  }, [scrollOffset, maxScroll]);

  const consoleYStart = y;
  const consoleYEnd = y + height - 1;
  // With `naturalScroll: true`, wheel-up = older entries (content follows the
  // finger). With `naturalScroll: false` (default), wheel-up = newer entries —
  // i.e. scroll toward the live tail, matching most terminal scrollback UIs.
  useMouse((evt) => {
    if (evt.y < consoleYStart || evt.y > consoleYEnd) return;
    const upDelta = naturalScroll ? 3 : -3;
    if (evt.type === 'wheelup') {
      setScrollOffset((prev) => Math.max(0, Math.min(maxScroll, prev + upDelta)));
    } else if (evt.type === 'wheeldown') {
      setScrollOffset((prev) => Math.max(0, Math.min(maxScroll, prev - upDelta)));
    }
  }, [maxScroll, consoleYStart, consoleYEnd, naturalScroll]);

  // Visible slice: [start, end) walking back from the live tail by scrollOffset.
  const end = entries.length - scrollOffset;
  const start = Math.max(0, end - bodyH);
  const visible = entries.slice(start, end);
  const padRows = Math.max(0, bodyH - visible.length);
  const paused = scrollOffset > 0;

  // Body column widths.
  const TIME_W = 8;
  const PREFIX_W = 3; // "// " or ">> "
  const msgW = Math.max(8, width - 2 - TIME_W - 1 - PREFIX_W);

  return (
    <>
      <Text x={0} y={y} width={width} height={1} background="BrightBlack" block>
        <Text x={1} color="White" bold>
          Console
        </Text>
        <Text x={11} color={inputFocused ? 'Green' : 'BrightBlack'}>
          {inputFocused ? '● typing' : '○ viewing'}
        </Text>
        {debug && (
          <Text x={22} color="Cyan">
            [D] debug
          </Text>
        )}
        {paused && (
          <Text x={debug ? 34 : 22} color="Yellow">
            ⏸ scrolled back {scrollOffset}
          </Text>
        )}
      </Text>

      {Array.from({ length: padRows }).map((_, i) => (
        <Text key={`pad${i}`} x={0} y={y + headerH + i} width={width} height={1} block>
          <Text> </Text>
        </Text>
      ))}
      {visible.map((entry, i) => {
        const row = y + headerH + padRows + i;
        const time = formatTime(entry.time);
        let prefix: string;
        let prefixColor: string;
        let messageColor: string;
        switch (entry.type) {
          case 'command':
            prefix = '>> ';
            prefixColor = 'Cyan';
            messageColor = 'White';
            break;
          case 'log_error':
            prefix = '!! ';
            prefixColor = 'Red';
            messageColor = 'Red';
            break;
          case 'log_warning':
            prefix = '!  ';
            prefixColor = 'Yellow';
            messageColor = 'Yellow';
            break;
          case 'debug':
            prefix = '[D]';
            prefixColor = 'Cyan';
            messageColor = 'BrightBlack';
            break;
          case 'response':
          default:
            prefix = '// ';
            prefixColor = 'BrightBlack';
            messageColor = 'White';
            break;
        }
        return (
          <Text key={`e${row}-${i}`} x={0} y={row} width={width} height={1} block>
            <Text x={1} color="BrightBlack">{time}</Text>
            <Text x={1 + TIME_W + 1} color={prefixColor}>
              {prefix}
            </Text>
            <Text x={1 + TIME_W + 1 + PREFIX_W} color={messageColor}>
              {truncate(entry.message, msgW)}
            </Text>
          </Text>
        );
      })}

      <Text x={0} y={y + height - footerH} width={width} height={1} block>
        <Text x={1} color="BrightBlack" dim>
          {inputFocused
            ? 'Enter to send · ↑/↓ history · Esc to stop typing'
            : 'i to type · q/c/Esc to close · d to toggle debug · ↑/↓ scroll'}
        </Text>
      </Text>
      <Text x={0} y={y + height - 1} width={width} height={1} block>
        <Text x={1} color={inputFocused ? 'Yellow' : 'BrightBlack'} bold dim={!inputFocused}>
          {'> '}
        </Text>
        {inputFocused ? (
          <>
            <Text x={3} color="White">
              {truncate(draft, Math.max(1, width - 5))}
            </Text>
            <Text x={3 + Math.min(draft.length, width - 5)} background="White" color="Black">
              {' '}
            </Text>
          </>
        ) : (
          <Text x={3} color="BrightBlack" dim>
            press i to type a command
          </Text>
        )}
      </Text>
    </>
  );
};
