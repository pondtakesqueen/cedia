import { log } from '../log.ts';

// billing/refund: the refund step.
export function run(amount = 900): void {
  log.warn(`refund over limit: ${amount}`);
}
