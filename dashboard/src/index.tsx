import ReactCurse from 'react-curse';

import { DashboardRoot } from './components/DashboardRoot';
import { config } from './config/index';
import { installTerminalRestore } from './terminal';

// Must run before ReactCurse.render so the handlers cover early failures too.
installTerminalRestore();

// `DashboardRoot` owns the MoonrakerClient lifecycle — it constructs the
// client, retries on early failures (e.g. a sleeping printer), and only
// mounts the dashboard once the websocket is actually open.
ReactCurse.render(<DashboardRoot config={config} />);
