import { oldLog } from '../log.ts';

// search/index: the index step.
export function run(count = 42): void {
  oldLog('info', `indexed ${count} docs`);
}
