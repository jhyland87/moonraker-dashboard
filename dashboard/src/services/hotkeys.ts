/**
 * @fileoverview Central registry for every dashboard hotkey.
 *
 * One source of truth for: the raw key bytes that trigger each action,
 * the conditions under which it fires, the action itself, and the
 * human-readable description / section shown in the help modal. Both
 * the dispatcher in `App.tsx` and the renderer in `HelpModal.tsx` read
 * from {@link buildHotkeys}, so descriptions can never drift from
 * behavior.
 *
 * Some hotkeys are implemented inside `ConsolePanel` (where the input-
 * focus state and history-navigation logic naturally live) and not by
 * the app-level dispatcher. Those carry `ownedBy: 'console'`:
 *
 * - The dispatcher skips them (so it doesn't fight the panel's own
 *   `useInput` for the same keystrokes).
 * - The help modal still lists them so users see the full picture.
 */

import type { SensorConfig } from '../types/index';

/**
 * Top-level grouping for the help modal. Stable order — sections appear
 * in the order declared here, regardless of how entries are added to
 * {@link buildHotkeys}.
 *
 * @source
 */
export const HOTKEY_SECTIONS = [
  { id: 'navigation', title: 'Navigation' },
  { id: 'sensors', title: 'Sensor visibility (chart)' },
  { id: 'webcam', title: 'Webcam (panel open)' },
  { id: 'console-view', title: 'Console (view mode)' },
  { id: 'console-input', title: 'Console (input mode)' },
  { id: 'bed-mesh', title: 'Bed mesh (panel open)' },
] as const;

/**
 * String-literal union of valid section ids. Derived from {@link HOTKEY_SECTIONS}
 * so adding a new section is a one-place edit.
 *
 * @source
 */
export type HotkeySection = (typeof HOTKEY_SECTIONS)[number]['id'];

/**
 * Snapshot of the dashboard state hotkey predicates need to read. Refreshed
 * by App.tsx every render before invoking the dispatcher.
 *
 * @source
 */
export interface HotkeyState {
  readonly consoleInputFocused: boolean;
  readonly consoleOpen: boolean;
  readonly bedMeshOpen: boolean;
  readonly webcamOpen: boolean;
  readonly helpOpen: boolean;
  /** File browser modal is up. Blocks every other app hotkey while open. */
  readonly fileBrowserOpen: boolean;
  /** Whether the webcam hook is currently polling (vs idle/paused). */
  readonly webcamStreaming: boolean;
  /** Webcam is rendered fullscreen, covering every other panel. */
  readonly webcamFullscreen: boolean;
  /** Config editor modal is up. Blocks every other app hotkey while open. */
  readonly configEditorOpen: boolean;
}

/**
 * Side-effect surface hotkeys can act on. Each method is bound in App.tsx
 * to the actual hook/setter, then the bundle is handed to the dispatcher.
 *
 * @source
 */
export interface HotkeyActions {
  readonly setHelpOpen: (updater: boolean | ((prev: boolean) => boolean)) => void;
  readonly setBedMeshOpen: (updater: boolean | ((prev: boolean) => boolean)) => void;
  readonly setWebcamOpen: (updater: boolean | ((prev: boolean) => boolean)) => void;
  readonly setFileBrowserOpen: (updater: boolean | ((prev: boolean) => boolean)) => void;
  readonly setConfigEditorOpen: (updater: boolean | ((prev: boolean) => boolean)) => void;
  /** Flip console visibility (open ↔ closed). Console is non-modal — view-mode is just another panel. */
  readonly toggleConsole: () => void;
  readonly refreshBedMesh: () => void;
  readonly webcamSnapshot: () => void;
  readonly webcamToggleStream: () => void;
  /** Flip the webcam between inline panel and fullscreen overlay. */
  readonly toggleWebcamFullscreen: () => void;
  /**
   * Force react-curse to do a full repaint on the next render —
   * useful after something painted cells outside react-curse's
   * virtual buffer (inline-image OSCs, sixel pixels) and left
   * those cells in a state react-curse's diff doesn't recognize.
   */
  readonly forceRedraw: () => void;
  /**
   * Diagnostic: blank the visible screen at the TTY level without
   * touching react-curse's virtual buffer. The next render's diff
   * sees no changes for cells whose content matches what react-curse
   * last wrote, so only cells that actually change between renders
   * get repainted — handy for visualizing what react-curse is
   * actively writing each frame. Pair with `forceRedraw` to restore.
   */
  readonly diagnosticClear: () => void;
  readonly toggleSensorVisibility: (toggleKey: string) => void;
  /** Tear down the WS client + alt-screen + process.exit. */
  readonly quit: () => void;
}

