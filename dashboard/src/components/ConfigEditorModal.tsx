import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, useInput } from 'react-curse';

import type { DashboardConfig } from '../config/index';
import { restoreDefaultConfig } from '../config/index';
import type { ConfigUpdater } from './DashboardRoot';
import { PanelFrame } from './PanelFrame';

/**
 * Props for {@link ConfigEditorModal}.
 *
 * @source
 */
export interface ConfigEditorModalProps {
  readonly config: DashboardConfig;
  readonly setConfig: ConfigUpdater;
  readonly onClose: () => void;
  readonly termWidth: number;
  readonly termHeight: number;
}

// =============================================================================
// Field model — a flat list of every editable scalar/boolean/enum field in
// the config. The user navigates this list; nested-object structure is
// captured by `path` so writes flow back to the right place.
// =============================================================================

type FieldType = 'string' | 'number' | 'boolean' | 'enum';

interface FieldDefinition {
  readonly label: string;
  readonly path: readonly string[];
  readonly type: FieldType;
  readonly options?: readonly string[];
  readonly description?: string;
}

/**
 * Editable scalar / boolean / enum fields in the config, in display order.
 *
 * Anything not in this list (sensors, deprecated header layout, etc.)
 * is shown read-only at the bottom of the modal with a hint that those
 * fields must be edited in YAML directly.
 *
 * The `path` array indexes into {@link DashboardConfig} from the root —
 * `getAtPath`/`setAtPath` walk it without needing per-field accessors.
 */
const FIELD_DEFS: readonly FieldDefinition[] = [
  // ----- Connection (server / port hot-edit triggers reconnect) -----------
  {
    label: 'Moonraker host',
    path: ['client', 'API', 'connection', 'server'],
    type: 'string',
    description: 'IP/hostname of the Moonraker server',
  },
  {
    label: 'Moonraker port',
    path: ['client', 'API', 'connection', 'port'],
    type: 'number',
    description: 'TCP port for Moonraker websocket (typically 7125)',
  },

  // ----- Webcam -----------------------------------------------------------
  { label: 'Webcam host', path: ['webcam', 'host'], type: 'string' },
  { label: 'Webcam port', path: ['webcam', 'port'], type: 'number' },
  { label: 'Webcam snapshot path', path: ['webcam', 'snapshotPath'], type: 'string' },
  { label: 'Webcam stream path', path: ['webcam', 'streamPath'], type: 'string' },
  {
    label: 'Webcam max FPS',
    path: ['webcam', 'streamMaxFps'],
    type: 'number',
    description: 'Frames per second cap (10–20 smooth, 2–5 low-impact)',
  },

  // ----- Layout / charts / console ---------------------------------------
  {
    label: 'Column split (0.1–0.9)',
    path: ['layout', 'columnSplit'],
    type: 'number',
    description: 'Left column fraction of terminal width',
  },
  {
    label: 'Chart renderer',
    path: ['charts', 'renderer'],
    type: 'enum',
    options: ['palette', 'braille'],
    description: 'palette = block chars, braille = higher-resolution dots',
  },
  {
    label: 'Console natural scroll',
    path: ['console', 'naturalScroll'],
    type: 'boolean',
    description: 'Wheel up = scroll back into history',
  },
  {
    label: 'Console debug log',
    path: ['console', 'debug'],
    type: 'boolean',
    description: 'Show ws lifecycle events as [D] lines (toggle with d)',
  },

  // ----- Sampling --------------------------------------------------------
  {
    label: 'History length',
    path: ['historyLength'],
    type: 'number',
    description: 'Samples retained per sensor (chart depth)',
  },
  {
    label: 'Sample interval (ms)',
    path: ['sampleIntervalMs'],
    type: 'number',
  },

  // ----- Startup ---------------------------------------------------------
  {
    label: 'Connection timeout (ms)',
    path: ['startup', 'connectionTimeoutMs'],
    type: 'number',
  },
  {
    label: 'Retry interval (ms)',
    path: ['startup', 'retryIntervalMs'],
    type: 'number',
  },

  // ----- File browser ----------------------------------------------------
  {
    label: 'File browser root',
    path: ['fileBrowser', 'root'],
    type: 'string',
    description: 'Moonraker root: gcodes, config, logs, timelapse',
  },
  {
    label: 'File browser download dir',
    path: ['fileBrowser', 'downloadDir'],
    type: 'string',
  },
  {
    label: 'File browser show thumbnails',
    path: ['fileBrowser', 'showThumbnails'],
    type: 'boolean',
  },
  {
    label: 'File browser thumbnail width (cells)',
    path: ['fileBrowser', 'thumbnailCellW'],
    type: 'number',
  },
  {
    label: 'File browser thumbnail height (cells)',
    path: ['fileBrowser', 'thumbnailCellH'],
    type: 'number',
  },
];

