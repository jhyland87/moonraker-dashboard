import { useEffect, useRef } from 'react';
import { useInput } from 'react-curse';

import { App } from '../App';
import type { DashboardConfig } from '../config/index';
import { useReconnectingClient } from '../hooks/useReconnectingClient';
import { restoreTerminalNow } from '../terminal';
import { LoadingDialog } from './LoadingDialog';

/**
 * Props for {@link DashboardRoot}.
 * @source
 */
export interface DashboardRootProps {
  readonly config: DashboardConfig;
}

/**
 * Top-level wrapper that gates the dashboard {@link App} on a successful
 * websocket connection. While the connection is being established (or
 * retried), the user sees a centered {@link LoadingDialog} and nothing
 * else; the dashboard's panels mount only after `phase === 'connected'`.
 *
 * Ctrl-C is wired here too so the user can quit out of the loading
 * dialog without having to wait for the connection. Once the App is
 * rendered, its own `useInput` handler takes over.
 *
 * @param props - See {@link DashboardRootProps}.
 * @returns Either the loading dialog or the full dashboard.
 * @source
 */
export const DashboardRoot = ({ config }: DashboardRootProps) => {
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

  return <App key={sessionRef.current} client={client} config={config} />;
};
