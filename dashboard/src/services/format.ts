/**
 * Pure formatting helpers shared between presentational components. These
 * are intentionally side-effect-free and don't import from `react-curse`
 * or anything else so they can be exercised directly with vitest.
 *
 * Convention: every helper either accepts `undefined`/missing inputs and
 * returns an em-dash placeholder, or returns a sensible empty string.
 * Components should not have to special-case missing data.
 */

/**
 * Em-dash placeholder rendered when a value is missing. Defined once so a
 * future change (e.g. a localized "n/a") only needs to land here.
 * @source
 */
export const MISSING_VALUE = '—';

/**
 * Truncate `s` to `max` visible characters. When the string is too long,
 * the last visible character is replaced by `…` so the cap is respected.
 *
 * @param s - The input string.
 * @param max - Maximum number of characters to keep (including the `…`).
 * @returns Either `s` unchanged or a truncated form ending with `…`.
 * @source
 */
export const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

/**
 * Format a number of seconds as a short, human-readable duration.
 *
 * Examples:
 *   `fmtDuration(0)` → `"—"`
 *   `fmtDuration(45)` → `"45s"`
 *   `fmtDuration(125)` → `"2m 5s"`
 *   `fmtDuration(7350)` → `"2h 2m"`
 *
 * @param sec - Duration in seconds (may be undefined or non-positive).
 * @returns A short string, or {@link MISSING_VALUE} if the input is missing.
 * @source
 */
export const fmtDuration = (sec: number | undefined): string => {
  if (sec === undefined || !Number.isFinite(sec) || sec <= 0) return MISSING_VALUE;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
};

/**
 * Format an uptime in seconds as a coarser-grained string than
 * {@link fmtDuration} — days are surfaced.
 *
 * Examples:
 *   `fmtUptime(120)` → `"2m"`
 *   `fmtUptime(7350)` → `"2h 2m"`
 *   `fmtUptime(186400)` → `"2d 3h"`
 *
 * @param sec - Uptime in seconds.
 * @returns A short string, or {@link MISSING_VALUE} if the input is missing.
 * @source
 */
export const fmtUptime = (sec: number | undefined): string => {
  if (sec === undefined || !Number.isFinite(sec) || sec <= 0) return MISSING_VALUE;
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

/**
 * Format a memory size in KB as either `"NN KB"` or `"NN MB"` depending on
 * magnitude.
 *
 * @param kb - Size in kilobytes.
 * @returns A short string, or {@link MISSING_VALUE} if the input is missing.
 * @source
 */
export const fmtMemory = (kb: number | undefined): string => {
  if (kb === undefined || !Number.isFinite(kb)) return MISSING_VALUE;
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
  return `${kb} KB`;
};

/**
 * Format a transfer rate in bytes per second as B/s, KB/s, or MB/s
 * depending on magnitude.
 *
 * @param bytesPerSec - Throughput in bytes per second.
 * @returns A short string with units.
 * @source
 */
export const fmtBandwidth = (bytesPerSec: number): string => {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return MISSING_VALUE;
  if (bytesPerSec >= 1_000_000) return `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1000) return `${(bytesPerSec / 1000).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
};

/**
 * Format a percentage with a fixed number of digits after the decimal
 * point. Returns the missing-value placeholder when the input is
 * undefined or non-finite.
 *
 * @param v - The percentage value (e.g. `12.34`).
 * @param digits - Number of digits to retain after the decimal point.
 * @returns The formatted string (e.g. `"12.34%"`) or {@link MISSING_VALUE}.
 * @source
 */
export const fmtPercent = (v: number | undefined, digits: number = 2): string =>
  v === undefined || !Number.isFinite(v) ? MISSING_VALUE : `${v.toFixed(digits)}%`;

/**
 * Format a number with a fixed precision, falling back to
 * {@link MISSING_VALUE} on undefined / NaN.
 *
 * @param v - The value.
 * @param digits - Digits after the decimal point.
 * @returns The formatted string, or {@link MISSING_VALUE} if missing.
 * @source
 */
export const fmtFixed = (v: number | undefined, digits: number): string =>
  v === undefined || !Number.isFinite(v) ? MISSING_VALUE : v.toFixed(digits);
