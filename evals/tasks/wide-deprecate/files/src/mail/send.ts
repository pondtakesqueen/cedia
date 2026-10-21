import { oldLog } from '../compat.ts';

// mail/send: the send step.
export function run(to = "a@b.c"): void {
  oldLog('info', `mail to ${to}`);
  oldLog('warn', 'mail queue slow');
}
