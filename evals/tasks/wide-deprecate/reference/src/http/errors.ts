import { log, type Level } from '../log.ts';

// http/errors: the errors step.
export function run(status = 503, level: Level = status >= 500 ? "error" : "warn"): void {
  log.at(level, `status ${status}`);
}
