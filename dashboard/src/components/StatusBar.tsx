import { Text } from 'react-curse';

import type { ConnectionStatus } from '../types/index';

interface StatusBarProps {
  readonly status: ConnectionStatus;
  readonly host: string;
  readonly y: number;
  readonly width: number;
}

const describe = (status: ConnectionStatus): { label: string; color: string } => {
  switch (status.kind) {
    case 'connecting':
      return { label: 'connecting…', color: 'Yellow' };
    case 'open':
      return { label: 'connected', color: 'Green' };
    case 'error':
      return { label: `error: ${status.message}`, color: 'Red' };
    case 'closed':
      return {
        label: `closed${status.code !== undefined ? ` (${status.code})` : ''}`,
        color: 'BrightBlack',
      };
  }
};

export const StatusBar = ({ status, host, y, width }: StatusBarProps) => {
  const { label, color } = describe(status);
  return (
    <Text x={0} y={y} width={width} height={1} background="BrightBlack" block>
      <Text x={1} color="White" bold>
        Moonraker Dashboard
      </Text>
      <Text x={22} color="White" dim>
        {host}
      </Text>
      <Text x="100%-30" color={color}>
        ● {label}
      </Text>
      <Text x="100%-12" color="White" dim>
        q to quit
      </Text>
    </Text>
  );
};
