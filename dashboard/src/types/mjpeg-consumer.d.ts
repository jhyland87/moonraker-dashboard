/**
 * Minimal type declaration for `mjpeg-consumer` — a CommonJS package with
 * no published types.
 *
 * The package exports a single constructor that extends Node's
 * `stream.Transform`. Feed it raw HTTP MJPEG bytes (chunks from a
 * `multipart/x-mixed-replace` response body); it emits whole JPEG
 * buffers as `'data'` events / async-iteration values. Detection is
 * based on JPEG SOI (`0xFFD8`) / EOI (`0xFFD9`) markers, so it copes
 * with arbitrary multipart-boundary formats.
 *
 * @see https://github.com/mmaelzer/mjpeg-consumer
 */
declare module 'mjpeg-consumer' {
  import { Transform, type TransformOptions } from 'node:stream';

  class MjpegConsumer extends Transform {
    constructor(options?: TransformOptions);
  }

  // Mirrors the package's CJS `module.exports = MjpegConsumer` so
  // `import MjpegConsumer from 'mjpeg-consumer'` resolves to the class.
  export default MjpegConsumer;
}
