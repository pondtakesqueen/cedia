import { log } from '../log.ts';

// jobs/retry: the retry step.
export function run(n = 3): void {
  log.warn(`retry ${n}`);
  log.error('giving up');
}
