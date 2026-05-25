import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchJpegBuffer, mjpegStream } from '../services/webcamImage';

/**
 * Connection / fetch lifecycle for the webcam image.
 *
 * - `idle`     — no fetch in flight, no data yet.
 * - `fetching` — request in flight (first fetch or a refresh).
 * - `ready`    — `frame` is populated with the last successful decode.
 * - `error`    — last fetch failed; `error` carries the message. Previous
 *                `frame`, if any, is preserved so the panel still shows the
 *                last good image.
 *
 * @source
 */
export type WebcamStatus = 'idle' | 'fetching' | 'ready' | 'error';

/**
 * Whether the hook is sitting idle / showing a snapshot, or actively polling.
 *
 * @source
 */
export type WebcamMode = 'snapshot' | 'stream';

/**
 * Return shape of {@link useWebcam}. Components consume `frame`, `status`,
 * `mode`, and `error`; trigger functions are stable so they can be wired to
 * keystroke handlers or external events (print-finished, error transitions)
 * without re-renders.
 *
 * @source
 */
export interface UseWebcamResult {
  /**
   * Raw JPEG bytes of the most recent fetch. `null` until the first
   * successful response lands. The panel picks the render path:
   * iTerm2 → hand the buffer to terminal-image; otherwise → decode it
   * with `decodeJpegToFrame` for half-block rendering.
   */
  readonly buffer: Buffer | null;
  readonly status: WebcamStatus;
  readonly mode: WebcamMode;
  readonly error?: string;
  /** Trigger a one-shot fetch of the snapshot URL (cancels any in-flight). */
  readonly snapshot: () => void;
  /**
   * Open the MJPEG stream URL and forward frames into `buffer` (rate-
   * limited to `streamMaxFps`). Aborts any in-flight snapshot or
   * existing stream before reconnecting.
   */
  readonly startStream: () => void;
  /** Close the MJPEG stream and revert mode to `'snapshot'`. */
  readonly stopStream: () => void;
}

/**
 * Config for {@link useWebcam}. Mirrors `DashboardConfig.webcam` — split
 * into host/port/path so each is independently overridable. The hook
 * assembles the full URL internally.
 *
 * @source
 */
export interface WebcamHookConfig {
  /** Webcam HTTP host (typically the printer host, but separable). */
  readonly host: string;
  /** Webcam HTTP port (mjpg-streamer / ustreamer default is `8080`). */
  readonly port: number;
  /** When `true`, fetch via `https://` instead of `http://`. */
  readonly secure?: boolean;
  /** Snapshot path, e.g. `/?action=snapshot`. */
  readonly snapshotPath: string;
  /** MJPEG stream path, e.g. `/?action=stream`. */
  readonly streamPath: string;
  /** Maximum frame rate to forward into state during streaming. */
  readonly streamMaxFps: number;
}

/**
 * State + transport hook for the webcam panel.
 *
 * Fetches raw JPEG bytes from the snapshot URL; the panel decides how to
 * render them (iTerm2 inline images vs the half-block fallback). External
 * events — print-completed transitions, error states — can drive snapshots
 * through `snapshot()` because the trigger functions are reference-stable.
 *
 * In `streaming` mode, a `setInterval` polls the snapshot URL at the chosen
 * cadence. Each tick aborts the previous in-flight fetch (via
 * `AbortController`) so slow frames don't pile up and the displayed image
 * never lags more than one poll behind.
 *
 * @param config - {@link WebcamHookConfig}.
 * @returns {@link UseWebcamResult}.
 *
 * @example
 * ```tsx
 * const webcam = useWebcam(config.webcam);
 * // Keystrokes:
 * if (key === 's') webcam.snapshot();
 * if (key === ' ') webcam.mode === 'stream' ? webcam.stopStream() : webcam.startStream();
 * ```
 * @source
 */
