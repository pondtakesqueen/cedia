export type VimMode = 'insert' | 'normal';

export type VimState =
  | { mode: 'insert'; insertedText: string }
  | { mode: 'normal'; pendingOperator?: 'd' | 'c' | 'y'; count?: number };
