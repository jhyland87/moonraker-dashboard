import { MoonrakerClient, type ClientConfig } from '@jhyland87/moonraker-client';

export const createMoonrakerClient = (clientConfig: ClientConfig): MoonrakerClient =>
  new MoonrakerClient(clientConfig);
