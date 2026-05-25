import type { FileEntry, GcodeFileMetadata, GcodeMetadataMap } from '@jhyland87/moonraker-client';

/**
 * One row in the file browser table — a {@link FileEntry} from
 * `server.files.list` merged with the corresponding cached gcode
 * metadata (when available). Rows for non-gcode files (or files with
 * no cached metadata yet) simply have `meta = null`.
 *
 * @source
 */
export interface FileRow {
  readonly entry: FileEntry;
  readonly meta: GcodeFileMetadata | null;
}

/**
 * Spec for one column the file browser can render. The dashboard config
 * picks which columns are visible and in what order via the column
 * `id` strings; everything else (width, header, value formatter) lives
 * here so the table renderer can stay generic.
 *
 * @source
 */
export interface ColumnSpec {
  /** Stable identifier — referenced from `FileBrowserConfig.columns`. */
  readonly id: string;
  /** Header label shown in the table's top row. */
  readonly title: string;
  /** Fixed display width in cells. The renderer pads / truncates accordingly. */
  readonly width: number;
  /** Right-align (`'right'`) numeric columns; default is left-align. */
  readonly align?: 'left' | 'right';
  /** Stringify the cell value for a single row. */
  readonly render: (row: FileRow) => string;
}

/** Default visible column ids — keep tight enough to fit a typical terminal. */
export const DEFAULT_VISIBLE_COLUMNS: readonly string[] = [
  'name',
  'size',
  'modified',
  'layers',
  'duration',
  'filament_g',
];

/**
 * Merge a `server.files.list` result with the cached gcode metadata
 * dictionary into one row-per-file array. Files not present in the
 * metadata cache surface as rows with `meta = null` — they still
 * render (just without slicer-derived columns populated).
 *
 * @param entries - The file list from `client.listFiles()`.
 * @param metaMap - The gcode metadata cache from
 *   `client.getDatabaseItem<GcodeMetadataMap>('gcode_metadata')`.
 * @returns One row per file entry, preserving the input order.
 *
 * @source
 */
export const mergeFileMetadata = (
  entries: readonly FileEntry[],
  metaMap: GcodeMetadataMap,
): readonly FileRow[] =>
  entries.map((entry) => ({ entry, meta: metaMap[entry.path] ?? null }));

/** Human-readable byte size — KB / MB / GB to 1 decimal. */
const fmtBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

/** Human-readable elapsed time (e.g. `"2h 14m"`, `"45s"`, `"3d"`). */
const fmtDurationShort = (seconds: number | undefined): string => {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const totalMinutes = Math.round(seconds / 60);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

/**
 * Relative date — `"just now"`, `"3m ago"`, `"2h ago"`, `"3d ago"`,
 * `"2024-12-15"` for older entries. Optimized for at-a-glance scanning
 * of a freshly-printed list rather than absolute precision.
 */
const fmtDateRelative = (unixSeconds: number | undefined): string => {
  if (unixSeconds === undefined || !Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return '—';
  }
  const nowSeconds = Date.now() / 1000;
  const diff = nowSeconds - unixSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)}d ago`;
  const date = new Date(unixSeconds * 1000);
  // ISO-ish date so it sorts correctly when eyeballing the list.
  return date.toISOString().slice(0, 10);
};

/** Strip a leading directory prefix; safe on names with no slash. */
const basename = (path: string): string => {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? path : path.slice(idx + 1);
};

/**
 * The canonical column catalog. Keys are stable column ids referenced
 * from `FileBrowserConfig.visibleColumns`; adding a new column means
 * dropping a new entry here and (optionally) listing its id in the
 * config's default visible set.
 *
 * @source
 */
export const COLUMN_CATALOG: Readonly<Record<string, ColumnSpec>> = {
  name: {
    id: 'name',
    title: 'Name',
    width: 36,
    render: (row) => basename(row.entry.path),
  },
  path: {
    id: 'path',
    title: 'Path',
    width: 40,
    render: (row) => row.entry.path,
  },
  size: {
    id: 'size',
    title: 'Size',
    width: 10,
    align: 'right',
    render: (row) => fmtBytes(row.entry.size),
  },
  modified: {
    id: 'modified',
    title: 'Modified',
    width: 12,
    render: (row) => fmtDateRelative(row.entry.modified),
  },
  printed: {
    id: 'printed',
    title: 'Last printed',
    width: 12,
    render: (row) => fmtDateRelative(row.meta?.print_start_time ?? undefined),
  },
  layers: {
    id: 'layers',
    title: 'Layers',
    width: 7,
    align: 'right',
    render: (row) => (row.meta?.layer_count !== undefined ? String(row.meta.layer_count) : '—'),
  },
  duration: {
    id: 'duration',
    title: 'Est. time',
    width: 10,
    align: 'right',
    render: (row) => fmtDurationShort(row.meta?.estimated_time),
  },
  filament_mm: {
    id: 'filament_mm',
    title: 'Filament',
    width: 10,
    align: 'right',
    render: (row) =>
      row.meta?.filament_total !== undefined
        ? `${Math.round(row.meta.filament_total)} mm`
        : '—',
  },
  filament_g: {
    id: 'filament_g',
    title: 'Filament',
    width: 10,
    align: 'right',
    render: (row) =>
      row.meta?.filament_weight_total !== undefined
        ? `${row.meta.filament_weight_total.toFixed(1)} g`
        : '—',
  },
  slicer: {
    id: 'slicer',
    title: 'Slicer',
    width: 14,
    render: (row) => row.meta?.slicer ?? '—',
  },
  material: {
    id: 'material',
    title: 'Material',
    width: 8,
    render: (row) => row.meta?.filament_type ?? '—',
  },
};

/**
 * Filter rows by case-insensitive substring of the basename or full path.
 * Empty query matches everything.
 *
 * @source
 */
export const filterRows = (
  rows: readonly FileRow[],
  query: string,
): readonly FileRow[] => {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return rows;
  return rows.filter(
    (row) =>
      row.entry.path.toLowerCase().includes(needle) ||
      basename(row.entry.path).toLowerCase().includes(needle),
  );
};

/**
 * Drop entries whose path doesn't end with one of the allowed extensions.
 * Matching is case-insensitive. Pass an empty list to disable the filter.
 *
 * @source
 */
export const filterByExtension = (
  entries: readonly FileEntry[],
  extensions: readonly string[],
): readonly FileEntry[] => {
  if (extensions.length === 0) return entries;
  const lowered = extensions.map((ext) =>
    ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`,
  );
  return entries.filter((entry) => {
    const lower = entry.path.toLowerCase();
    return lowered.some((ext) => lower.endsWith(ext));
  });
};

export { basename, fmtBytes, fmtDateRelative, fmtDurationShort };