/**
 * Bundled state + actions passed to predicates and handlers.
 *
 * @source
 */
export interface HotkeyContext {
  readonly state: HotkeyState;
  readonly actions: HotkeyActions;
}

/**
 * A single hotkey definition. The metadata fields (`keys`, `displayKey`,
 * `section`, `description`) are read by the help modal; `when` and `action`
 * are read by the dispatcher.
 *
 * @source
 */
export interface Hotkey {
  /** Stable identifier — used as React key, for debugging, and for ordering. */
  readonly id: string;
  /**
   * Raw input strings that trigger this hotkey. e.g. `['w', 'W']` for
   * case-insensitive matching; `['\x1b']` for Esc; `[' ']` for space;
   * `['\x03']` for Ctrl-C; arrow keys are CSI sequences like `'\x1b[A'`.
   */
  readonly keys: readonly string[];
  /**
   * Pretty key name for the help modal. Defaults to `keys[0]`. Use this
   * for entries where the raw bytes aren't readable (e.g. `'\x1b'` →
   * `'Esc'`, `'\x03'` → `'Ctrl-C'`, `' '` → `'space'`, CSI arrow keys →
   * `'↑/↓'`).
   */
  readonly displayKey?: string;
  /** Which section in the help modal. */
  readonly section: HotkeySection;
  /** Human-readable description for the help modal. */
  readonly description: string;
  /**
   * Who handles the keystroke:
   * - `'app'`  — `App.tsx`'s top-level `useInput` dispatches via
   *   {@link Hotkey.when} / {@link Hotkey.action}.
   * - `'console'` — implemented inside `ConsolePanel`'s own input loop
   *   (close coupling with input-focus and history-nav state). The
   *   dispatcher skips these so it doesn't double-fire.
   */
  readonly ownedBy: 'app' | 'console';
  /**
   * Predicate gating when the hotkey is allowed to fire. Required for
   * `ownedBy: 'app'`; ignored for `ownedBy: 'console'`. The dispatcher
   * walks the list in declaration order and fires the first hotkey
   * whose `keys.includes(input)` *and* `when(ctx)` returns true — so
   * order more-specific entries before broader fallbacks.
   */
  readonly when?: (ctx: HotkeyContext) => boolean;
  /** What to do when the hotkey fires. */
  readonly action?: (ctx: HotkeyContext) => void;
}

/**
 * Build the canonical hotkey list. Sensor toggle entries are generated
 * dynamically from `sensors` so they always match config.
 *
 * **Ordering matters.** The dispatcher fires the *first* matching entry,
 * so more-specific entries (webcam-only `s`, bed-mesh `Esc`) come before
 * broader fallbacks (sensor letters, generic toggles).
 *
 * @param sensors - The configured sensor list, for sensor toggle hotkeys.
 * @returns Frozen list of hotkey definitions.
 *
 * @example
 * ```ts
 * const hotkeys = useMemo(() => buildHotkeys(config.sensors), [config.sensors]);
 * useInput((input) => dispatchHotkey(input, hotkeys, { state, actions }));
 * ```
 * @source
 */
