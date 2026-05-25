import type { GcodeFileMetadata, MoonrakerClient } from '@jhyland87/moonraker-client';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Text, useInput } from 'react-curse';

import { PanelFrame } from './PanelFrame';
import type { UseFileBrowserResult } from '../hooks/useFileBrowser';
import {
  COLUMN_CATALOG,
  basename,
  filterRows,
  fmtBytes,
  fmtDateRelative,
  fmtDurationShort,
  type ColumnSpec,
  type FileRow,
} from '../services/fileBrowser';
import {
  buildIterm2ImageEscape,
  clearTerminalRect,
  writeInlineImageAt,
} from '../services/inlineImage';
import { getGraphicsSupport } from '../services/terminalFeatures';
import {
  buildThumbnailUrl,
  fetchThumbnailPng,
  pickBestThumbnail,
} from '../services/thumbnail';

/**
 * Inline-image protocol availability — looked up once. Drives whether
 * the thumbnail rendering branch is enabled at all (other terminals
 * silently fall back to the no-thumbnail layout regardless of config).
 */
const USE_INLINE_IMAGES = getGraphicsSupport().iterm2;

/**
 * Module-scope thumbnail cache. Survives the modal's mount lifecycle so
 * reopening it doesn't re-download the same PNGs. Persists for the
 * dashboard's lifetime — entries are keyed by gcode filename, values
 * are the raw PNG bytes ready to hand to {@link buildIterm2ImageEscape}.
 *
 * Unbounded — a printer with 100 files at ~2 KB each is only ~200 KB.
 * If that ever becomes a concern, swap in an LRU here.
 */
const THUMB_CACHE = new Map<string, Buffer>();

/**
 * Per-file metadata cache. Populated lazily for whatever's currently
 * visible — `useFileBrowser` first tries the bulk `gcode_metadata`
 * database namespace, but that's not reliably populated on every
 * Moonraker setup. When it's missing fields for a row, we fall back to
 * `server.files.metadata` per-file and cache the result here so future
 * renders (column values + thumbnail lookup) reuse it.
 *
 * Module-scope so cached entries survive modal close/reopen — same
 * trade-off as THUMB_CACHE.
 */
const METADATA_CACHE = new Map<string, GcodeFileMetadata>();

/**
 * Files we've already kicked a fetch for this dashboard session.
 * Prevents the fire-on-render effect from sending duplicate requests
 * for the same file (whether for its metadata or its thumbnail PNG).
 * Files whose metadata fetch failed, or whose metadata reports no
 * thumbnails, also land here so we don't loop forever retrying.
 */
const FETCH_ATTEMPTED = new Set<string>();

/**
 * Props for {@link FileBrowserModal}.
 *
 * @source
 */
export interface FileBrowserModalProps {
  readonly browser: UseFileBrowserResult;
  /** Moonraker client — needed to build thumbnail URLs against its httpBaseUrl. */
  readonly client: MoonrakerClient;
  readonly termWidth: number;
  readonly termHeight: number;
  /** Column ids to display, in order. Drawn from `COLUMN_CATALOG`. */
  readonly visibleColumns: readonly string[];
  /** File extensions hint for the user (e.g. `'.gcode'`). Empty = "Files". */
  readonly extensionsHint: readonly string[];
  /** Show the slicer thumbnail next to each row when iTerm2 inline images are available. */
  readonly showThumbnails: boolean;
  /** Width in cells of each row's thumbnail (when shown). */
  readonly thumbnailCellW: number;
  /** Height in cells of each row's thumbnail (when shown). */
  readonly thumbnailCellH: number;
  /** Called when the modal should close (user pressed Esc). */
  readonly onClose: () => void;
}

/** Pad / truncate a string to exactly `width` chars, left- or right-aligned. */
const pad = (s: string, width: number, align: 'left' | 'right' = 'left'): string => {
  if (s.length === width) return s;
  if (s.length > width) return `${s.slice(0, Math.max(0, width - 1))}…`;
  return align === 'right' ? s.padStart(width, ' ') : s.padEnd(width, ' ');
};

