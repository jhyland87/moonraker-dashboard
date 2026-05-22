/**
 * One timestamped reading from a sensor's history.
 * @source
 */
export interface TemperatureSample {
  readonly timestamp: number;
  readonly temperature: number;
  readonly target: number;
}

/**
 * Source attribute Moonraker uses for the "power" column of a sensor row.
 * @source
 */
export type PowerField = 'powers' | 'speeds' | 'none';

/**
 * A single lowercase ASCII letter, the only kind of value accepted as a
 * sensor toggle hotkey. Narrowing this with a template-literal union
 * catches typos like `'em'` or `'1'` at compile time and removes the need
 * for callers to validate the format at runtime.
 * @source
 */
export type Hotkey =
  | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j'
  | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't'
  | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';

/**
 * Display configuration for a single Moonraker temperature object — heater,
 * temperature_fan, or temperature_sensor. `objectName` is the literal key
 * Moonraker uses (e.g. `"temperature_fan chamber_fan"`, with the space).
 * @source
 */
export interface SensorConfig {
  readonly objectName: string;
  readonly label: string;
  /** Bright color for the current-temperature line. */
  readonly color: string;
  /** Dim color for the target line. Ignored when `hasTarget` is false. */
  readonly dimColor: string;
  /** Whether this object exposes a `target` attribute worth plotting. */
  readonly hasTarget: boolean;
  /** Drives the "Power" column. Heaters → 'powers', fans → 'speeds', plain sensors → 'none'. */
  readonly powerField: PowerField;
  /** Single lowercase letter underlined in the table label and used as the show/hide hotkey. */
  readonly toggleKey: Hotkey;
}

/**
 * Live state per sensor, accumulated by `useMoonrakerSensors` from
 * `notify:status_update` deltas.
 * @source
 */
export interface SensorState {
  readonly config: SensorConfig;
  readonly current: number;
  readonly target: number;
  /** Latest power/speed value (0..1) when applicable, else undefined. */
  readonly power?: number;
  /** °C/s rate of change between the two most recent samples; undefined if <2 samples. */
  readonly changeRate?: number;
  readonly samples: readonly TemperatureSample[];
}

/**
 * Map of Moonraker object name → live sensor state.
 * @source
 */
export type SensorsState = Readonly<Record<string, SensorState>>;
