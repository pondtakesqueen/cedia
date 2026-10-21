import { oldLog } from '../log.ts';

// http/routes: the routes step.
export function run(method = "GET", path = "/x"): void {
  oldLog(
    'debug',
    `route ${method} ${path}`,
  );
}