/** Lightweight confirmation overlay drawn inside the modal area. */
interface ConfirmState {
  readonly message: string;
  readonly onConfirm: () => void;
}

/**
 * Full-screen file browser modal.
 *
 * Layout:
 * - Top border ("Files" or "Files: .gcode") with selection count.
 * - Optional filter row when the user has entered filter mode (`/`).
 * - Header row (column titles).
 * - Body: one row per file. Cursor row highlighted; selected rows
 *   marked with `■` in the leading checkbox column.
 * - Status row at the bottom: action message (if any), file count,
 *   horizontal-scroll indicator.
 * - Hint row: keybindings cheat sheet.
 *
 * Hotkeys (inside the modal — App.tsx blocks its own dispatcher while
 * the browser is open):
 *
 * | Key | Action |
 * |---|---|
 * | `↑` / `↓` | Move cursor |
 * | `PgUp` / `PgDn` | Jump by page |
 * | `Home` / `End` | First / last row |
 * | `←` / `→` | Scroll columns horizontally |
 * | `space` | Toggle selection on cursor row |
 * | `a` | Select all (visible) |
 * | `c` | Clear selection |
 * | `Enter` | Print cursor file (gcode) |
 * | `d` | Delete selected (confirms) |
 * | `s` | Download selected → `downloadDir` |
 * | `r` | Refresh list |
 * | `/` | Enter filter mode (type, Enter to apply, Esc to cancel) |
 * | `Esc` | Close modal |
 *
 * @param props - See {@link FileBrowserModalProps}.
 * @returns The modal element.
 *
 * @source
 */
