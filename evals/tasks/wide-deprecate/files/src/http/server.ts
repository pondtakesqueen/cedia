import { oldLog } from '../log.ts';

// http/server: the server step.
export function run(port = 8080): void {
  oldLog('info', `listening on ${port}`);
}