export const useWebcam = (config: WebcamHookConfig): UseWebcamResult => {
  const [buffer, setBuffer] = useState<Buffer | null>(null);
  const [status, setStatus] = useState<WebcamStatus>('idle');
  const [mode, setMode] = useState<WebcamMode>('snapshot');
  const [error, setError] = useState<string | undefined>(undefined);

  // Assemble URLs from the parts. Memoized so the callbacks below get
  // stable dependencies across re-renders. Scheme tracks `secure`; port
  // is elided when it matches the scheme default (80 / 443) so URLs read
  // naturally on typical HTTPS proxy setups.
  const baseUrl = useMemo(() => {
    const scheme = config.secure ? 'https' : 'http';
    const defaultPort = config.secure ? 443 : 80;
    const portSegment = config.port === defaultPort ? '' : `:${config.port}`;
    return `${scheme}://${config.host}${portSegment}`;
  }, [config.host, config.port, config.secure]);
  const snapshotUrl = useMemo(
    () => `${baseUrl}${config.snapshotPath}`,
    [baseUrl, config.snapshotPath],
  );
  const streamUrl = useMemo(
    () => `${baseUrl}${config.streamPath}`,
    [baseUrl, config.streamPath],
  );

  // Single AbortController for any in-flight network operation — snapshot
  // fetch OR streaming connection. Starting either aborts the previous;
  // stop / unmount aborts whatever's current.
  const abortRef = useRef<AbortController | null>(null);

  const fetchSnapshotOnce = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setStatus('fetching');
    try {
      const buf = await fetchJpegBuffer(snapshotUrl, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setBuffer(buf);
      setError(undefined);
      setStatus('ready');
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError((err as Error).message);
      setStatus('error');
    }
  }, [snapshotUrl]);

  const stopStream = useCallback((): void => {
    // Aborts the open MJPEG connection (or any in-flight snapshot fetch
    // that happens to be running). `setMode('snapshot')` flips the UI
    // chip back to the idle/snapshot style.
    abortRef.current?.abort();
    abortRef.current = null;
    setMode('snapshot');
  }, []);

  const startStream = useCallback((): void => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setMode('stream');
    setStatus('fetching');
    setError(undefined);

    // Throttle frame emission to `streamMaxFps`. The MJPEG server emits
    // frames as fast as the camera produces them (often 15–30 FPS); each
    // forwarded frame triggers a full dashboard re-render plus an
    // iTerm2 inline-image escape write, so capping the React-visible
    // rate keeps load bounded. Aim for "smooth enough"; raise `maxFps`
    // in config for higher fidelity, lower it for a low-impact view.
    const minIntervalMs = Math.max(0, Math.floor(1000 / Math.max(1, config.streamMaxFps)));
    let lastEmit = 0;

    const run = async (): Promise<void> => {
      try {
        for await (const frame of mjpegStream(streamUrl, ctrl.signal)) {
          if (ctrl.signal.aborted) return;
          const now = Date.now();
          if (now - lastEmit < minIntervalMs) continue;
          lastEmit = now;
          setBuffer(frame);
          setError(undefined);
          setStatus('ready');
        }
        // Stream ended cleanly (server closed connection). Treat as
        // idle — user can manually restart with `space` if desired.
        if (!ctrl.signal.aborted) {
          setMode('snapshot');
          setStatus('idle');
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setError((err as Error).message);
        setStatus('error');
      }
    };
    void run();
  }, [streamUrl, config.streamMaxFps]);

  const snapshot = useCallback((): void => {
    // A manual snapshot supersedes any active stream — the user wants a
    // stable single frame, not a moving target.
    stopStream();
    void fetchSnapshotOnce();
  }, [fetchSnapshotOnce, stopStream]);

  // Cleanup on unmount: abort whatever's currently in flight (stream
  // connection or snapshot fetch).
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return {
    buffer,
    status,
    mode,
    error,
    snapshot,
    startStream,
    stopStream,
  };
};
