import { oldLog } from '../log.ts';

// cache/disk: the disk step.
export function run(path = "/var/c"): void {
  oldLog('error', `disk full: ${path}`);
}
