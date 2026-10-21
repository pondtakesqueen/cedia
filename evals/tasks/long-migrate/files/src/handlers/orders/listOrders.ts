import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

// A user's orders, newest id first, optionally only one status.
export function listOrders(req: { user: string; status?: string }, done: (err: Error | null, res?: Row[]) => void): void {
  db.query('orders', (o) => o.user === req.user && (!req.status || o.status === req.status), (err, rows) => {
    if (err) return done(err);
    done(null, (rows ?? []).sort((a, b) => b.id.localeCompare(a.id)));
  });
}
