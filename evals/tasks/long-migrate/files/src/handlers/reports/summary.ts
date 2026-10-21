import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

// Counts per order status and total units ordered, over all orders of active users.
export function summary(_req: {}, done: (err: Error | null, res?: { byStatus: Record<string, number>; units: number }) => void): void {
  db.query('users', (u) => u.active !== false, (err, users) => {
    if (err) return done(err);
    const active = new Set((users ?? []).map((u) => u.id));
    db.query('orders', (o) => active.has(o.user as string), (err2, orders) => {
      if (err2) return done(err2);
      const byStatus: Record<string, number> = {};
      let units = 0;
      for (const o of orders ?? []) {
        byStatus[o.status as string] = (byStatus[o.status as string] ?? 0) + 1;
        units += o.quantity as number;
      }
      done(null, { byStatus, units });
    });
  });
}
