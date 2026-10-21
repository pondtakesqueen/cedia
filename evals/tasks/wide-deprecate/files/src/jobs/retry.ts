import { oldLog } from '../log.ts';

// jobs/retry: the retry step.
export function run(n = 3): void {
  oldLog('warn', `retry ${n}`);
  oldLog('error', 'giving up');
}
