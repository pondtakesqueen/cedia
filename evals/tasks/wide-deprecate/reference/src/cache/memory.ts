import { log } from '../log.ts';

// cache/memory: the memory step.
export function run(): void {
  log.debug('cache miss');
  log.info('cache warmed');
}
