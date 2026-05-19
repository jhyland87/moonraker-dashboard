/**
 * One timestamped reading from a sensor's history.
 */
export interface TemperatureSample {
  readonly timestamp: number;
  readonly temperature: number;
  readonly target: number;
}

/**
 * Display configuration for a single Moonraker temperature object — heater,
 * temperature_fan, or temperature_sensor. `objectName` is the literal key
 * Moonraker uses (e.g. `"temperature_fan chamber_fan"`, with the space).
 */
/** Source attribute Moonraker uses for the "power" column of a sensor row. */
export type PowerField = 'powers' | 'speeds' | 'none';

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
  /** Single-character key (case-insensitive) underlined in the table label. */
  readonly toggleKey: string;
}

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

export type SensorsState = Readonly<Record<string, SensorState>>;
