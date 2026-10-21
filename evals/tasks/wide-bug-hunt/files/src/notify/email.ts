import { receipt } from '../order/receipt.ts';
import type { Totals } from '../order/total.ts';

export function orderEmail(to: string, t: Totals): { to: string; subject: string; body: string } {
  return { to, subject: 'Your order', body: `Thanks for your order.\n\n${receipt(t)}` };
}
