import type { MoonrakerClient } from '@jhyland87/moonraker-client';
import { useEffect, useState } from 'react';

/**
 * Dictionary of Klipper extended G-code commands available on the current
 * printer — `{ COMMAND: 'description' }`. Empty until the first successful
 * fetch (or if the request failed).
 *
 * @source
 */
export type GcodeHelp = Readonly<Record<string, string>>;

const EMPTY: GcodeHelp = Object.freeze({});

/**
 * One-shot fetch of `printer.gcode.help` on mount.
 *
 * The dictionary is fixed for the lifetime of a Klipper instance — it's only
 * rebuilt across a `RESTART`/`FIRMWARE_RESTART`. The dashboard remounts `App`
 * on every reconnect (`DashboardRoot` bumps a session key), and `App` only
 * mounts once the socket is open (`LoadingDialog` gates it). So a single
 * `getGcodeHelp()` call per mount picks up any Klipper-side changes
 * naturally — no `'open'` listener, no polling.
 *
 * Failures are swallowed; the autocomplete just stays empty.
 *
 * @param client - The shared {@link MoonrakerClient}; assumed open at mount.
 * @returns The fetched dictionary, or `{}` until the first response lands.
 *
 * @example
 * ```tsx
 * const help = useGcodeHelp(client);
 * <ConsolePanel commands={help} … />
 * ```
 * @source
 */
export const useGcodeHelp = (client: MoonrakerClient): GcodeHelp => {
  const [help, setHelp] = useState<GcodeHelp>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const result = await client.getGcodeHelp();
        if (!cancelled) setHelp(result);
      } catch {
        // Klipper not ready, transport hiccup, etc. — silently keep the
        // previous (possibly empty) dictionary so the UI keeps rendering.
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [client]);

  return help;
};
