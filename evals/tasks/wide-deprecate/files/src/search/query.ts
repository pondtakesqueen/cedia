import { oldLog as legacyLog } from '../log.ts';

// search/query: the query step.
export function run(q = "mug"): void {
  legacyLog('debug', `query "${q}"`);
}
