import { log } from '../log.ts';

// http/server: the server step.
export function run(port = 8080): void {
  log.info(`listening on ${port}`);
}
