import { oldLog } from '../log.ts';

// auth/logout: the logout step.
export function run(user = "ann"): void {
  oldLog('info', `logout ${user}`);
}
