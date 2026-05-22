import type { MoonrakerClient } from '@jhyland87/moonraker-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchKlippyLogTail } from '../services/klippyLogTail';
import { parseKlippyLog } from '../services/parseKlippyLog';

/**
 * Tag identifying how an entry should be rendered in the console panel.
 *
 * - `command`     — outbound gcode sent by some client (us or another).
 * - `response`    — printer's response payload (Klipper `// ...` lines).
 * - `log_error`   — error event surfaced from `klippy.log` parsing.
 * - `log_warning` — warning event surfaced from `klippy.log` parsing.
 * - `debug`       — dashboard-internal diagnostic (ws lifecycle, etc.).
 * @source
 */
export type GcodeEntryType = 'command' | 'response' | 'log_error' | 'log_warning' | 'debug';

/**
 * A single entry in the console feed.
 * @source
 */
export interface GcodeEntry {
  /** Unix epoch seconds. From `server.gcode_store` for seeded entries; local time for live ones. */
  readonly time: number;
  readonly type: GcodeEntryType;
  readonly message: string;
}

/**
 * Options accepted by {@link useGcodeConsole}.
 * @source
 */
export interface UseGcodeConsoleOptions {
  /** When true, lifecycle + diagnostic events from the client are appended as `debug` entries. */
  readonly debug?: boolean;
}

interface GcodeStoreResult {
  readonly gcode_store?: ReadonlyArray<{
    readonly message: string;
    readonly time: number;
    readonly type?: string;
  }>;
}

const MAX_HISTORY = 500;
const KLIPPY_LOG_TAIL_BYTES = 50_000;
/**
 * How often to re-poll `server.gcode_store` to pick up commands sent by
 * *other* clients (Fluidd, Mainsail). Moonraker does not emit a websocket
 * notification when entries are added to the gcode store or to the
 * `fluidd:console.commandHistory` database key (verified by sniffing the WS
 * against the live printer), so polling is the only reliable signal for
 * cross-client visibility. Responses still come through `notify:gcode_response`
 * with no latency — the poll is just to backfill *commands* we couldn't see.
 */
const STORE_POLL_INTERVAL_MS = 1_500;

/**
 * Strip Klipper's comment prefix (`// `) from a response message so the
 * dashboard's own `//` glyph isn't shown alongside it.
 *
 * @param msg - Raw response message.
 * @returns The message with any leading `// ` (or `//`) removed.
 * @source
 */
const stripResponsePrefix = (msg: string): string =>
  msg.startsWith('// ') ? msg.slice(3) : msg.startsWith('//') ? msg.slice(2) : msg;

/**
 * Classify a Klipper response message: strip the comment prefix, and if
 * the remaining payload is marked with `!!` (Klipper's error indicator),
 * tag it as a `log_error` instead of a normal `response`.
 *
 * @param rawMessage - The raw message as Klipper sent it.
 * @returns The cleaned message with its appropriate entry type.
 * @source
 */
const classifyResponse = (
  rawMessage: string,
): { type: GcodeEntryType; message: string } => {
  const stripped = stripResponsePrefix(rawMessage);
  if (stripped.startsWith('!! ')) return { type: 'log_error', message: stripped.slice(3) };
  if (stripped.startsWith('!!')) return { type: 'log_error', message: stripped.slice(2) };
  return { type: 'response', message: stripped };
};

/**
 * Convert a Klipper log timestamp (`YYYY-MM-DD HH:MM:SS` in local time)
 * to Unix epoch seconds. Returns `0` for missing or unparseable input.
 *
 * @param ts - Timestamp string from the log.
 * @returns Epoch seconds, or `0` on failure.
 * @source
 */
const parseLogTimestamp = (ts: string | undefined): number => {
  if (!ts) return 0;
  // Klipper log format: 'YYYY-MM-DD HH:MM:SS' (local time, no TZ). The
  // standard Date constructor parses this as local time, which is what we
  // want for chronological merging with gcode_store entries (also local).
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t / 1000 : 0;
};

/**
 * Return value of {@link useGcodeConsole}.
 * @source
 */
export interface UseGcodeConsoleResult {
  readonly entries: readonly GcodeEntry[];
  readonly send: (script: string) => Promise<void>;
}

/**
 * Maintain a local rolling buffer of gcode commands + responses, seeded
 * from Moonraker's `server.gcode_store` and updated live via
 * `notify:gcode_response`. Exposes a `send` that calls
 * `printer.gcode.script` and optimistically appends the command locally so
 * the user sees their input immediately.
 *
 * Also polls `server.gcode_store` once every {@link STORE_POLL_INTERVAL_MS}
 * to surface commands originated by *other* clients (Fluidd, Mainsail) —
 * Moonraker doesn't publish a notification for those.
 *
 * @param client - The websocket client.
 * @param options - See {@link UseGcodeConsoleOptions}.
 * @returns Entries + a `send(script)` function.
 * @source
 */
