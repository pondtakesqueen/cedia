import { money } from '../format/currency.ts';
import type { Totals } from './total.ts';

export function receipt(t: Totals): string {
  const rows = t.lines.map((l) => `${l.quantity} x ${l.sku}  ${money(l.total)}${l.discount ? ` (bulk -${money(l.discount)})` : ''}`);
  if (t.coupon) rows.push(`coupon  -${money(t.coupon)}`);
  rows.push(`shipping  ${t.shipping ? money(t.shipping) : 'free'}`, `tax  ${money(t.tax)}`, `total  ${money(t.total)}`);
  return rows.join('\n');
}
