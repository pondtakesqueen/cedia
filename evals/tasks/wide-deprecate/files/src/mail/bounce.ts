import { oldLog } from '../log.ts';

// mail/bounce: the bounce step.
export function run(): void {
  oldLog('error', 'hard bounce');
}