export const FileBrowserModal = ({
  browser,
  client,
  termWidth,
  termHeight,
  visibleColumns,
  extensionsHint,
  showThumbnails: showThumbnailsRequested,
  thumbnailCellW,
  thumbnailCellH,
  onClose,
}: FileBrowserModalProps) => {
  // Only actually render thumbnails when the terminal supports the
  // protocol — silently fall back to the no-thumbnails layout otherwise
  // rather than reserving space for images that will never show.
  const thumbnailsActive = showThumbnailsRequested && USE_INLINE_IMAGES;
  // 1 cell per row normally; 2+ cells when thumbnails are on so the
  // PNG has somewhere to render. The thumbnail height drives row height
  // exactly so columns line up flush with the bottom of the image.
  const rowHeight = thumbnailsActive ? Math.max(1, thumbnailCellH) : 1;
  // Pad after the thumbnail (in cells) before the checkbox column.
  const thumbColW = thumbnailsActive ? thumbnailCellW + 1 : 0;
  // Resolve column ids → ColumnSpec[]. Unknown ids are dropped.
  const columns: readonly ColumnSpec[] = useMemo(
    () =>
      visibleColumns
        .map((id) => COLUMN_CATALOG[id])
        .filter((spec): spec is ColumnSpec => spec !== undefined),
    [visibleColumns],
  );

  // Filter state: typed query + whether the input is currently focused.
  const [filter, setFilter] = useState('');
  const [filterFocused, setFilterFocused] = useState(false);
  // Cursor position + horizontal scroll offset (in cells).
  const [cursor, setCursor] = useState(0);
  const [hScroll, setHScroll] = useState(0);
  // Confirmation prompt for destructive actions (delete).
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  // Side-panel toggle — when on, the body splits so the right portion
  // shows the cursor row's full metadata. Drives `i` in the input loop
  // and the layout-math below.
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Per-file metadata cache version — bumped whenever the fetch effect
  // lands a new entry in METADATA_CACHE or THUMB_CACHE. Used to
  // recompute `filteredRows` so rows with freshly-fetched metadata pick
  // up their column values (and thumbnail rendering kicks in).
  const [cacheVersion, setCacheVersion] = useState(0);

  // Apply the typed filter to the row set, then merge in any per-file
  // metadata we've fetched on-demand. The bulk `gcode_metadata` lookup
  // in `useFileBrowser` populates `row.meta` when it works; this
  // overlay covers Moonraker setups where the bulk namespace is empty
  // or stale (which is most of them in practice).
  const filteredRowsRaw = useMemo(
    () => filterRows(browser.rows, filter),
    [browser.rows, filter],
  );
  const filteredRows = useMemo(() => {
    void cacheVersion; // re-run when cache mutates
    return filteredRowsRaw.map((row) =>
      row.meta
        ? row
        : { ...row, meta: METADATA_CACHE.get(row.entry.path) ?? null },
    );
  }, [filteredRowsRaw, cacheVersion]);

  // Clamp cursor if the row set shrinks under us (filter, delete, refresh).
  useEffect(() => {
    if (cursor >= filteredRows.length) {
      setCursor(Math.max(0, filteredRows.length - 1));
    }
  }, [filteredRows.length, cursor]);

  // ----- Geometry -------------------------------------------------------
  // Reserve borders + chrome rows; the rest is the file list body.
  const modalW = Math.max(60, termWidth - 4);
  const modalH = Math.max(15, termHeight - 4);
  const modalX = Math.max(0, Math.floor((termWidth - modalW) / 2));
  const modalY = Math.max(0, Math.floor((termHeight - modalH) / 2));
  const innerX = modalX + 1;
  const innerW = modalW - 2;
  // Reserve the bottom 4 rows for status + action message + hint + bottom
  // border, and the top 3 for top border + filter (if visible) + header.
  const headerY = modalY + 2;
  const bodyY = headerY + 1;
  const hintY = modalY + modalH - 2;
  const statusY = hintY - 1;
  const actionMsgY = statusY - 1;
  const bodyH = Math.max(1, actionMsgY - bodyY);
  // Logical row count — one file per row, but each row spans `rowHeight`
  // terminal cells when thumbnails are on.
  const visibleRowCount = Math.max(1, Math.floor(bodyH / rowHeight));

  // ----- Body split (list left, details right when toggled) ------------
  // The list always claims the full body width when the details panel is
  // hidden. When `detailsOpen` is true we carve off ~38% of the inner
  // width for the details panel, with a 1-char gap between them.
  // Minimums protect against squashing either side into uselessness on a
  // narrow terminal.
  const DETAILS_GAP = 1;
  const detailsWidth = detailsOpen
    ? Math.max(28, Math.min(48, Math.floor(innerW * 0.38)))
    : 0;
  const listWidth =
    detailsOpen
      ? Math.max(24, innerW - detailsWidth - DETAILS_GAP)
      : innerW;
  const detailsX = innerX + listWidth + DETAILS_GAP;

  // ----- Column layout (with horizontal scrolling) ----------------------
  // Each column is fixed-width; we compose a single "wide line" per row
  // and slice it to the visible window starting at `hScroll`. The
  // leading 2-cell checkbox marker is part of the wide line so the
  // selection state scrolls with the data.
  const CHECK_W = 3;
  const colSeparator = ' '; // 1-cell gap between columns
  const widthOfColumns = columns.reduce(
    (sum, col) => sum + col.width + colSeparator.length,
    0,
  );
  const totalLineW = CHECK_W + widthOfColumns;
  const visibleLineW = Math.max(1, listWidth - 2);
  const maxHScroll = Math.max(0, totalLineW - visibleLineW);
  // Clamp hScroll when the column set shrinks (e.g. terminal resize).
  useEffect(() => {
    if (hScroll > maxHScroll) setHScroll(maxHScroll);
  }, [hScroll, maxHScroll]);

  /** Compose one full-width line for either the header or a row. */
  const buildLine = (row: FileRow | null, checkChar: string): string => {
    const parts: string[] = [`${checkChar} `];
    for (const col of columns) {
      const value = row === null ? col.title : col.render(row);
      parts.push(pad(value, col.width, col.align ?? 'left'));
      parts.push(colSeparator);
    }
    return parts.join('').slice(hScroll, hScroll + visibleLineW);
  };

  // ----- Input handling -------------------------------------------------
  useInput(
    (input) => {
      // Confirmation prompt mode — y/Y confirms, anything else cancels.
      if (confirm !== null) {
        if (input === 'y' || input === 'Y') {
          const { onConfirm } = confirm;
          setConfirm(null);
          onConfirm();
        } else {
          setConfirm(null);
        }
        return;
      }

      // Filter input mode — capture printable chars into the filter
      // string; Enter applies, Esc cancels.
      if (filterFocused) {
        if (input === '\x1b') {
          setFilter('');
          setFilterFocused(false);
          return;
        }
        if (input === '\r' || input === '\n') {
          setFilterFocused(false);
          return;
        }
        if (input === '\x7f' || input === '\b') {
          setFilter((prev) => prev.slice(0, -1));
          return;
        }
        if (input.length === 1 && input >= ' ' && input !== '\x7f') {
          setFilter((prev) => prev + input);
        }
        return;
      }

      // Navigation + actions.
      if (input === '\x1b') {
        onClose();
        return;
      }
      if (input === '\x1b[A' || input === '\x10') {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (input === '\x1b[B' || input === '\x0e') {
        setCursor((c) => Math.min(filteredRows.length - 1, c + 1));
        return;
      }
      if (input === '\x1b[5~') {
        // PgUp
        setCursor((c) => Math.max(0, c - visibleRowCount));
        return;
      }
      if (input === '\x1b[6~') {
        // PgDn
        setCursor((c) => Math.min(filteredRows.length - 1, c + visibleRowCount));
        return;
      }
      if (input === '\x1b[H' || input === '\x1b[1~') {
        setCursor(0);
        return;
      }
      if (input === '\x1b[F' || input === '\x1b[4~') {
        setCursor(Math.max(0, filteredRows.length - 1));
        return;
      }
      if (input === '\x1b[D') {
        // ← horizontal scroll left
        setHScroll((s) => Math.max(0, s - 4));
        return;
      }
      if (input === '\x1b[C') {
        // → horizontal scroll right
        setHScroll((s) => Math.min(maxHScroll, s + 4));
        return;
      }
      if (input === ' ') {
        const row = filteredRows[cursor];
        if (row) browser.select(row.entry.path, !browser.selected.has(row.entry.path));
        return;
      }
      if (input === 'a' || input === 'A') {
        for (const row of filteredRows) browser.select(row.entry.path, true);
        return;
      }
      if (input === 'c' || input === 'C') {
        browser.clearSelection();
        return;
      }
      if (input === '\r' || input === '\n') {
        const row = filteredRows[cursor];
        if (!row) return;
        setConfirm({
          message: `Start print: ${row.entry.path}?  (y/N)`,
          onConfirm: () => void browser.printOne(row.entry.path),
        });
        return;
      }
      if (input === 'd' || input === 'D') {
        const count = browser.selected.size;
        if (count === 0) return;
        setConfirm({
          message: `Delete ${count} file${count === 1 ? '' : 's'}?  (y/N)`,
          onConfirm: () => void browser.deleteSelected(),
        });
        return;
      }
      if (input === 's' || input === 'S') {
        if (browser.selected.size === 0) return;
        void browser.downloadSelected();
        return;
      }
      if (input === 'r' || input === 'R') {
        browser.refresh();
        return;
      }
      if (input === 'i' || input === 'I') {
        setDetailsOpen((open) => !open);
        return;
      }
      if (input === '/') {
        setFilterFocused(true);
        return;
      }
    },
    [
      browser,
      cursor,
      filteredRows,
      visibleRowCount,
      maxHScroll,
      filterFocused,
      confirm,
      onClose,
    ],
  );

  // ----- Render ---------------------------------------------------------
  // Body slice: window of `visibleRowCount` file rows centered on the cursor.
  const firstVisibleRow = Math.max(
    0,
    Math.min(
      cursor - Math.floor(visibleRowCount / 2),
      filteredRows.length - visibleRowCount,
    ),
  );
  const lastVisibleRow = Math.min(filteredRows.length, firstVisibleRow + visibleRowCount);
  const visibleRows = filteredRows.slice(firstVisibleRow, lastVisibleRow);

  // ----- Lazy per-file fetch (metadata + thumbnail) -------------------
  // Mount-tracking ref so async fetches don't try to setState after the
  // modal closes mid-flight.
  const stillMountedRef = useRef(true);
  useEffect(() => {
    stillMountedRef.current = true;
    return () => {
      stillMountedRef.current = false;
    };
  }, []);

  // For every visible row that lacks metadata in our local caches,
  // kick a `server.files.metadata` fetch. When that lands AND
  // thumbnails are active AND the file has thumbnails, also fetch the
  // PNG and stash it in THUMB_CACHE. Both caches share one fetch per
  // file (so we don't double-request).
  //
  // Why per-file: the bulk `gcode_metadata` database namespace isn't
  // reliably populated across Moonraker setups — many have an empty or
  // out-of-date namespace, leaving `row.meta = null` for everything.
  // Per-file `server.files.metadata` is the canonical endpoint and
  // always works as long as the file's actually been sliced with
  // thumbnail/metadata support.
  //
  // `FETCH_ATTEMPTED` is the dedupe gate: marks files we've tried
  // already so a re-render or scroll doesn't re-fire the same request.
  useEffect(() => {
    for (const row of visibleRows) {
      const name = row.entry.path;
      if (FETCH_ATTEMPTED.has(name)) continue;
      const haveMeta = row.meta !== null || METADATA_CACHE.has(name);
      const haveThumb = !thumbnailsActive || THUMB_CACHE.has(name);
      if (haveMeta && haveThumb) continue;
      FETCH_ATTEMPTED.add(name);

      const run = async (): Promise<void> => {
        try {
          // Ensure we have metadata — fetch + cache if missing.
          let meta = row.meta ?? METADATA_CACHE.get(name);
          if (!meta) {
            meta = await client.getFileMetadata(name);
            METADATA_CACHE.set(name, meta);
          }
          // Then the thumbnail PNG, when wanted and available.
          if (
            thumbnailsActive &&
            !THUMB_CACHE.has(name) &&
            meta.thumbnails &&
            meta.thumbnails.length > 0
          ) {
            const thumb = pickBestThumbnail(meta.thumbnails, 100);
            if (thumb) {
              const url = buildThumbnailUrl(client, thumb.relative_path);
              const buf = await fetchThumbnailPng(url);
              THUMB_CACHE.set(name, buf);
            }
          }
          if (stillMountedRef.current) {
            setCacheVersion((tick) => tick + 1);
          }
        } catch {
          // Silent fail — FETCH_ATTEMPTED keeps us from retrying. If
          // you want refresh (`r`) to retry failed files, clear the
          // relevant entries from FETCH_ATTEMPTED in browser.refresh.
        }
      };
      void run();
    }
  }, [thumbnailsActive, client, visibleRows]);

  // Emit the iTerm2 inline-image escape for every visible cached
  // thumbnail. Re-emit on **every render** (no deps) so the images
  // survive any subsequent dashboard repaint that might touch the cells
  // — same pattern as ThumbnailDisplay / WebcamPanel.
  //
  // The base64 of each thumbnail is computed fresh per emit; for 1–6 KB
  // PNGs across <20 visible rows that's a few hundred microseconds per
  // dashboard tick — negligible compared to the network fetch saved by
  // the cache. If profiling ever pegs this, memoize the encoded escape
  // per (buffer, w, h) tuple.
  useLayoutEffect(() => {
    if (!thumbnailsActive) return;
    for (let i = 0; i < visibleRows.length; i++) {
      const row = visibleRows[i];
      if (!row) continue;
      const buf = THUMB_CACHE.get(row.entry.path);
      if (!buf) continue;
      const esc = buildIterm2ImageEscape(buf, thumbnailCellW, thumbnailCellH);
      writeInlineImageAt(esc, innerX, bodyY + i * rowHeight);
    }
    // `cacheVersion` is read implicitly via THUMB_CACHE — listed in deps
    // (via the explicit no-deps array equivalent of "every render") so
    // a fresh fetch triggers an immediate re-paint.
    void cacheVersion;
  });

  // Geometry tracker for the unmount cleanup. Capturing in a ref lets
  // the empty-deps effect below see the latest values without
  // re-binding the cleanup on every render.
  const thumbStripRef = useRef({ x: 0, y: 0, w: 0, h: 0 });
  thumbStripRef.current = {
    x: innerX,
    y: bodyY,
    w: thumbColW,
    h: visibleRowCount * rowHeight,
  };
  // Clear the entire thumbnail strip on unmount so the next-frame
  // dashboard repaint isn't ghosted by leftover iTerm2 images.
  useEffect(() => {
    return () => {
      if (!USE_INLINE_IMAGES) return;
      const strip = thumbStripRef.current;
      if (strip.w > 0 && strip.h > 0) {
        clearTerminalRect(strip.x, strip.y, strip.w, strip.h);
      }
    };
  }, []);

  const title = extensionsHint.length > 0 ? `Files: ${extensionsHint.join(' ')}` : 'Files';
  const rightLabel =
    browser.selected.size > 0
      ? `${browser.selected.size} selected · ${filteredRows.length} shown`
      : `${filteredRows.length} files`;

  const showFilterRow = filterFocused || filter.length > 0;
  // Bump body start down by 1 when the filter row is active.
  const filterRowY = modalY + 1;
  const effectiveHeaderY = showFilterRow ? headerY + 0 : headerY;
  void effectiveHeaderY; // placeholder for future relayout

  const headerLine = buildLine(null, '   ');

  return (
    <>
      {/* Filter row (only when typing or filter is active) */}
      {showFilterRow && (
        <Text
          x={innerX}
          y={filterRowY}
          width={innerW}
          height={1}
          block
          background="Black"
        >
          <Text x={1} color="BrightBlack">
            /
          </Text>
          <Text x={3} color={filterFocused ? 'Yellow' : 'White'}>
            {filter}
          </Text>
          {filterFocused && (
            <Text x={3 + filter.length} background="White" color="Black">
              {' '}
            </Text>
          )}
        </Text>
      )}

      {/* Header row — column titles. Spans only the list area when the
          details panel is open. */}
      <Text x={innerX} y={headerY} width={listWidth} height={1} block background="Black">
        <Text x={1} color="BrightBlack" bold>
          {headerLine}
        </Text>
      </Text>

      {/* Body rows. Each "logical" file row may span `rowHeight` terminal
          rows when thumbnails are enabled — we render the primary line
          with content on its top cell, plus blank-but-highlighted filler
          rows beneath so the cursor stripe paints solidly under the
          inline image. */}
      {Array.from({ length: visibleRowCount }).map((_, i) => {
        const row = visibleRows[i];
        const absoluteIdx = firstVisibleRow + i;
        const isCursor = row !== undefined && absoluteIdx === cursor;
        const isSelected = row !== undefined && browser.selected.has(row.entry.path);
        const checkChar = row === undefined ? '   ' : isSelected ? '[■]' : '[ ]';
        const rowText = row === undefined ? '' : buildLine(row, checkChar);
        const rowY = bodyY + i * rowHeight;
        const bg = isCursor ? 'BrightBlack' : 'Black';
        return (
          <Fragment key={`row${i}`}>
            {/* Primary line — text + checkbox sit to the right of the
                thumbnail strip (which is painted by the layout-effect
                below). The empty `thumbColW`-cell strip on the left of
                each row remains untouched by react-curse so the iTerm2
                inline image survives. */}
            <Text
              x={innerX + thumbColW}
              y={rowY}
              width={Math.max(1, listWidth - thumbColW)}
              height={1}
              block
              background={bg}
            >
              <Text
                x={1}
                color={isSelected ? 'Cyan' : 'White'}
                bold={isCursor || isSelected}
              >
                {rowText}
              </Text>
            </Text>
            {/* Filler rows under the primary line when rowHeight > 1.
                Same background as the primary so cursor highlighting
                covers the full file row vertically. Span only the text
                area; the thumbnail strip on the left stays untouched. */}
            {rowHeight > 1 &&
              Array.from({ length: rowHeight - 1 }).map((__, fillerIdx) => (
                <Text
                  key={`row${i}-fill${fillerIdx}`}
                  x={innerX + thumbColW}
                  y={rowY + 1 + fillerIdx}
                  width={Math.max(1, listWidth - thumbColW)}
                  height={1}
                  block
                  background={bg}
                >
                  <Text> </Text>
                </Text>
              ))}
          </Fragment>
        );
      })}

      {/* Details side-panel — rendered alongside the body when toggled.
          Driven by the cursor row, NOT by the multi-select set: details
          show whatever the user is looking at right now, regardless of
          what's queued for batch delete / download / etc. */}
      {detailsOpen &&
        renderDetailsPanel({
          row: filteredRows[cursor],
          x: detailsX,
          y: headerY,
          width: detailsWidth,
          height: bodyH + 1, // +1 to cover the header row
        })}

      {/* Action message row */}
      <Text x={innerX} y={actionMsgY} width={innerW} height={1} block background="Black">
        {browser.actionMessage && (
          <Text x={1} color="Yellow">
            {browser.actionMessage.slice(0, innerW - 2)}
          </Text>
        )}
        {browser.status === 'loading' && (
          <Text x={1} color="BrightBlack" dim>
            Loading…
          </Text>
        )}
        {browser.status === 'error' && browser.error && (
          <Text x={1} color="Red">
            {browser.error.slice(0, innerW - 2)}
          </Text>
        )}
      </Text>

      {/* Status row — horizontal scroll indicator + position */}
      <Text x={innerX} y={statusY} width={innerW} height={1} block background="Black">
        <Text x={1} color="BrightBlack" dim>
          {filteredRows.length > 0
            ? `Row ${cursor + 1}/${filteredRows.length}`
            : 'No files'}
          {maxHScroll > 0 ? `  ·  scroll ${hScroll}/${maxHScroll} (←/→)` : ''}
        </Text>
      </Text>

      {/* Confirm prompt overlay — sits on the hint row when active */}
      <Text x={innerX} y={hintY} width={innerW} height={1} block background="Black">
        {confirm !== null ? (
          <Text x={1} color="Yellow" bold>
            {confirm.message}
          </Text>
        ) : (
          <Text x={1} color="BrightBlack" dim>
            ↑/↓ nav · ←/→ scroll · space sel · Enter print · i info · d del · s save · / filter · r refresh · Esc close
          </Text>
        )}
      </Text>

      <PanelFrame
        x={modalX}
        y={modalY}
        width={modalW}
        height={modalH}
        title={title}
        rightLabel={rightLabel}
        accent="Yellow"
        titleColor="Yellow"
      />
    </>
  );
};

/**
 * Render the right-side details panel for the cursor row. Emits one
 * `<Text>` per row inside the carved-out rectangle. Hoisted out of the
 * component body so the JSX above stays readable; takes pre-resolved
 * geometry rather than threading the whole layout context in.
 *
 * When `row` is `undefined` (empty list), renders a single hint line so
 * the panel doesn't look broken.
 */
interface DetailsPanelArgs {
  readonly row: FileRow | undefined;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const renderDetailsPanel = ({
  row,
  x,
  y,
  width,
  height,
}: DetailsPanelArgs): React.JSX.Element => {
  const innerX = x + 1;
  const innerW = Math.max(1, width - 2);

  if (!row) {
    return (
      <>
        <Text x={innerX} y={y + 1} color="BrightBlack" dim>
          (no file)
        </Text>
        <PanelFrame
          x={x}
          y={y}
          width={width}
          height={height}
          title="Details"
          accent="BrightBlack"
          titleColor="BrightBlack"
        />
      </>
    );
  }

  const { entry, meta } = row;
  // Build the field list once, then render. Keeping it in one array
  // means we can adjust ordering without touching layout math.
  const fields: { readonly label: string; readonly value: string }[] = [];
  const add = (label: string, value: string | undefined): void => {
    fields.push({ label, value: value ?? '—' });
  };
  // File-system stats from `server.files.list` (always present).
  add('Size', fmtBytes(entry.size));
  add('Modified', fmtDateRelative(entry.modified));
  add('Path', entry.path);
  // Spacer between FS info and slicer info.
  fields.push({ label: '', value: '' });
  // Slicer-derived metadata (may be partial / absent for new files).
  add('Slicer', meta?.slicer);
  add('Version', meta?.slicer_version);
  add('Layers', meta?.layer_count !== undefined ? String(meta.layer_count) : undefined);
  add('Height', meta?.object_height !== undefined ? `${meta.object_height.toFixed(2)} mm` : undefined);
  add('Layer h.', meta?.layer_height !== undefined ? `${meta.layer_height.toFixed(2)} mm` : undefined);
  add(
    'L1 h.',
    meta?.first_layer_height !== undefined ? `${meta.first_layer_height.toFixed(2)} mm` : undefined,
  );
  add('Nozzle', meta?.nozzle_diameter !== undefined ? `${meta.nozzle_diameter.toFixed(2)} mm` : undefined);
  add('Est. time', fmtDurationShort(meta?.estimated_time));
  fields.push({ label: '', value: '' });
  add('Material', meta?.filament_type);
  add('Profile', meta?.filament_name);
  add('Filament', meta?.filament_total !== undefined ? `${Math.round(meta.filament_total)} mm` : undefined);
  add(
    'Weight',
    meta?.filament_weight_total !== undefined ? `${meta.filament_weight_total.toFixed(1)} g` : undefined,
  );
  fields.push({ label: '', value: '' });
  add('Extruder', meta?.first_layer_extr_temp !== undefined ? `${meta.first_layer_extr_temp.toFixed(0)} °C` : undefined);
  add('Bed', meta?.first_layer_bed_temp !== undefined ? `${meta.first_layer_bed_temp.toFixed(0)} °C` : undefined);
  add(
    'Chamber',
    meta?.chamber_temp !== undefined && meta.chamber_temp > 0
      ? `${meta.chamber_temp.toFixed(0)} °C`
      : undefined,
  );
  fields.push({ label: '', value: '' });
  add('Last print', fmtDateRelative(meta?.print_start_time ?? undefined));
  add('Job ID', meta?.job_id ?? undefined);

  // Truncate to the available row count so we don't overflow.
  const innerRows = Math.max(0, height - 3); // top border, name row, bottom border
  const labelW = 11;
  const valueW = Math.max(1, innerW - labelW - 3);

  return (
    <>
      {/* Filename gets a dedicated row at top, bolded. */}
      <Text x={innerX} y={y + 1} width={innerW} height={1} block background="Black">
        <Text x={1} color="Yellow" bold>
          {truncateForDetails(basename(entry.path), innerW - 2)}
        </Text>
      </Text>
      {/* Body rows: each field on one line. Blank `label` ⇒ visual spacer. */}
      {fields.slice(0, innerRows).map((field, i) => {
        const rowY = y + 2 + i;
        if (field.label === '') {
          return (
            <Text key={i} x={innerX} y={rowY} width={innerW} height={1} block background="Black">
              <Text> </Text>
            </Text>
          );
        }
        return (
          <Text key={i} x={innerX} y={rowY} width={innerW} height={1} block background="Black">
            <Text x={1} color="BrightBlack">
              {field.label.padEnd(labelW)}
            </Text>
            <Text x={1 + labelW + 1} color="White">
              {truncateForDetails(field.value, valueW)}
            </Text>
          </Text>
        );
      })}
      <PanelFrame
        x={x}
        y={y}
        width={width}
        height={height}
        title="Details"
        accent="BrightBlack"
        titleColor="Yellow"
      />
    </>
  );
};

/** Trim with an ellipsis when content overflows the available width. */
const truncateForDetails = (s: string, width: number): string => {
  if (width <= 0) return '';
  if (s.length <= width) return s;
  return `${s.slice(0, Math.max(0, width - 1))}…`;
};
