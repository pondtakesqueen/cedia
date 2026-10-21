import { oldLog } from '../log.ts';

// auth/tokens: the tokens step.
export function run(): void {
  oldLog('debug', 'token refreshed');
  oldLog('error', 'token expired');
}