// =============================================================================
// Path walking — typed `unknown` because we walk through arbitrary nested
// objects. The fields list above guarantees the paths are valid for a
// well-formed config; misconfigured paths would surface as `undefined`
// at the leaf, which the renderer displays harmlessly.
// =============================================================================

const getAtPath = (
  obj: Record<string, unknown>,
  path: readonly string[],
): unknown => {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
};

const setAtPath = <T extends Record<string, unknown>>(
  obj: T,
  path: readonly string[],
  value: unknown,
): T => {
  if (path.length === 0) return value as T;
  const head = path[0];
  if (head === undefined) return obj;
  const rest = path.slice(1);
  const child = obj[head];
  const nextChild =
    rest.length === 0
      ? value
      : typeof child === 'object' && child !== null && !Array.isArray(child)
        ? setAtPath(child as Record<string, unknown>, rest, value)
        : setAtPath({}, rest, value);
  return { ...obj, [head]: nextChild };
};

// =============================================================================
// Value formatting / parsing — keeps the editor's string<-->typed coercion
// in one place so the renderer doesn't need to know each field's type.
// =============================================================================

const formatValue = (def: FieldDefinition, value: unknown): string => {
  if (def.type === 'boolean') return value === true ? 'true' : 'false';
  if (value === undefined || value === null) return '';
  return String(value);
};

interface ParseResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

const parseValue = (def: FieldDefinition, draft: string): ParseResult => {
  switch (def.type) {
    case 'string':
      return { ok: true, value: draft };
    case 'number': {
      const n = Number(draft);
      if (!Number.isFinite(n)) return { ok: false, error: 'must be a number' };
      return { ok: true, value: n };
    }
    case 'boolean': {
      const lc = draft.toLowerCase().trim();
      if (lc === 'true' || lc === 'yes' || lc === '1') return { ok: true, value: true };
      if (lc === 'false' || lc === 'no' || lc === '0') return { ok: true, value: false };
      return { ok: false, error: 'must be true or false' };
    }
    case 'enum': {
      if (def.options && def.options.includes(draft)) return { ok: true, value: draft };
      return { ok: false, error: `must be one of: ${def.options?.join(', ') ?? ''}` };
    }
    default:
      return { ok: false, error: 'unknown field type' };
  }
};

// =============================================================================
// Modal component
// =============================================================================

interface EditingState {
  readonly index: number;
  readonly draft: string;
}

interface Feedback {
  readonly text: string;
  readonly level: 'ok' | 'error';
}

/**
 * Full-screen modal for editing scalar / boolean / enum config fields.
 *
 * Navigation:
 *  - `↑`/`↓` — move selection.
 *  - `Enter` — edit (text/number) or toggle (boolean) or cycle (enum).
 *  - `r` — restore defaults (writes default to YAML + applies).
 *  - `Esc` — close.
 *
 * Edit-mode (text/number fields):
 *  - Typing appends to the draft.
 *  - `Backspace` removes the last char.
 *  - `Enter` validates + commits. On error the feedback line shows why.
 *  - `Esc` cancels the edit without committing.
 *
 * Changes persist to `~/.moonraker-dashboard/config.yaml` on every commit
 * (no separate save step) — `setConfig` is the {@link ConfigUpdater}
 * passed in from {@link DashboardRoot}, which writes YAML synchronously
 * inside the state update.
 *
 * @source
 */
