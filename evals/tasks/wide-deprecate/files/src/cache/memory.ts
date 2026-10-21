import { oldLog as legacyLog } from '../log.ts';

// cache/memory: the memory step.
export function run(): void {
  legacyLog('debug', 'cache miss');
  legacyLog('info', 'cache warmed');
}
