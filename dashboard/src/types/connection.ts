export type ConnectionStatus =
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'error'; message: string }
  | { kind: 'closed'; code?: number; reason?: string };
