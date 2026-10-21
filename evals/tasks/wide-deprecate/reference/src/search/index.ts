import { log } from '../log.ts';

// search/index: the index step.
export function run(count = 42): void {
  log.info(`indexed ${count} docs`);
}
