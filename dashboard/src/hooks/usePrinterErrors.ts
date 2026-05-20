import type { MoonrakerClient, PrinterStatus } from '@jhyland87/moonraker-client';
import { useEffect, useState } from 'react';

import {
  fetchKlippyLogTail,
  DEFAULT_KLIPPY_LOG_TAIL_BYTES,
} from '../services/klippyLogTail';
import { parseKlippyLog, type ParsedLogError } from '../services/parseKlippyLog';

/**
 * Klipper's reported lifecycle state. Mirrors the values that the
 * `webhooks` printer object can report; `unknown` is a sentinel for the
 * dashboard's pre-data state.
 * @source
 */
export type KlippyState = 'startup' | 'ready' | 'shutdown' | 'error' | 'unknown';

/**
 * Return `true` for the two states the dashboard treats as "the printer
 * isn't OK right now".
 *
 * @param s - The Klipper state.
 * @returns `true` if it's a shutdown or error state.
 * @source
 */
const isErrorState = (s: KlippyState): boolean => s === 'shutdown' || s === 'error';

/**
 * Subset of the `webhooks` printer object the hook actually reads.
 * @source
 */
interface WebhooksStatus {
  readonly state?: KlippyState | string;
  readonly state_message?: string;
}

/**
 * Coerce an unknown value into a {@link KlippyState}, falling back to
 * `unknown` for any unrecognized input.
 *
 * @param raw - The raw value from `webhooks.state`.
 * @returns A typed state value.
 * @source
 */
const normalizeState = (raw: unknown): KlippyState => {
  if (raw === 'startup' || raw === 'ready' || raw === 'shutdown' || raw === 'error') return raw;
  return 'unknown';
};

/**
 * Reactive state exposed by {@link usePrinterErrors}.
 * @source
 */
export interface PrinterErrorsState {
  readonly klippyState: KlippyState;
  readonly stateMessage?: string;
  readonly errors: readonly ParsedLogError[];
  readonly fetchError?: string;
}

const INITIAL: PrinterErrorsState = {
  klippyState: 'unknown',
  errors: [],
};

/**
 * Subscribe to `webhooks.{state,state_message}` and — when Klipper enters
 * a shutdown/error state — fetch the tail of `klippy.log` (via the
 * shared {@link fetchKlippyLogTail} service so this fetch deduplicates
 * with the one in {@link useGcodeConsole}) and surface the parsed errors.
 *
 * Errors are fetched once per transition *into* a bad state with
 * `fresh: true`. The fetch is AbortController-guarded so unmount or
 * recovery aborts any in-flight work.
 *
 * @param client - The websocket client.
 * @returns Reactive state describing the Klipper lifecycle + the parsed
 *          errors associated with the current incident, if any.
 * @source
 */
export const usePrinterErrors = (client: MoonrakerClient): PrinterErrorsState => {
  const [state, setState] = useState<PrinterErrorsState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    let prevState: KlippyState = 'unknown';
    let activeFetch: AbortController | null = null;

    const fetchLog = async (): Promise<void> => {
      activeFetch?.abort();
      const ac = new AbortController();
      activeFetch = ac;
      try {
        // `fresh: true` — the printer just transitioned into an error state,
        // so we want the *current* log tail rather than a recently-cached one.
        const tail = await fetchKlippyLogTail(client, {
          bytes: DEFAULT_KLIPPY_LOG_TAIL_BYTES,
          fresh: true,
        });
        if (cancelled || ac.signal.aborted) return;
        const errors = parseKlippyLog(tail);
        setState((s) => ({ ...s, errors, fetchError: undefined }));
      } catch (err) {
        if (cancelled || ac.signal.aborted) return;
        setState((s) => ({ ...s, fetchError: (err as Error).message }));
      } finally {
        if (activeFetch === ac) activeFetch = null;
      }
    };

    const applyWebhooks = (webhooks: WebhooksStatus | undefined): void => {
      if (!webhooks) return;
      const next = normalizeState(webhooks.state ?? prevState);
      const message = webhooks.state_message ?? undefined;
      const transitioned = !isErrorState(prevState) && isErrorState(next);
      const recovered = isErrorState(prevState) && !isErrorState(next);

      setState((s) => ({
        ...s,
        klippyState: next,
        stateMessage: message ?? s.stateMessage,
        errors: recovered ? [] : s.errors,
        fetchError: recovered ? undefined : s.fetchError,
      }));

      if (transitioned) void fetchLog();
      if (recovered) activeFetch?.abort();
      prevState = next;
    };

    const onOpen = async (): Promise<void> => {
      // The sensors hook owns the websocket subscription (Moonraker replaces
      // the spec on each subscribe), so we only ask for the current webhooks
      // status here and rely on `notify:status_update` for deltas afterward.
      try {
        const res = await client.queryObjects({ webhooks: ['state', 'state_message'] });
        if (cancelled) return;
        applyWebhooks(res.status.webhooks as WebhooksStatus | undefined);
      } catch (err) {
        if (cancelled) return;
        setState((s) => ({ ...s, fetchError: `webhooks query: ${(err as Error).message}` }));
      }
    };

    const onUpdate = (incoming: PrinterStatus): void => {
      const wh = incoming.webhooks as WebhooksStatus | undefined;
      if (wh && (wh.state !== undefined || wh.state_message !== undefined)) {
        applyWebhooks(wh);
      }
    };

    if (client.isOpen) void onOpen();
    else client.on('open', () => void onOpen());
    client.on('notify:status_update', onUpdate);

    return () => {
      cancelled = true;
      activeFetch?.abort();
      client.off('notify:status_update', onUpdate);
    };
  }, [client]);

  return state;
};
