import { log } from '../log.ts';

// cache/disk: the disk step.
export function run(path = "/var/c"): void {
  log.error(`disk full: ${path}`);
}
