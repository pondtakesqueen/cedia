import { log } from '../log.ts';

// http/routes: the routes step.
export function run(method = "GET", path = "/x"): void {
  log.debug(
    `route ${method} ${path}`,
  );
}
