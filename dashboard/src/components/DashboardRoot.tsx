import { useCallback, useEffect, useRef, useState } from 'react';
import { useInput } from 'react-curse';

import { App } from '../App';
import type { DashboardConfig } from '../config/index';
import { saveConfig as saveConfigToDisk } from '../config/index';
import { useReconnectingClient } from '../hooks/useReconnectingClient';
import { restoreTerminalNow } from '../terminal';
import { LoadingDialog } from './LoadingDialog';

/**
 * Props for {@link DashboardRoot}.
 * @source
 */
export interface DashboardRootProps {
  /**
   * Config read from `~/.moonraker-dashboard/config.yaml` (or the default
   * on first launch). Used as the initial value of an internal `useState`
   * — runtime edits via the in-TUI editor mutate that state and persist
   * back to disk, so this prop only matters at mount.
   */
  readonly initialConfig: DashboardConfig;
}

/**
 * Setter callback shape consumers receive for hot-updating config.
 * Persists to YAML synchronously, then applies via React state.
 *
 * @source
 */
export type ConfigUpdater = (
  next: DashboardConfig | ((prev: DashboardConfig) => DashboardConfig),
) => void;

/**
 * Top-level wrapper that gates the dashboard {@link App} on a successful
 * websocket connection, and owns the mutable {@link DashboardConfig}
 * state so the in-TUI editor can hot-update it without a restart.
 *
 * @param props - See {@link DashboardRootProps}.
 * @returns Either the loading dialog or the full dashboard.
 * @source
 */
export const DashboardRoot = ({ initialConfig }: DashboardRootProps) => {
  // Mutable config state — initialized from the YAML load, mutated by
  // the editor modal via `setConfig`. The setter persists to disk on
  // every change so the YAML file stays in sync with the running app.
  const [config, setConfigState] = useState<DashboardConfig>(initialConfig);

  const setConfig: ConfigUpdater = useCallback((updater) => {
    setConfigState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      // Persist asynchronously-ish (sync I/O, but in a microtask so we
      // don't block the React state update). If the write throws, log
      // and keep going — the in-memory state is still updated, the
      // user just has to retry to persist.
      try {
        saveConfigToDisk(next);
      } catch (err) {
        process.stderr.write(
          `[config] saveConfig failed: ${(err as Error).message}\n`,
        );
      }
      return next;
    });
  }, []);

  const { phase, client, attempt, lastError, wasEverConnected } = useReconnectingClient({
    config: config.client,
    retryIntervalMs: config.startup.retryIntervalMs,
    connectionTimeoutMs: config.startup.connectionTimeoutMs,
  });

  const host = `${config.client.API.connection.server}:${
    config.client.API.connection.port ?? 80
  }`;

  // Ctrl-C escape hatch while we're still showing the loading dialog.
  // Once the App mounts it has its own handler.
  useInput(
    (input) => {
      if (phase === 'connected') return;
      if (input === '\x03' || input === 'q') {
        restoreTerminalNow();
        process.exit(0);
      }
    },
    [phase],
  );

  // Session counter — bumped each time we transition into a connected
  // client. Used as a React `key` on App so a reconnect tears the
  // dashboard down completely and rebuilds it against the new socket
  // (every hook re-mounts and resubscribes to the fresh client).
  const sessionRef = useRef(0);
  const prevClientRef = useRef(client);
  useEffect(() => {
    if (prevClientRef.current === null && client !== null) {
      sessionRef.current += 1;
    }
    prevClientRef.current = client;
  }, [client]);

  if (phase !== 'connected' || client === null) {
    return (
      <LoadingDialog
        phase={phase}
        attempt={attempt}
        host={host}
        lastError={lastError}
        wasEverConnected={wasEverConnected}
      />
    );
  }

  return (
    <App
      key={sessionRef.current}
      client={client}
      config={config}
      setConfig={setConfig}
    />
  );
};
