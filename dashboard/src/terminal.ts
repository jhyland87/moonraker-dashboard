/**
 * Terminal restoration helpers.
 *
 * Two problems are addressed here:
 *
 * 1. **RIS strip.** react-curse writes `\x1b[?1049h\x1bc...` on startup.
 *    The `\x1bc` is RIS ("Reset to Initial State") — a hard terminal reset.
 *    On many emulators (iTerm2, Terminal.app, gnome-terminal) sending RIS
 *    immediately after entering the alt-screen buffer destroys the saved
 *    main-screen content. The result: when we later exit the alt buffer,
 *    there's nothing to restore to, so the chart appears to "stay" on screen.
 *    We patch `process.stdout.write` to drop `\x1bc` sequences before they
 *    leave the process. `[?1049h` already starts us in a cleared alt buffer,
 *    so RIS is redundant anyway.
 *
 * 2. **Sync restore.** `process.stdout.write` goes through a Writable stream
 *    that can briefly buffer even on TTYs, and Node's exit path doesn't drain
 *    it. We use `fs.writeSync(fd, …)` for the restore sequence — a direct
 *    blocking syscall — so the bytes are guaranteed to reach the terminal
 *    before the process tears down.
 */
import { writeSync } from 'node:fs';

const RIS_BYTE = 0x1b;
const RIS_C = 0x63; // 'c'

// Exit alt-screen buffer (rmcup) + show cursor + reset attributes.
const RESTORE_SEQ = Buffer.from('\x1b[0m\x1b[?1049l\x1b[?25h');

let installed = false;

const restoreTerminal = (): void => {
  try {
    writeSync(process.stdout.fd, RESTORE_SEQ);
  } catch {
    // stdout fd may already be closed during shutdown — ignore.
  }
};

/** Callback shape used by both write overloads. */
type WriteCallback = (err?: Error | null) => void;

/**
 * Strip every `\x1bc` (RIS) sequence from a chunk before forwarding to
 * the original write. Works on both strings and Buffers without forcing
 * an unnecessary encoding round-trip when there's no RIS present.
 *
 * The wrapper mirrors `process.stdout.write`'s two real overloads:
 *   write(chunk, callback?)
 *   write(chunk, encoding, callback?)
 * Both are forwarded to the original, with the chunk filtered. No
 * `any` is needed because we destructure the two overload shapes by
 * runtime type check on the second argument.
 * @source
 */
const stripRisFromStdout = (): void => {
  const original = process.stdout.write.bind(process.stdout);

  const stripString = (s: string): string => s.replace(/\x1bc/g, '');
  const stripBuffer = (b: Buffer): Buffer => {
    // Fast path: scan for ESC, only allocate if we find one followed by 'c'.
    for (let i = 0; i < b.length - 1; i++) {
      if (b[i] === RIS_BYTE && b[i + 1] === RIS_C) {
        return Buffer.from(stripString(b.toString('utf8')), 'utf8');
      }
    }
    return b;
  };

  const filter = (chunk: string | Uint8Array): string | Uint8Array => {
    if (typeof chunk === 'string') return stripString(chunk);
    if (Buffer.isBuffer(chunk)) return stripBuffer(chunk);
    return chunk;
  };

  function wrapped(chunk: string | Uint8Array, cb?: WriteCallback): boolean;
  function wrapped(
    chunk: string | Uint8Array,
    encoding: BufferEncoding,
    cb?: WriteCallback,
  ): boolean;
  function wrapped(
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | WriteCallback,
    cb?: WriteCallback,
  ): boolean {
    const filtered = filter(chunk);
    if (typeof encodingOrCb === 'function') {
      return original(filtered, encodingOrCb);
    }
    if (typeof encodingOrCb === 'string') {
      return original(filtered, encodingOrCb, cb);
    }
    return original(filtered);
  }

  process.stdout.write = wrapped as typeof process.stdout.write;
};

/**
 * Idempotently install:
 *   - stdout RIS filter (so react-curse can't destroy the saved main buffer)
 *   - exit / SIGINT / SIGTERM / SIGHUP / uncaughtException handlers that
 *     synchronously restore the terminal
 *
 * Call this once, before `ReactCurse.render(...)`.
 */
export const installTerminalRestore = (): void => {
  if (installed) return;
  installed = true;

  stripRisFromStdout();

  process.on('exit', restoreTerminal);

  process.on('SIGINT', () => {
    restoreTerminal();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    restoreTerminal();
    process.exit(143);
  });
  process.on('SIGHUP', () => {
    restoreTerminal();
    process.exit(129);
  });

  process.on('uncaughtException', (err) => {
    restoreTerminal();
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
};

/**
 * Explicitly restore the terminal. Call from your in-app exit path right
 * before `process.exit()` — uses `fs.writeSync`, so the sequence is guaranteed
 * to be on the wire before the next instruction.
 */
export const restoreTerminalNow = restoreTerminal;
