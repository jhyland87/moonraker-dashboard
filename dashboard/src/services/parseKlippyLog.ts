/**
 * Parse a tail of klippy.log into a deduplicated list of error-like events.
 *
 * Klipper logs are line-oriented with the prefix:
 *   `[LEVEL] YYYY-MM-DD HH:MM:SS,mmm [logger] [module:func:line] message`
 *
 * Forks (notably Creality K-series) emit additional `[RAISE_ERROR]` and
 * `--Self Test N = ..., Error!!--` markers that don't appear in upstream
 * Klipper, so the detector covers both.
 */

export type LogErrorCategory =
  | 'gcode_error'
  | 'raise_error'
  | 'self_test'
  | 'mcu_shutdown'
  | 'traceback'
  | 'transition'
  | 'other';

export interface ParsedLogError {
  readonly timestamp?: string;
  readonly level: 'WARNING' | 'ERROR' | 'CRITICAL' | 'INFO' | 'UNKNOWN';
  readonly category: LogErrorCategory;
  readonly code?: string;
  readonly message: string;
  readonly source?: string;
}

const HEADER_RE =
  /^\[(?<level>[A-Za-z ]+?)\]\s+(?<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:,\d+)?\s+\[[^\]]*\]\s+(?<source>\[[^\]]+\])\s*(?<rest>.*)$/;

const CODE_RE = /'code':\s*'([^']+)'/;
const MSG_RE = /'msg':\s*'([^']*)'/;

const NOISE_RES: readonly RegExp[] = [
  /\[statistics:generate_stats:/,
  /_handle_query/,
  /--Self Test \d+ = .*?, Pass!!--/,
  /\[(?:SET_HOT_TEMPS|SET_BED_TEMPS)\]/,
  /err_z=/,
];

const isNoise = (line: string): boolean => NOISE_RES.some((re) => re.test(line));

const parseHeader = (
  line: string,
): { level: ParsedLogError['level']; timestamp?: string; source?: string; rest: string } => {
  const m = HEADER_RE.exec(line);
  if (!m?.groups) return { level: 'UNKNOWN', rest: line };
  const rawLevel = m.groups.level?.trim().toUpperCase();
  const level: ParsedLogError['level'] =
    rawLevel === 'WARNING' || rawLevel === 'ERROR' || rawLevel === 'CRITICAL' || rawLevel === 'INFO'
      ? rawLevel
      : 'UNKNOWN';
  return {
    level,
    timestamp: m.groups.ts,
    source: m.groups.source,
    rest: m.groups.rest ?? '',
  };
};

const extractCodeMsg = (text: string): { code?: string; msg?: string } => ({
  code: CODE_RE.exec(text)?.[1],
  msg: MSG_RE.exec(text)?.[1],
});

interface Detector {
  readonly category: LogErrorCategory;
  readonly test: (rest: string, fullLine: string) => boolean;
  readonly extract: (rest: string, fullLine: string) => { code?: string; message: string };
}

const DETECTORS: readonly Detector[] = [
  {
    category: 'traceback',
    test: (_rest, line) => /Traceback \(most recent call last\)/.test(line),
    extract: () => ({ message: 'Python traceback' }),
  },
  {
    category: 'mcu_shutdown',
    test: (_rest, line) => /MCU '.+?' shutdown|Transition to shutdown state/.test(line),
    extract: (rest, line) => {
      const m = /(MCU '.+?' shutdown.*|Transition to shutdown state.*)$/.exec(rest || line);
      return { message: (m?.[1] ?? rest ?? line).trim() };
    },
  },
  {
    category: 'transition',
    test: (_rest, line) => /Klipper state: (?:Shutdown|Disconnect|Error)/.test(line),
    extract: (rest, line) => {
      const m = /(Klipper state: \S+.*)$/.exec(rest || line);
      return { message: (m?.[1] ?? rest ?? line).trim() };
    },
  },
  {
    category: 'gcode_error',
    test: (_rest, line) => /\[gcode:_respond_error:/.test(line),
    extract: (rest) => {
      const { code, msg } = extractCodeMsg(rest);
      return { code, message: msg ?? rest.trim() };
    },
  },
  {
    category: 'raise_error',
    test: (_rest, line) => /\[RAISE_ERROR\]\s*\{/.test(line),
    extract: (rest) => {
      const { code, msg } = extractCodeMsg(rest);
      return { code, message: msg ?? rest.trim() };
    },
  },
  {
    category: 'self_test',
    test: (_rest, line) => /--Self Test \d+ = .*?, Error!!--/.test(line),
    extract: (_rest, line) => {
      const m = /--Self Test \d+ = ([^,]+), Error!!--(?: Error CH:\[(.*?)\])?/.exec(line);
      const code = m?.[1]?.trim();
      const ch = m?.[2];
      return {
        code,
        message: ch ? `Self-test error: ${code} (CH ${ch})` : `Self-test error: ${code ?? ''}`,
      };
    },
  },
];

/**
 * Parse a klippy.log tail. Lines are scanned in order; the first matching
 * detector wins. Results are deduplicated by `(category, code, message)` —
 * Klipper often emits the same warning many times during the same incident.
 *
 * Returned entries are in newest-last order (the order they appear in the
 * file). Callers that want newest-first should reverse.
 */
export const parseKlippyLog = (tail: string, max: number = 20): readonly ParsedLogError[] => {
  const seen = new Set<string>();
  const out: ParsedLogError[] = [];

  const lines = tail.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line || isNoise(line)) continue;

    const header = parseHeader(line);
    for (const det of DETECTORS) {
      if (!det.test(header.rest, line)) continue;
      const { code, message } = det.extract(header.rest, line);
      const key = `${det.category}|${code ?? ''}|${message}`;
      if (seen.has(key)) break;
      seen.add(key);
      out.push({
        timestamp: header.timestamp,
        level: header.level,
        category: det.category,
        code,
        message,
        source: header.source,
      });
      break;
    }
  }

  if (out.length <= max) return out;
  return out.slice(out.length - max);
};
