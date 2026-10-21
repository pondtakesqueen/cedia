import { log } from '../log.ts';

// auth/logout: the logout step.
export function run(user = "ann"): void {
  log.info(`logout ${user}`);
}
