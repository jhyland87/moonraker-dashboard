/**
 * Standalone diagnostic: connects to Moonraker, calls server.temperature_store
 * and printer.objects.subscribe, prints both responses, then exits.
 *
 * Usage:
 *   pnpm --filter dashboard exec tsx src/debug.ts
 *   MOONRAKER_HOST=192.168.0.96 pnpm --filter dashboard exec tsx src/debug.ts
 */
import { MoonrakerClient } from '@jhyland87/moonraker-client';

import { config } from './config/index';

const client = new MoonrakerClient(config.client);

const log = (label: string, value: unknown): void => {
  // eslint-disable-next-line no-console
  console.log(`\n=== ${label} ===`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(value, null, 2));
};

client.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[error]', err.message);
});

client.on('close', (code, reason) => {
  // eslint-disable-next-line no-console
  console.error(`[close] code=${code ?? '?'} reason=${reason ?? ''}`);
});

client.on('open', async () => {
  // eslint-disable-next-line no-console
  console.log('[open] connected');

  try {
    const info = await client.getServerInfo();
    log('server.info', info);
  } catch (err) {
    log('server.info ERROR', (err as Error).message);
  }

  try {
    const store = await client.getTemperatureStore();
    const summary = Object.fromEntries(
      Object.entries(store).map(([name, sensor]) => [
        name,
        {
          temperatureSamples: sensor.temperatures.length,
          targetSamples: sensor.targets?.length ?? 0,
          firstTemp: sensor.temperatures[0],
          lastTemp: sensor.temperatures[sensor.temperatures.length - 1],
          lastTarget: sensor.targets?.[sensor.targets.length - 1],
        },
      ]),
    );
    log('server.temperature_store (summary)', summary);
  } catch (err) {
    log('server.temperature_store ERROR', (err as Error).message);
  }

  try {
    const sub = await client.subscribe({
      extruder: ['temperature', 'target'],
      heater_bed: ['temperature', 'target'],
    });
    log('printer.objects.subscribe', sub);
  } catch (err) {
    log('printer.objects.subscribe ERROR', (err as Error).message);
  }

  client.close();
  setTimeout(() => process.exit(0), 200);
});
