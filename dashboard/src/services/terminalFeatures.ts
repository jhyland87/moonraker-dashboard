/**
 * @fileoverview Terminal capability detection helpers.
 *
 * Two layers here:
 *
 * 1. **Graphics protocol detection** ({@link getGraphicsSupport}) — wraps
 *    `supports-terminal-graphics`, which inspects env vars to decide whether
 *    the current terminal can render images via the Kitty, iTerm2, or Sixel
 *    protocol. The webcam panel picks its render path from this answer.
 *
 * 2. **iTerm2 `TERM_FEATURES` parsing** ({@link parseTerminalFeatures}) —
 *    a finer-grained dump of every capability iTerm2 advertises in the
 *    `TERM_FEATURES` env var (24BIT depth, HYPERLINKS, NOTIFICATIONS, etc).
 *    Useful for downstream features that want to enable optional polish
 *    when running under iTerm2 specifically.
 *
 * iTerm2 advertises supported features via `TERM_FEATURES` on the terminal
 * panes it spawns — a compact string like `T3LrMSc7UUw9Ts3BFGsSyHNoSxF`.
 * Each feature is a one- or two-letter code (always starting with an
 * uppercase letter; followed by optional lowercase letters); UInt-typed
 * features tack a numeric value on the end (`T3` = 24BIT depth 3). Booleans
 * just appear by their code.
 *
 * The iTerm2 docs list two codes both labeled `F` (FOCUS_REPORTING and
 * FILE); we resolve it the same way iTerm2 emits it in practice — first
 * `F` is FOCUS_REPORTING, FILE has no canonical single-letter prefix in
 * the current spec.
 */
import supportsTerminalGraphics, {
  type TerminalGraphicsSupport,
} from 'supports-terminal-graphics';

/**
 * Decoded {@link parseTerminalFeatures} result. Every property is optional —
 * absent means the running terminal didn't advertise that feature. Boolean
 * features are `true` when present; UInt features carry the version number
 * iTerm2 reported.
 *
 * @source
 */
export interface TerminalFeatures {
  readonly '24BIT'?: number;
  readonly CLIPBOARD_WRITABLE?: boolean;
  readonly DECSLRM?: boolean;
  readonly MOUSE?: boolean;
  readonly DECSCUSR?: number;
  readonly UNICODE_BASIC?: boolean;
  readonly AMBIGUOUS_WIDE?: boolean;
  readonly UNICODE_WIDTHS?: number;
  readonly TITLES?: number;
  readonly BRACKETED_PASTE?: boolean;
  readonly FOCUS_REPORTING?: boolean;
  readonly STRIKETHROUGH?: boolean;
  readonly OVERLINE?: boolean;
  readonly SYNC?: boolean;
  readonly HYPERLINKS?: boolean;
  readonly NOTIFICATIONS?: boolean;
  readonly SIXEL?: boolean;
  readonly FILE?: boolean;
  readonly PROGRESS?: boolean;
}

/**
 * Static lookup from code → feature spec. Keys are the letters-only portion
 * of each `TERM_FEATURES` token (digits get parsed separately as the value).
 *
 * `kind: 'uint'` features expect trailing digits; `kind: 'bool'` features
 * have none. We track that distinction so a malformed entry — e.g. `Sc`
 * without a number — doesn't silently land in the result as `NaN`.
 */
const CODE_TABLE = {
  T: { name: '24BIT', kind: 'uint' },
  Cw: { name: 'CLIPBOARD_WRITABLE', kind: 'bool' },
  Lr: { name: 'DECSLRM', kind: 'bool' },
  M: { name: 'MOUSE', kind: 'bool' },
  Sc: { name: 'DECSCUSR', kind: 'uint' },
  U: { name: 'UNICODE_BASIC', kind: 'bool' },
  Aw: { name: 'AMBIGUOUS_WIDE', kind: 'bool' },
  Uw: { name: 'UNICODE_WIDTHS', kind: 'uint' },
  Ts: { name: 'TITLES', kind: 'uint' },
  B: { name: 'BRACKETED_PASTE', kind: 'bool' },
  F: { name: 'FOCUS_REPORTING', kind: 'bool' },
  Gs: { name: 'STRIKETHROUGH', kind: 'bool' },
  Go: { name: 'OVERLINE', kind: 'bool' },
  Sy: { name: 'SYNC', kind: 'bool' },
  H: { name: 'HYPERLINKS', kind: 'bool' },
  No: { name: 'NOTIFICATIONS', kind: 'bool' },
  Sx: { name: 'SIXEL', kind: 'bool' },
  P: { name: 'PROGRESS', kind: 'bool' },
} as const satisfies Record<string, { name: keyof TerminalFeatures; kind: 'uint' | 'bool' }>;

