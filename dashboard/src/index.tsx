import ReactCurse from 'react-curse';

import { App } from './App';
import { config } from './config/index';
import { createMoonrakerClient } from './services/createMoonrakerClient';
import { installTerminalRestore } from './terminal';

// Must run before ReactCurse.render so the handlers cover early failures too.
installTerminalRestore();

const client = createMoonrakerClient(config.client);

client.on('error', (err) => {
  // Surfacing errors to the user is handled by the StatusBar; this listener
  // exists so unhandled-error events don't crash the process.
  void err;
});

ReactCurse.render(<App client={client} config={config} />);
