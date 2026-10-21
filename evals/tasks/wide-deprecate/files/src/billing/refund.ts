import { oldLog } from '../log.ts';

// billing/refund: the refund step.
export function run(amount = 900): void {
  oldLog('warn', `refund over limit: ${amount}`);
}
