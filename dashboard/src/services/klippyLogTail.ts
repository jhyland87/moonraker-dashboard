import type { MoonrakerClient } from '@jhyland87/moonraker-client';

/**
 * Default size, in bytes, of the trailing window requested from
 * `klippy.log` when no explicit value is passed. Matches the historical
 * size we have used everywhere in the dashboard, so callers don't have to
 * remember it.
 * @source
 */
export const DEFAULT_KLIPPY_LOG_TAIL_BYTES = 50_000;

/**
 * How long a cached fetch result stays "fresh enough" to satisfy a parallel
 * caller. Short enough that a real error event re-fetches near-real-time
 * data, long enough that two hooks mounting at app startup collapse to a
 * single network call.
 * @source
 */
export const KLIPPY_LOG_TAIL_CACHE_TTL_MS = 5_000;

/**
 * Internal cache entry — the in-flight (or already-settled) promise plus
 * the wall-clock time when the fetch was kicked off.
 */
interface CacheEntry {
  readonly promise: Promise<string>;
  readonly fetchedAt: number;
}

/**
 * Per-client TTL cache. `WeakMap` so the entry is GC-eligible if the
 * MoonrakerClient is ever discarded (e.g. on a reconnect that constructs a
 * new instance).
 */
const cache = new WeakMap<MoonrakerClient, CacheEntry>();

/**
 * Options for {@link fetchKlippyLogTail}.
 * @source
 */
export interface FetchKlippyLogTailOptions {
  /**
   * Force a fresh fetch even if a recent cached promise exists. Use this
   * when the caller actually needs *current* data (e.g. when a printer
   * just transitioned into error state), not just "any recent snapshot".
   */
  readonly fresh?: boolean;
  /**
   * Override the trailing window size. Defaults to
   * {@link DEFAULT_KLIPPY_LOG_TAIL_BYTES}.
   */
  readonly bytes?: number;
}

/**
 * Fetch a trailing chunk of the Klippy log via the websocket client, with
 * a short-TTL per-client cache that collapses concurrent calls.
 *
 * Two consumers (`useGcodeConsole` and `usePrinterErrors`) both want the
 * tail of `klippy.log` near app startup — without dedup, that's two
 * separate HTTP requests within milliseconds of each other for the same
 * payload. With this service, they share a single in-flight promise and
 * the second caller resolves against the same response.
 *
 * After the {@link KLIPPY_LOG_TAIL_CACHE_TTL_MS} window elapses, the next
 * call kicks off a new fetch and replaces the cache entry. Pass
 * `{ fresh: true }` to bypass the cache unconditionally.
 *
 * @param client - The websocket client to fetch through.
 * @param options - Optional overrides (see {@link FetchKlippyLogTailOptions}).
 * @returns A promise resolving to the UTF-8 text of the log tail.
 * @source
 */
export const fetchKlippyLogTail = (
  client: MoonrakerClient,
  options: FetchKlippyLogTailOptions = {},
): Promise<string> => {
  const bytes = options.bytes ?? DEFAULT_KLIPPY_LOG_TAIL_BYTES;
  const now = Date.now();
  const entry = cache.get(client);
  if (!options.fresh && entry && now - entry.fetchedAt < KLIPPY_LOG_TAIL_CACHE_TTL_MS) {
    return entry.promise;
  }
  const promise = client.getLogTail('klippy.log', bytes);
  cache.set(client, { promise, fetchedAt: now });
  return promise;
};

/**
 * Drop any cached log-tail promise for `client`. Useful in tests and for
 * forcing the next caller to do a real fetch.
 *
 * @param client - The client whose cache entry to evict.
 * @source
 */
export const invalidateKlippyLogTailCache = (client: MoonrakerClient): void => {
  cache.delete(client);
};
