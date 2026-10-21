import { log } from '../log.ts';

// auth/tokens: the tokens step.
export function run(): void {
  log.debug('token refreshed');
  log.error('token expired');
}
