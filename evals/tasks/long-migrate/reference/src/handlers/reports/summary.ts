import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

// Counts per order status and total units ordered, over all orders of active users.
export async function summary(_req: {}): Promise<{ byStatus: Record<string, number>; units: number }> {
  const users = await db.promises.query('users', (u) => u.active !== false);
  const active = new Set(users.map((u) => u.id));
  const orders = await db.promises.query('orders', (o) => active.has(o.user as string));
  const byStatus: Record<string, number> = {};
  let units = 0;
  for (const o of orders) {
    byStatus[o.status as string] = (byStatus[o.status as string] ?? 0) + 1;
    units += o.quantity as number;
  }
  return { byStatus, units };
}