export const ConfigEditorModal = ({
  config,
  setConfig,
  onClose,
  termWidth,
  termHeight,
}: ConfigEditorModalProps) => {
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  // Auto-clear feedback after a short delay so it doesn't linger forever.
  useEffect(() => {
    if (feedback === null) return;
    const id = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(id);
  }, [feedback]);

  // Pull current values out of the config once per render (memoized off
  // `config` reference so editor scroll feels instant when nothing's
  // changed).
  const fieldValues = useMemo(() => {
    const obj = config as unknown as Record<string, unknown>;
    return FIELD_DEFS.map((def) => getAtPath(obj, def.path));
  }, [config]);

  const commitValue = useCallback(
    (def: FieldDefinition, value: unknown): void => {
      setConfig((prev) => {
        const prevObj = prev as unknown as Record<string, unknown>;
        const next = setAtPath(prevObj, def.path, value);
        return next as unknown as DashboardConfig;
      });
      setFeedback({ text: `${def.label} → ${formatValue(def, value)}`, level: 'ok' });
    },
    [setConfig],
  );

  const restore = useCallback((): void => {
    try {
      const def = restoreDefaultConfig();
      setConfig(def);
      setFeedback({ text: 'Restored default config', level: 'ok' });
    } catch (err) {
      setFeedback({
        text: `Restore failed: ${(err as Error).message}`,
        level: 'error',
      });
    }
  }, [setConfig]);

  useInput(
    (input) => {
      // ----- Edit-mode keystrokes ---------------------------------------
      if (editing !== null) {
        const def = FIELD_DEFS[editing.index];
        if (def === undefined) {
          setEditing(null);
          return;
        }
        if (input === '\r' || input === '\n') {
          const parsed = parseValue(def, editing.draft);
          if (!parsed.ok) {
            setFeedback({ text: parsed.error ?? 'invalid', level: 'error' });
            return;
          }
          commitValue(def, parsed.value);
          setEditing(null);
          return;
        }
        if (input === '\x1b') {
          // Esc — cancel without committing.
          setEditing(null);
          return;
        }
        if (input === '\x7f' || input === '\b') {
          // Backspace (DEL = 0x7f on macOS, BS = 0x08 elsewhere).
          setEditing({ ...editing, draft: editing.draft.slice(0, -1) });
          return;
        }
        if (input.length === 1 && input >= ' ' && input <= '~') {
          // Printable ASCII — append to draft.
          setEditing({ ...editing, draft: editing.draft + input });
        }
        return;
      }

      // ----- Navigation-mode keystrokes ----------------------------------
      if (input === '\x1b') {
        onClose();
        return;
      }
      if (input === '\x1b[A') {
        // Up arrow.
        setSelected((s) => Math.max(0, s - 1));
        return;
      }
      if (input === '\x1b[B') {
        // Down arrow.
        setSelected((s) => Math.min(FIELD_DEFS.length - 1, s + 1));
        return;
      }
      if (input === '\r' || input === '\n') {
        const def = FIELD_DEFS[selected];
        if (def === undefined) return;
        if (def.type === 'boolean') {
          commitValue(def, !(fieldValues[selected] === true));
          return;
        }
        if (def.type === 'enum') {
          const opts = def.options ?? [];
          const cur = String(fieldValues[selected] ?? '');
          const idx = opts.indexOf(cur);
          const next = opts[(idx + 1) % Math.max(1, opts.length)];
          if (next !== undefined) commitValue(def, next);
          return;
        }
        // Text/number — drop into edit mode pre-populated with the
        // current value so users can tweak rather than retype.
        setEditing({
          index: selected,
          draft: formatValue(def, fieldValues[selected]),
        });
        return;
      }
      if (input === 'r' || input === 'R') {
        restore();
        return;
      }
    },
    [editing, selected, fieldValues, commitValue, restore, onClose],
  );

  // ----- Layout -----------------------------------------------------------
  // 80% of the terminal, centered, with a hard cap so the modal stays
  // readable on very large displays.
  const modalW = Math.min(100, Math.max(60, Math.floor(termWidth * 0.8)));
  const modalH = Math.min(40, Math.max(20, Math.floor(termHeight * 0.85)));
  const modalX = Math.max(0, Math.floor((termWidth - modalW) / 2));
  const modalY = Math.max(0, Math.floor((termHeight - modalH) / 2));
  const innerX = modalX + 2;
  const innerY = modalY + 1;
  const innerW = modalW - 4;
  // Reserve rows: title (1) + blank (1) + bottom hint (1) + sensors note
  // (1 if present) + feedback (1).
  const headerRows = 2;
  const footerRows = 3;
  const listRows = Math.max(5, modalH - 2 - headerRows - footerRows);

  // ----- Scroll the field list so the selected row is visible -----------
  const scrollStart = Math.max(
    0,
    Math.min(FIELD_DEFS.length - listRows, selected - Math.floor(listRows / 2)),
  );

  // ----- Column widths ---------------------------------------------------
  const labelW = Math.min(40, Math.floor(innerW * 0.5));
  const valueW = Math.max(10, innerW - labelW - 2);

  return (
    <>
      {/* Clear the inner area so any inline images underneath don't
          show through. Using a `block` Text with a space fill is the
          standard react-curse trick. */}
      <Text
        x={modalX + 1}
        y={modalY + 1}
        width={modalW - 2}
        height={modalH - 2}
        background="Black"
        block
      >
        {' '.repeat((modalW - 2) * (modalH - 2))}
      </Text>

      {/* Header */}
      <Text x={innerX} y={innerY} color="White" bold>
        Configuration
      </Text>
      <Text x={innerX} y={innerY + 1} color="BrightBlack">
        Enter: edit · ↑/↓: move · r: restore defaults · Esc: close
      </Text>

      {/* Field list */}
      {FIELD_DEFS.slice(scrollStart, scrollStart + listRows).map((def, i) => {
        const absIdx = scrollStart + i;
        const rowY = innerY + 2 + i;
        const isSelected = absIdx === selected;
        const value = fieldValues[absIdx];
        const isEditing = editing !== null && editing.index === absIdx;
        const valueText = isEditing
          ? `${editing.draft}_` // trailing underscore = cursor hint
          : formatValue(def, value);
        const valueColor = isEditing ? 'BrightYellow' : 'White';
        return (
          <Text
            key={def.path.join('.')}
            x={innerX}
            y={rowY}
            width={innerW}
            height={1}
            block
          >
            <Text x={0} color={isSelected ? 'BrightYellow' : 'BrightBlack'}>
              {isSelected ? '▶ ' : '  '}
            </Text>
            <Text x={2} color={isSelected ? 'White' : 'BrightBlack'}>
              {def.label.padEnd(labelW).slice(0, labelW)}
            </Text>
            <Text x={2 + labelW + 1} color={valueColor}>
              {valueText.padEnd(valueW).slice(0, valueW)}
            </Text>
          </Text>
        );
      })}

      {/* Description / feedback footer */}
      <Text
        x={innerX}
        y={innerY + 2 + listRows + 0}
        width={innerW}
        height={1}
        block
        color="BrightBlack"
        dim
      >
        {((): string => {
          const def = FIELD_DEFS[selected];
          return def?.description ?? '';
        })().padEnd(innerW).slice(0, innerW)}
      </Text>
      <Text
        x={innerX}
        y={innerY + 2 + listRows + 1}
        width={innerW}
        height={1}
        block
        color="BrightBlack"
        dim
      >
        {'Sensor list and complex fields: edit ~/.moonraker-dashboard/config.yaml directly.'
          .padEnd(innerW)
          .slice(0, innerW)}
      </Text>
      {feedback !== null && (
        <Text
          x={innerX}
          y={innerY + 2 + listRows + 2}
          width={innerW}
          height={1}
          block
          color={feedback.level === 'error' ? 'Red' : 'Green'}
        >
          {feedback.text.padEnd(innerW).slice(0, innerW)}
        </Text>
      )}

      {/* Border drawn last so it sits on top of the cleared interior. */}
      <PanelFrame
        x={modalX}
        y={modalY}
        width={modalW}
        height={modalH}
        title="Configuration"
        rightLabel="Esc close"
      />
    </>
  );
};
