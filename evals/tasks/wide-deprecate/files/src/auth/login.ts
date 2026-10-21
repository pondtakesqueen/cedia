import { oldLog } from '../log.ts';

// auth/login: the login step.
export function run(user = "ann"): void {
  oldLog('info', `login ${user}`);
  oldLog('warn', 'slow login');
}