/**
 * Detect which terminal graphics protocols the current `process.stdout`
 * supports — Kitty, iTerm2 inline images, and/or Sixel. Delegates to
 * `supports-terminal-graphics`, which probes env vars set by all the major
 * graphics-capable terminals (iTerm2, WezTerm, Konsole, Ghostty, Kitty,
 * Rio, VS Code, mintty, …). Use this instead of hand-rolling
 * `TERM_PROGRAM === 'iTerm.app'` checks: the package's matrix is more
 * accurate and stays up to date as new terminals add support.
 *
 * @returns `{ kitty, iterm2, sixel }` — three booleans for stdout.
 *
 * @example
 * ```ts
 * const g = getGraphicsSupport();
 * if (g.iterm2) renderInlineImage();
 * else if (g.kitty) renderKittyImage();
 * else renderHalfBlocks();
 * ```
 * @source
 */
export const getGraphicsSupport = (): TerminalGraphicsSupport =>
  supportsTerminalGraphics.stdout;

/**
 * Parse an iTerm2 `TERM_FEATURES`-style capability string into a structured
 * dictionary. Returns an empty object when the input is `undefined` / empty
 * / contains no recognizable codes — never throws.
 *
 * The regex groups each capability into a single token — one uppercase
 * letter, then any lowercase letters, then any digits (the UInt value for
 * UInt-typed features). We then split letters from digits and map the
 * letters through {@link CODE_TABLE}. Unknown codes are skipped silently —
 * iTerm2 adds new codes over time, and we'd rather ignore unknowns than
 * crash a dashboard launch.
 *
 * @param raw - The raw env-var value, typically `process.env.TERM_FEATURES`.
 * @returns A {@link TerminalFeatures} dictionary.
 *
 * @example
 * ```ts
 * const f = parseTerminalFeatures('T3LrMSc7UUw9Ts3BFGsSyHNoSxF');
 * // f['24BIT']       === 3
 * // f.SIXEL          === true
 * // f.DECSCUSR       === 7
 * // f.HYPERLINKS     === true
 * ```
 * @source
 */
export const parseTerminalFeatures = (raw: string | undefined): TerminalFeatures => {
  if (!raw) return {};
  const tokens = raw.match(/[A-Z][a-z]*\d*/g);
  if (!tokens) return {};
  // Mutable scratchpad — narrowed to TerminalFeatures on return. Using
  // `Record<string, unknown>` here keeps the assignment expressions simple
  // without sprinkling `as` casts; the return type confines it back.
  const out: Record<string, unknown> = {};
  for (const tok of tokens) {
    const split = /^([A-Z][a-z]*)(\d*)$/.exec(tok);
    if (!split) continue;
    const code = split[1];
    const digits = split[2] ?? '';
    if (code === undefined) continue;
    const spec = (CODE_TABLE as Record<string, { name: string; kind: 'uint' | 'bool' }>)[code];
    if (!spec) continue;
    if (spec.kind === 'uint') {
      // Missing digits on a UInt code is a malformed entry — skip it.
      if (digits.length === 0) continue;
      const n = Number(digits);
      if (!Number.isFinite(n)) continue;
      out[spec.name] = n;
    } else {
      out[spec.name] = true;
    }
  }
  return out as TerminalFeatures;
};

/**
 * Convenience wrapper around {@link parseTerminalFeatures} that reads
 * `process.env.TERM_FEATURES` directly.
 *
 * @returns The current terminal's advertised feature dictionary.
 *
 * @example
 * ```ts
 * const features = getTerminalFeatures();
 * if (features.SIXEL) renderInlineImage();
 * ```
 * @source
 */
export const getTerminalFeatures = (): TerminalFeatures =>
  parseTerminalFeatures(process.env['TERM_FEATURES']);

