import { log } from '../log.ts';

// search/query: the query step.
export function run(q = "mug"): void {
  log.debug(`query "${q}"`);
}
