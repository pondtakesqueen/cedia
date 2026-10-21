import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

// Deactivates the user and cancels their open orders, one at a time.
export async function deactivateUser(req: { id: string }): Promise<{ cancelled: number }> {
  const user = await db.promises.get('users', req.id);
  if (!user) throw new HttpError(404, `no user ${req.id}`);
  await db.promises.put('users', { ...user, active: false });
  const orders = await db.promises.query('orders', (o) => o.user === req.id && o.status === 'open');
  for (const o of orders) await db.promises.put('orders', { ...o, status: 'cancelled' });
  return { cancelled: orders.length };
}
