import ReactCurse from 'react-curse';

import { DashboardRoot } from './components/DashboardRoot';
import { loadConfigSync } from './config/index';
import { installTerminalRestore } from './terminal';

// Must run before ReactCurse.render so the handlers cover early failures too.
installTerminalRestore();

// Synchronously read the YAML config (or write + load the default on
// first launch). DashboardRoot holds it in React state so the in-TUI
// editor can mutate it and persist back to disk without restarting.
const { config: initialConfig } = loadConfigSync();

// `DashboardRoot` owns the MoonrakerClient lifecycle — it constructs the
// client, retries on early failures (e.g. a sleeping printer), and only
// mounts the dashboard once the websocket is actually open.
ReactCurse.render(<DashboardRoot initialConfig={initialConfig} />);
