import { log } from '../log.ts';

// mail/send: the send step.
export function run(to = "a@b.c"): void {
  log.info(`mail to ${to}`);
  log.warn('mail queue slow');
}