export const buildHotkeys = (sensors: readonly SensorConfig[]): readonly Hotkey[] => {
  // Common guards expressed as predicate helpers — keeps the entries below
  // readable and ensures the same condition is spelled the same way every
  // time it's reused.
  const notTyping = (ctx: HotkeyContext): boolean => !ctx.state.consoleInputFocused;
  // `noModal` means: not typing into the console AND no modal overlay
  // (help, file browser) is currently capturing input. The file browser
  // owns its own input loop, so all app hotkeys are gated off while it's
  // open — same treatment as the help modal.
  const noModal = (ctx: HotkeyContext): boolean =>
    notTyping(ctx) &&
    !ctx.state.helpOpen &&
    !ctx.state.fileBrowserOpen &&
    !ctx.state.configEditorOpen;

  return [
    // ----- Always-on safety hatch ---------------------------------------
    {
      id: 'force-quit',
      keys: ['\x03'],
      displayKey: 'Ctrl-C',
      section: 'navigation',
      description: 'Force quit (always works)',
      ownedBy: 'app',
      when: () => true,
      action: (ctx) => ctx.actions.quit(),
    },

    // ----- Diagnostic: clear screen + force redraw ----------------------
    // Ctrl-L blanks the TTY *without* touching react-curse's prevBuffer,
    // so the next render's diff redraws only cells that genuinely
    // changed between frames. Useful for figuring out which panels are
    // animating and which are static. Ctrl-R restores the full screen
    // by emitting a synthetic `resize` event, which sets react-curse's
    // `isResized` flag — the next render is then a full repaint that
    // ignores prevBuffer.
    //
    // Both gated on `notTyping` only (no modal-open block) — they're
    // diagnostic affordances that should work even when overlays are
    // up; the side effect is purely visual and clears itself on the
    // next render.
    {
      id: 'diagnostic-clear',
      keys: ['\x0c'],
      displayKey: 'Ctrl-L',
      section: 'navigation',
      description:
        'Diagnostic: blank screen (only re-drawn cells will reappear)',
      ownedBy: 'app',
      when: notTyping,
      action: (ctx) => ctx.actions.diagnosticClear(),
    },
    {
      id: 'force-redraw',
      keys: ['\x12'],
      displayKey: 'Ctrl-R',
      section: 'navigation',
      description: 'Force full screen repaint',
      ownedBy: 'app',
      when: notTyping,
      action: (ctx) => ctx.actions.forceRedraw(),
    },

    // ----- Help modal toggle (works even when other modals own things) --
    {
      id: 'help',
      keys: ['?'],
      section: 'navigation',
      description: 'Show / hide this help',
      ownedBy: 'app',
      when: notTyping,
      action: (ctx) => ctx.actions.setHelpOpen((prev) => !prev),
    },

    // ----- Webcam fullscreen Esc (declared before bed-mesh / help Esc) --
    // Higher priority than bed-mesh-close so a single Esc exits the
    // fullscreen overlay even if the bed-mesh panel happens to also be
    // open underneath (it's hidden while fullscreen is on, but the
    // state flag is still true).
    {
      id: 'webcam-fullscreen-close',
      keys: ['\x1b'],
      displayKey: 'Esc',
      section: 'webcam',
      description: 'Exit webcam fullscreen',
      ownedBy: 'app',
      when: (ctx) => notTyping(ctx) && ctx.state.webcamFullscreen,
      action: (ctx) => ctx.actions.toggleWebcamFullscreen(),
    },

    // ----- Bed-mesh-specific Esc (declared before global Esc handlers) --
    {
      id: 'bed-mesh-close',
      keys: ['\x1b'],
      displayKey: 'Esc',
      section: 'bed-mesh',
      description: 'Close bed mesh',
      ownedBy: 'app',
      when: (ctx) => noModal(ctx) && ctx.state.bedMeshOpen,
      action: (ctx) => ctx.actions.setBedMeshOpen(false),
    },

    // ----- Webcam panel-internal keys (only while panel is open) --------
    {
      id: 'webcam-snapshot',
      keys: ['s', 'S'],
      section: 'webcam',
      description: 'Retrieve snapshot',
      ownedBy: 'app',
      when: (ctx) => noModal(ctx) && ctx.state.webcamOpen,
      action: (ctx) => ctx.actions.webcamSnapshot(),
    },
    {
      id: 'webcam-stream-toggle',
      keys: [' '],
      displayKey: 'space',
      section: 'webcam',
      description: 'Toggle stream manually',
      ownedBy: 'app',
      when: (ctx) => noModal(ctx) && ctx.state.webcamOpen,
      action: (ctx) => ctx.actions.webcamToggleStream(),
    },
    {
      id: 'webcam-fullscreen-toggle',
      keys: ['z', 'Z'],
      section: 'webcam',
      description: 'Toggle fullscreen (aspect preserved)',
      ownedBy: 'app',
      when: (ctx) => noModal(ctx) && ctx.state.webcamOpen,
      action: (ctx) => ctx.actions.toggleWebcamFullscreen(),
    },

    // ----- Panel toggles ------------------------------------------------
    {
      id: 'toggle-webcam',
      keys: ['w', 'W'],
      section: 'navigation',
      description: 'Toggle webcam panel',
      ownedBy: 'app',
      when: noModal,
      action: (ctx) => ctx.actions.setWebcamOpen((prev) => !prev),
    },
    {
      id: 'toggle-bed-mesh',
      keys: ['h', 'H'],
      section: 'navigation',
      description: 'Toggle bed mesh',
      ownedBy: 'app',
      when: noModal,
      action: (ctx) => {
        ctx.actions.setBedMeshOpen((prev) => {
          if (!prev) ctx.actions.refreshBedMesh();
          return !prev;
        });
      },
    },
    {
      id: 'toggle-console',
      keys: ['c', 'C'],
      section: 'navigation',
      description: 'Toggle console feed',
      ownedBy: 'app',
      when: noModal,
      action: (ctx) => ctx.actions.toggleConsole(),
    },
    {
      id: 'open-file-browser',
      keys: ['o', 'O'],
      section: 'navigation',
      description: 'Open file browser',
      ownedBy: 'app',
      when: noModal,
      action: (ctx) => ctx.actions.setFileBrowserOpen(true),
    },
    {
      id: 'open-config-editor',
      keys: ['p', 'P'],
      section: 'navigation',
      description: 'Open config editor (preferences)',
      ownedBy: 'app',
      when: noModal,
      action: (ctx) => ctx.actions.setConfigEditorOpen(true),
    },

    // ----- Quit ----------------------------------------------------------
    {
      id: 'quit',
      keys: ['q'],
      section: 'navigation',
      description: 'Quit',
      ownedBy: 'app',
      // Console used to swallow `q` to close itself; it's now a non-modal
      // panel, so `q` always quits regardless of console visibility (the
      // only gate is the input mode — that's covered by `notTyping`).
      when: noModal,
      action: (ctx) => ctx.actions.quit(),
    },

    // ----- Sensor toggles (dynamic) -------------------------------------
    // Available regardless of which panels are visible — the dispatcher's
    // first-match-wins ordering already routes `s` / `space` to the
    // webcam entries above when the webcam panel is open. Only sensor
    // letters that happen to collide with `s` / `space` would be
    // shadowed (and only while the webcam is open) — a fair trade for
    // letting every other sensor toggle work everywhere.
    ...sensors.map<Hotkey>((s) => ({
      id: `sensor-${s.toggleKey}`,
      keys: [s.toggleKey.toLowerCase(), s.toggleKey.toUpperCase()],
      displayKey: s.toggleKey,
      section: 'sensors',
      description: `Toggle ${s.label}`,
      ownedBy: 'app',
      when: noModal,
      action: (ctx) => ctx.actions.toggleSensorVisibility(s.toggleKey),
    })),

    // ----- Help-modal dismiss (declared last so bed-mesh's Esc wins) ----
    {
      id: 'help-close',
      keys: ['\x1b'],
      displayKey: 'Esc',
      section: 'navigation',
      description: 'Close help modal',
      ownedBy: 'app',
      when: (ctx) => ctx.state.helpOpen,
      action: (ctx) => ctx.actions.setHelpOpen(false),
    },

    // ----- Console (info-only — handled inside ConsolePanel) ------------
    // The dispatcher skips these. They're listed so the help modal can
    // surface them in the same place as everything else.
    {
      id: 'console-focus-input',
      keys: ['i', 'I'],
      section: 'console-view',
      description: 'Focus input (start typing)',
      ownedBy: 'console',
    },
    {
      id: 'console-scroll',
      keys: ['\x1b[A', '\x1b[B'],
      displayKey: '↑/↓',
      section: 'console-view',
      description: 'Scroll feed history',
      ownedBy: 'console',
    },
    {
      id: 'console-toggle-debug',
      keys: ['d', 'D'],
      section: 'console-view',
      description: 'Toggle debug log',
      ownedBy: 'console',
    },
    {
      id: 'console-send',
      keys: ['\r', '\n'],
      displayKey: 'Enter',
      section: 'console-input',
      description: 'Send command (or accept highlighted suggestion)',
      ownedBy: 'console',
    },
    {
      id: 'console-autocomplete',
      keys: ['\t'],
      displayKey: 'Tab',
      section: 'console-input',
      description: 'Autocomplete with highlighted suggestion',
      ownedBy: 'console',
    },
    {
      id: 'console-history-nav',
      keys: ['\x1b[A', '\x1b[B'],
      displayKey: '↑/↓',
      section: 'console-input',
      description: 'History / suggestion navigation',
      ownedBy: 'console',
    },
    {
      id: 'console-stop-typing',
      keys: ['\x1b'],
      displayKey: 'Esc',
      section: 'console-input',
      description: 'Stop typing (back to view mode)',
      ownedBy: 'console',
    },
  ];
};

