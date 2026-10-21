import { log } from '../log.ts';

// billing/invoice: the invoice step.
export function run(id = "i7", amount = 1200): void {
  log.info(
    `invoice ${id} for ${amount}`,
  );
}
