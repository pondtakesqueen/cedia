import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

// A user's orders, newest id first, optionally only one status.
export async function listOrders(req: { user: string; status?: string }): Promise<Row[]> {
  const rows = await db.promises.query('orders', (o) => o.user === req.user && (!req.status || o.status === req.status));
  return rows.sort((a, b) => b.id.localeCompare(a.id));
}