/**
 * Dispatch a raw keystroke through a list of hotkeys.
 *
 * Walks the list in declaration order; fires the first `app`-owned entry
 * whose `keys` contains the input and whose `when(ctx)` returns `true`.
 * Returns whether anything fired — primarily for debugging / tests.
 *
 * Hotkeys owned by other components (`ownedBy: 'console'`) are skipped
 * unconditionally so this dispatcher doesn't race with those components'
 * own input handlers.
 *
 * @param input - The raw keystroke string from react-curse's `useInput`.
 * @param hotkeys - The hotkey list (typically the memoized result of
 *   {@link buildHotkeys}).
 * @param ctx - Current dashboard state + actions.
 * @returns `true` when a hotkey fired, `false` otherwise.
 *
 * @example
 * ```ts
 * useInput(
 *   (input) => { dispatchHotkey(input, hotkeys, ctxRef.current); },
 *   [hotkeys],
 * );
 * ```
 * @source
 */
export const dispatchHotkey = (
  input: string,
  hotkeys: readonly Hotkey[],
  ctx: HotkeyContext,
): boolean => {
  for (const hk of hotkeys) {
    if (hk.ownedBy !== 'app') continue;
    if (!hk.keys.includes(input)) continue;
    // Wrap the predicate too — a `when` that throws shouldn't either
    // fire the action (since we don't know if the gate passed) nor
    // crash the whole input loop.
    let allowed: boolean;
    try {
      allowed = hk.when ? hk.when(ctx) : true;
    } catch (err) {
      writeHotkeyError(`hotkey ${hk.id} 'when' threw`, err);
      return true; // Consumed — don't fall through to a later match.
    }
    if (!allowed) continue;
    try {
      hk.action?.(ctx);
    } catch (err) {
      // A buggy action used to crash react-curse's event emitter (fatal
      // since the dashboard's input becomes unresponsive). Swallow here
      // and record the error so it's diagnosable without breaking the
      // whole TUI.
      writeHotkeyError(`hotkey ${hk.id} action threw`, err);
    }
    return true;
  }
  return false;
};

/**
 * Best-effort error logger that doesn't corrupt the alt-screen TUI.
 *
 * We can't use `console.error` because react-curse owns stdout — emitting
 * text there would scribble over the rendered dashboard. `stderr` is
 * separate and survives the alt-screen, but it's invisible while the
 * dashboard is running. To capture both audiences we write to stderr
 * (visible in the *outer* terminal once the dashboard exits) and also
 * stash on a global so other tooling (a debug overlay, a status bar)
 * can surface it.
 */
const writeHotkeyError = (label: string, err: unknown): void => {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  // Write to stderr — stays out of react-curse's stdout buffer.
  process.stderr.write(`[hotkey] ${label}: ${message}\n`);
  // Stash on globalThis so an in-app debug surface can read it later
  // without coupling this service to React state.
  (globalThis as { __lastHotkeyError?: string }).__lastHotkeyError =
    `${label}: ${message}`;
};
