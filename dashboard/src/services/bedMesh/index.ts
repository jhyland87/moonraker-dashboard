/**
 * Bed-mesh services barrel. Groups the pure utilities a consumer might
 * pull at once — colormap, resolution doubling, aggregate stats.
 * @source
 */
export {
  POSITIVE_COLORS,
  NEGATIVE_COLORS,
  rgbHex,
  meshValToHex,
} from './colors';
export { interpolateMesh } from './interpolate';
export { computeBedMeshStats } from './stats';
export type { BedMeshStats } from './stats';
