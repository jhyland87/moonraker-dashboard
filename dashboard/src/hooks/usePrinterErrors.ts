import type { MoonrakerClient, PrinterStatus } from '@jhyland87/moonraker-client';
import { useEffect, useState } from 'react';

import { parseKlippyLog, type ParsedLogError } from '../services/parseKlippyLog';

export type KlippyState = 'startup' | 'ready' | 'shutdown' | 'error' | 'unknown';

const isErrorState = (s: KlippyState): boolean => s === 'shutdown' || s === 'error';

interface WebhooksStatus {
  readonly state?: KlippyState | string;
  readonly state_message?: string;
}

const normalizeState = (raw: unknown): KlippyState => {
  if (raw === 'startup' || raw === 'ready' || raw === 'shutdown' || raw === 'error') return raw;
  return 'unknown';
};

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
 * Subscribe to `webhooks.{state,state_message}` and — when Klipper enters a
 * shutdown/error state — fetch the tail of klippy.log via the client's HTTP
 * helper and surface the parsed errors.
 *
 * Errors are fetched once per transition into a bad state. The fetch is
 * AbortController-guarded so unmount or recovery aborts in-flight work.
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
        const tail = await client.getLogTail('klippy.log', 50_000);
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
