import { MoonrakerClient, type ClientConfig } from '@jhyland87/moonraker-client';
import { useEffect, useRef, useState } from 'react';

/**
 * The connection bring-up state machine, surfaced from
 * {@link useReconnectingClient}.
 *
 * - `connecting`  — first attempt of the current cycle is in flight (no
 *                   UI timeout reached yet). A "cycle" is either the
 *                   initial bring-up *or* a reconnection started after a
 *                   previously-connected socket dropped.
 * - `retrying`    — at least one attempt has failed; we are waiting
 *                   before the next one.
 * - `timed-out`   — `connectionTimeoutMs` elapsed without success. We
 *                   *keep* retrying; this state only changes the dialog's
 *                   wording so the user knows things aren't normal.
 * - `connected`   — the websocket fired `open`; the wrapped client is
 *                   exposed via `client` and the dashboard takes over.
 * @source
 */
export type ConnectionPhase = 'connecting' | 'retrying' | 'timed-out' | 'connected';

/**
 * Options for {@link useReconnectingClient}.
 * @source
 */
export interface UseReconnectingClientOptions {
  /** Connection settings to construct each attempt's `MoonrakerClient`. */
  readonly config: ClientConfig;
  /** Delay (ms) between retry attempts after the previous one failed. */
  readonly retryIntervalMs: number;
  /**
   * After this many ms of failed attempts (per cycle), the `phase` flips
   * from `retrying` to `timed-out`. The hook keeps retrying — it's a UI
   * cue, not a hard cap.
   */
  readonly connectionTimeoutMs: number;
}

/**
 * Reactive return of {@link useReconnectingClient}.
 * @source
 */
export interface UseReconnectingClientResult {
  readonly phase: ConnectionPhase;
  /** The connected client, or `null` while still bringing up the connection. */
  readonly client: MoonrakerClient | null;
  /** Attempt counter for the *current* cycle. Resets to 1 each time a
   *  previously-connected socket drops and a new reconnection cycle begins. */
  readonly attempt: number;
  /** The most recent error message that caused a retry, if any. */
  readonly lastError?: string;
  /** True once the hook has ever reached `connected`. Lets the loading
   *  dialog swap between "Connecting…" and "Reconnecting…" wording. */
  readonly wasEverConnected: boolean;
}

/**
 * Open a Moonraker websocket and keep it open across the dashboard's
 * lifetime — retry on initial bring-up *and* re-enter the retry loop if
 * the connection later drops. While the connection isn't `'connected'`,
 * `client` is `null` and callers should render a placeholder.
 *
 * Why this hook exists: Klipper printers in sleep mode can take 10–30 s
 * to wake up, and they can re-enter sleep mid-session. `MoonrakerClient`
 * doesn't auto-reconnect on its own, so this hook discards a failed (or
 * disconnected) instance and constructs a fresh one `retryIntervalMs`
 * later until something sticks. Each reconnection cycle resets the
 * attempt counter and re-arms the `connectionTimeoutMs` UI timer.
 *
 * @param options - See {@link UseReconnectingClientOptions}.
 * @returns The current phase, the (eventually) connected client, the
 *          attempt counter for the current cycle, and a flag indicating
 *          whether the hook has ever been connected.
 * @source
 */
export const useReconnectingClient = (
  options: UseReconnectingClientOptions,
): UseReconnectingClientResult => {
  const [phase, setPhase] = useState<ConnectionPhase>('connecting');
  const [client, setClient] = useState<MoonrakerClient | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  const [wasEverConnected, setWasEverConnected] = useState(false);
  // Mirror props on a ref so the effect's setup can read fresh values
  // without re-running every time the consumer passes a new (but
  // structurally equivalent) `options` object.
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    // Closure-level "are we currently connected" guard. Used so the UI
    // timeout timer suppresses itself once we're up, and so the close
    // handler can tell a reconnect cycle apart from a failed initial
    // attempt.
    let connected = false;

    /**
     * Re-arm the "still trying" UI timer for the current cycle. Called
     * at the start of the initial cycle and at the start of every
     * reconnect cycle (post-disconnect).
     */
    const armTimeoutTimer = (): void => {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => {
        if (cancelled || connected) return;
        setPhase('timed-out');
      }, optsRef.current.connectionTimeoutMs);
    };

    /** Schedule the next `tryConnect()` after `retryIntervalMs`. */
    const scheduleRetry = (): void => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (cancelled) return;
        tryConnect();
      }, optsRef.current.retryIntervalMs);
    };

    /**
     * Construct a fresh `MoonrakerClient` and wire its lifecycle into
     * the retry loop. Listeners stay attached for the life of the
     * client — they self-clean when the client is garbage-collected
     * after we drop our reference on the next retry / on unmount.
     */
    const tryConnect = (): void => {
      setAttempt((n) => n + 1);
      const c = new MoonrakerClient(optsRef.current.config);
      let opened = false;

      c.on('open', () => {
        if (cancelled) {
          // Effect tore down between connect and open — close the orphan.
          c.close();
          return;
        }
        opened = true;
        connected = true;
        if (timeoutTimer !== null) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        setClient(c);
        setWasEverConnected(true);
        setPhase('connected');
      });

      c.on('error', (err: Error) => {
        if (cancelled) return;
        setLastError(err.message);
      });

      c.on('close', () => {
        if (cancelled) return;
        if (opened) {
          // The socket was up at some point during this client's life
          // and has now dropped. Reset for a brand-new reconnect cycle:
          // hide the stale client, reset attempt counter / last error,
          // and re-arm the UI timeout so the dialog can flip into
          // "still trying" after `connectionTimeoutMs` again.
          connected = false;
          setClient(null);
          setLastError(undefined);
          setAttempt(0);
          setPhase('connecting');
          armTimeoutTimer();
        } else {
          // The attempt never made it to `open` — keep the cycle going.
          setPhase((prev) => (prev === 'timed-out' ? prev : 'retrying'));
        }
        scheduleRetry();
      });
    };

    armTimeoutTimer();
    tryConnect();

    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      // If we currently own a connected client, close it cleanly so the
      // underlying WS is torn down with the dashboard.
      if (client !== null) client.close();
    };
    // The effect intentionally re-initializes only on a fresh mount.
    // Option updates flow in via optsRef so a parent re-render doesn't
    // tear down an in-flight retry sequence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { phase, client, attempt, lastError, wasEverConnected };
};
