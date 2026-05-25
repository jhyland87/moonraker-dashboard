import { useMemo } from 'react';
import { Text } from 'react-curse';

import { PanelFrame } from './PanelFrame';
import { HOTKEY_SECTIONS, type Hotkey } from '../services/hotkeys';

/**
 * Props for {@link HelpModal}.
 *
 * @source
 */
export interface HelpModalProps {
  readonly termWidth: number;
  readonly termHeight: number;
  /**
   * Centralized hotkey list (typically the memoized result of
   * `buildHotkeys(config.sensors)`). The modal groups entries by
   * `section` and renders them in the order they appear in the list,
   * within each section.
   */
  readonly hotkeys: readonly Hotkey[];
}

/** Internal row spec — flattened from sections for sequential rendering. */
type Row =
  | { readonly kind: 'title'; readonly text: string }
  | { readonly kind: 'binding'; readonly key: string; readonly description: string }
  | { readonly kind: 'blank' }
  | { readonly kind: 'hint'; readonly text: string };

/** Width of the key column inside the modal (left-padded). */
const KEY_COL_W = 12;
/** Left-padding of every content row (cols inside the border). */
const CONTENT_PAD = 2;
/** Min / max width for the modal — clamps to terminal width when small. */
const MODAL_MIN_W = 50;
const MODAL_MAX_W = 70;

/**
 * Centered help modal listing every dashboard hotkey, grouped by section.
 *
 * Pure renderer: takes the hotkey list as a prop, groups by
 * `Hotkey.section` (ordered by {@link HOTKEY_SECTIONS}), and displays
 * each binding's `displayKey` (or first `keys` entry as fallback) plus
 * its `description`. Sections with no bindings are omitted automatically.
 *
 * No knowledge of *what* the keys do or *when* they apply — that all
 * lives in `services/hotkeys.ts`. Adding a hotkey there shows up here
 * with no edits required.
 *
 * Render-order note: should be rendered *last* in the parent so its
 * `PanelFrame` borders and content cells land on top of everything
 * else. Inline-image components (webcam, thumbnail) re-emit their
 * iTerm2 escapes on every render and would otherwise overlap the
 * modal — the parent gates them off (renders `null`) while the modal
 * is open, and their unmount cleanup clears the image cells first.
 *
 * @param props - See {@link HelpModalProps}.
 * @returns The modal element, or `null` if the terminal is too small.
 *
 * @example
 * ```tsx
 * const hotkeys = useMemo(() => buildHotkeys(config.sensors), [config.sensors]);
 * {helpOpen && (
 *   <HelpModal termWidth={width} termHeight={height} hotkeys={hotkeys} />
 * )}
 * ```
 * @source
 */
export const HelpModal = ({ termWidth, termHeight, hotkeys }: HelpModalProps) => {
  const rows = useMemo<readonly Row[]>(() => {
    // Map each hotkey to its display form, grouped by section in
    // HOTKEY_SECTIONS order. Drop sections that ended up empty (e.g. no
    // sensors → "Sensors" section disappears).
    const out: Row[] = [];
    const sectionsRendered: string[] = [];
    for (const section of HOTKEY_SECTIONS) {
      const entries = hotkeys.filter((hk) => hk.section === section.id);
      if (entries.length === 0) continue;
      if (sectionsRendered.length > 0) out.push({ kind: 'blank' });
      sectionsRendered.push(section.id);
      out.push({ kind: 'title', text: section.title });
      for (const hk of entries) {
        out.push({
          kind: 'binding',
          // Prefer the pretty `displayKey` (e.g. "Ctrl-C", "↑/↓",
          // "space"). Fall back to the first raw key, then a placeholder
          // so we never crash on an entry with no keys at all.
          key: hk.displayKey ?? hk.keys[0] ?? '?',
          description: hk.description,
        });
      }
    }
    out.push({ kind: 'blank' });
    out.push({ kind: 'hint', text: 'Press ? or Esc to close' });
    return out;
  }, [hotkeys]);

  // Sizing: width is clamped; height is derived from row count + borders.
  const modalW = Math.max(MODAL_MIN_W, Math.min(MODAL_MAX_W, termWidth - 4));
  const modalH = rows.length + 2; // +2 for top/bottom border
  if (termWidth < MODAL_MIN_W || termHeight < modalH) return null;

  const x = Math.max(0, Math.floor((termWidth - modalW) / 2));
  const y = Math.max(0, Math.floor((termHeight - modalH) / 2));
  const innerX = x + 1;
  const innerW = modalW - 2;
  // Key column starts after the left content padding.
  const descX = CONTENT_PAD + KEY_COL_W + 1;

  return (
    <>
      {rows.map((r, i) => {
        const rowY = y + 1 + i;
        // Block-fill each row so anything previously drawn behind the
        // modal — sensor table, chart, sparklines — gets cleanly
        // overwritten with the background (black) instead of bleeding
        // through the gaps between text.
        switch (r.kind) {
          case 'title':
            return (
              <Text
                key={i}
                x={innerX}
                y={rowY}
                width={innerW}
                height={1}
                background="Black"
                block
              >
                <Text x={CONTENT_PAD} color="Yellow" bold>
                  {r.text}
                </Text>
              </Text>
            );
          case 'binding':
            return (
              <Text
                key={i}
                x={innerX}
                y={rowY}
                width={innerW}
                height={1}
                background="Black"
                block
              >
                <Text x={CONTENT_PAD + 1} color="Cyan" bold>
                  {r.key.padEnd(KEY_COL_W)}
                </Text>
                <Text x={descX + 1} color="White">
                  {r.description}
                </Text>
              </Text>
            );
          case 'hint':
            return (
              <Text
                key={i}
                x={innerX}
                y={rowY}
                width={innerW}
                height={1}
                background="Black"
                block
              >
                <Text x={CONTENT_PAD} color="BrightBlack" dim>
                  {r.text}
                </Text>
              </Text>
            );
          case 'blank':
          default:
            return (
              <Text
                key={i}
                x={innerX}
                y={rowY}
                width={innerW}
                height={1}
                background="Black"
                block
              >
                <Text> </Text>
              </Text>
            );
        }
      })}
      {/* Border last so its side bars overwrite the block-fill edge columns. */}
      <PanelFrame
        x={x}
        y={y}
        width={modalW}
        height={modalH}
        title="Help"
        accent="Yellow"
        titleColor="Yellow"
      />
    </>
  );
};
