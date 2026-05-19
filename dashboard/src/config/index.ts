import type { ClientConfig } from '@jhyland87/moonraker-client';
import type { SensorConfig } from '../types/index';

export interface DashboardConfig {
  readonly client: ClientConfig;
  readonly sensors: readonly SensorConfig[];
  /** Maximum number of samples to retain per sensor. */
  readonly historyLength: number;
  /** Sampling cadence in milliseconds (driven client-side off pushed updates). */
  readonly sampleIntervalMs: number;
}

const envServer = process.env.MOONRAKER_HOST ?? '192.168.0.96';
const envPort = process.env.MOONRAKER_PORT ? Number(process.env.MOONRAKER_PORT) : 7125;

/**
 * Sensor definitions mirroring `moonraker-cli`'s `status.graph` table.
 * Colors are the literal RGB values from that script.
 */
const sensors: readonly SensorConfig[] = [
  {
    objectName: 'extruder',
    label: 'Extruder',
    color: '#ff5252',
    dimColor: '#802929',
    hasTarget: true,
    powerField: 'powers',
    toggleKey: 'e',
  },
  {
    objectName: 'heater_bed',
    label: 'Heater Bed',
    color: '#20b0ff',
    dimColor: '#105880',
    hasTarget: true,
    powerField: 'powers',
    toggleKey: 'b',
  },
  {
    objectName: 'temperature_fan chamber_fan',
    label: 'Chamber Fan',
    color: '#3cc25a',
    dimColor: '#1e612d',
    hasTarget: true,
    powerField: 'speeds',
    toggleKey: 'f',
  },
  {
    objectName: 'temperature_sensor chamber_temp',
    label: 'Chamber Temp',
    color: '#830ee3',
    dimColor: '#410771',
    hasTarget: false,
    powerField: 'none',
    toggleKey: 't',
  },
  {
    objectName: 'temperature_sensor mcu_temp',
    label: 'MCU Temp',
    color: '#d67600',
    dimColor: '#6b3b00',
    hasTarget: false,
    powerField: 'none',
    toggleKey: 'm',
  },
];

export const config: DashboardConfig = {
  client: {
    API: {
      connection: {
        server: envServer,
        port: envPort,
        path: '/websocket',
        timeout: 1000,
      },
    },
  },
  sensors,
  historyLength: 500,
  sampleIntervalMs: 1000,
};
