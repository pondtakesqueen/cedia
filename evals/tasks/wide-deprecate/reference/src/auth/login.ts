import { log } from '../log.ts';

// auth/login: the login step.
export function run(user = "ann"): void {
  log.info(`login ${user}`);
  log.warn('slow login');
}