export const useGcodeConsole = (
  client: MoonrakerClient,
  options: UseGcodeConsoleOptions = {},
): UseGcodeConsoleResult => {
  const [entries, setEntries] = useState<readonly GcodeEntry[]>([]);
  const debug = options.debug ?? false;
  // Reference to the effect-scoped `recentLocalSends` array so `send()`
  // (defined outside the effect) can record what the user typed. The effect
  // assigns it on mount; cleared on unmount.
  const sendsRef = useRef<{ message: string; localTime: number }[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // `notify:gcode_response` can fire while we're still awaiting the seed
    // fetches. Buffer those messages until the seed is applied so they don't
    // get overwritten by the seed's `setEntries`.
    const liveBuffer: GcodeEntry[] = [];
    let seeded = false;
    // Highest `time` we've ever observed across seed + poll + live events.
    // Used as a `since` filter when consuming poll results so we only add
    // entries newer than what we already have.
    let maxSeenTime = 0;
    // Pollers can race with live `notify:gcode_response` (we set time =
    // Date.now() which may not match Moonraker's clock exactly). Keep a
    // short-lived set of `time|message` keys for entries we've seen recently
    // so the poll doesn't duplicate them.
    const recentKeys = new Set<string>();
    const keyFor = (time: number, message: string): string =>
      `${time.toFixed(3)}|${message}`;
    // Commands we sent locally and optimistically appended. The store's
    // record of those commands will arrive via the next poll with the
    // printer's authoritative timestamp (which won't match our local clock),
    // so we match by message within a ±10s window and consume on match.
    const recentLocalSends: { message: string; localTime: number }[] = [];
    const SEND_MATCH_WINDOW_SEC = 10;
    const SEND_TTL_SEC = 30;
    const tryConsumeLocalSend = (message: string, printerTime: number): boolean => {
      const idx = recentLocalSends.findIndex(
        (s) =>
          s.message === message &&
          Math.abs(s.localTime - printerTime) <= SEND_MATCH_WINDOW_SEC,
      );
      if (idx < 0) return false;
      recentLocalSends.splice(idx, 1);
      return true;
    };
    const pruneOldLocalSends = (): void => {
      const cutoff = Date.now() / 1000 - SEND_TTL_SEC;
      // Iterate descending so in-place `splice` doesn't shift indices
      // we haven't visited yet. Read the entry through a local + guard
      // so we don't lean on the non-null assertion operator.
      for (let i = recentLocalSends.length - 1; i >= 0; i--) {
        const entry = recentLocalSends[i];
        if (entry === undefined) continue;
        if (entry.localTime < cutoff) recentLocalSends.splice(i, 1);
      }
    };
    // Stored on the hook closure so `send()` (created outside this effect)
    // can record sent messages. Bound to the current effect lifetime via the
    // sendsRef the outer scope wires up below.
    sendsRef.current = recentLocalSends;
    let pollTimer: NodeJS.Timeout | null = null;

    const seedAndStart = async (): Promise<void> => {
      const [gcodeRes, logTail] = await Promise.allSettled([
        client.request<GcodeStoreResult>('server.gcode_store'),
        // Routed through the shared service so the parallel call in
        // `usePrinterErrors` (when the printer comes up already in an error
        // state) reuses the same in-flight promise instead of duplicating
        // the network request.
        fetchKlippyLogTail(client, { bytes: KLIPPY_LOG_TAIL_BYTES }),
      ]);
      if (cancelled) return;

      const gcodeEntries: GcodeEntry[] =
        gcodeRes.status === 'fulfilled'
          ? (gcodeRes.value.gcode_store ?? []).map((e) => {
              if (e.type === 'command') {
                return { time: e.time, type: 'command', message: e.message };
              }
              const { type, message } = classifyResponse(e.message);
              return { time: e.time, type, message };
            })
          : [];

      const logEntries: GcodeEntry[] =
        logTail.status === 'fulfilled'
          ? parseKlippyLog(logTail.value)
              .map<GcodeEntry | null>((p) => {
                const time = parseLogTimestamp(p.timestamp);
                if (time <= 0) return null;
                const message = p.code ? `${p.code}: ${p.message}` : p.message;
                const type: GcodeEntryType =
                  p.level === 'WARNING' ? 'log_warning' : 'log_error';
                return { time, type, message };
              })
              .filter((e): e is GcodeEntry => e !== null)
          : [];

      // Merge by time. The live buffer holds any responses Moonraker pushed
      // while we were fetching; they belong at the end (their timestamps will
      // sort them correctly within the union).
      const merged = [...gcodeEntries, ...logEntries, ...liveBuffer].sort(
        (a, b) => a.time - b.time,
      );
      const capped = merged.slice(-MAX_HISTORY);
      for (const e of capped) {
        if (e.time > maxSeenTime) maxSeenTime = e.time;
        recentKeys.add(keyFor(e.time, e.message));
      }
      setEntries(capped);
      seeded = true;
      liveBuffer.length = 0;
    };

    const pollStore = async (): Promise<void> => {
      if (cancelled || !client.isOpen) return;
      pruneOldLocalSends();
      try {
        // Last ~50 entries — anything older is already in our buffer or has
        // fallen off MAX_HISTORY. Count is bounded to keep the message small.
        const res = await client.request<GcodeStoreResult>('server.gcode_store', {
          count: 50,
        });
        if (cancelled) return;
        const fresh: GcodeEntry[] = [];
        for (const e of res.gcode_store ?? []) {
          if (e.time <= maxSeenTime) continue;
          // Polling exists only to surface *commands* sent by other clients
          // (Fluidd, Mainsail) — Moonraker doesn't broadcast those over the
          // WS. Responses arrive immediately via `notify:gcode_response`, so
          // including them here would just produce duplicates whose
          // timestamps don't match (our local clock vs. the printer's). Skip
          // them — but still advance maxSeenTime so we don't re-evaluate.
          if (e.type !== 'command') {
            if (e.time > maxSeenTime) maxSeenTime = e.time;
            continue;
          }
          const message = e.message;
          // The store may contain a command we already optimistically appended
          // (printed by `send()` with our local clock). Match by message
          // within ±10s of the printer's recorded time and skip if so.
          if (tryConsumeLocalSend(message, e.time)) {
            if (e.time > maxSeenTime) maxSeenTime = e.time;
            continue;
          }
          const k = keyFor(e.time, message);
          if (recentKeys.has(k)) continue;
          recentKeys.add(k);
          fresh.push({ time: e.time, type: 'command', message });
          if (e.time > maxSeenTime) maxSeenTime = e.time;
        }
        if (fresh.length === 0) return;
        // Bound the dedupe set so it doesn't grow without limit; we only
        // need recent enough history for the next poll cycle's collisions.
        if (recentKeys.size > MAX_HISTORY * 2) recentKeys.clear();
        setEntries((prev) => {
          const next = [...prev, ...fresh];
          return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
        });
      } catch {
        // Transient errors are fine — the next tick will retry.
      }
    };

    const onResponse = (message: string): void => {
      const { type, message: cleaned } = classifyResponse(message);
      const entry: GcodeEntry = {
        time: Date.now() / 1000,
        type,
        message: cleaned,
      };
      if (!seeded) {
        liveBuffer.push(entry);
        return;
      }
      // Tag this entry's time as already-seen so the upcoming store poll
      // doesn't re-add the same response with a tiny clock-skew variant.
      if (entry.time > maxSeenTime) maxSeenTime = entry.time;
      recentKeys.add(keyFor(entry.time, entry.message));
      setEntries((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
      });
    };

    const appendDebug = (message: string): void => {
      const entry: GcodeEntry = { time: Date.now() / 1000, type: 'debug', message };
      if (!seeded) {
        liveBuffer.push(entry);
        return;
      }
      setEntries((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
      });
    };

    const onOpenEvent = (): void => appendDebug('ws open');
    const onCloseEvent = (code: number | undefined, reason: string | undefined): void =>
      appendDebug(`ws close (code=${code ?? '?'}${reason ? ` reason="${reason}"` : ''})`);
    const onErrorEvent = (err: Error): void => appendDebug(`ws error: ${err.message}`);

    const startSeedAndPoll = async (): Promise<void> => {
      await seedAndStart();
      if (cancelled) return;
      // Kick off the poll loop. We use `setTimeout` rather than `setInterval`
      // so a slow response can't queue up overlapping polls.
      const tick = async (): Promise<void> => {
        await pollStore();
        if (cancelled) return;
        pollTimer = setTimeout(() => void tick(), STORE_POLL_INTERVAL_MS);
      };
      pollTimer = setTimeout(() => void tick(), STORE_POLL_INTERVAL_MS);
    };

    if (client.isOpen) void startSeedAndPoll();
    else client.on('open', () => void startSeedAndPoll());
    client.on('notify:gcode_response', onResponse);

    if (debug) {
      appendDebug(`debug enabled (client open=${client.isOpen})`);
      client.on('open', onOpenEvent);
      client.on('close', onCloseEvent);
      client.on('error', onErrorEvent);
    }

    return () => {
      cancelled = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      sendsRef.current = null;
      client.off('notify:gcode_response', onResponse);
      if (debug) {
        client.off('open', onOpenEvent);
        client.off('close', onCloseEvent);
        client.off('error', onErrorEvent);
      }
    };
  }, [client, debug]);

  const send = useCallback(
    async (script: string): Promise<void> => {
      const trimmed = script.trim();
      if (!trimmed) return;
      const localTime = Date.now() / 1000;
      // Optimistic local append so the user sees the line as soon as they
      // press Enter. Moonraker won't echo the command itself via
      // notify_gcode_response — only its output, if any.
      setEntries((prev) => {
        const next = [
          ...prev,
          { time: localTime, type: 'command' as const, message: trimmed },
        ];
        return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
      });
      // Record so the gcode_store poller can match + skip the printer's
      // copy of this command (which will carry a slightly different time).
      sendsRef.current?.push({ message: trimmed, localTime });
      try {
        await client.request('printer.gcode.script', { script: trimmed });
      } catch (err) {
        setEntries((prev) => [
          ...prev,
          {
            time: Date.now() / 1000,
            type: 'log_error',
            message: (err as Error).message,
          },
        ]);
      }
    },
    [client],
  );

  return { entries, send };
};
