import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

export async function createOrder(req: { id: string; user: string; sku: string; quantity: number }): Promise<Row> {
  if (!Number.isInteger(req.quantity) || req.quantity < 1) throw new HttpError(400, 'quantity must be a positive integer');
  const user = await db.promises.get('users', req.user);
  if (!user || user.active === false) throw new HttpError(404, `no user ${req.user}`);
  const stock = await db.promises.get('stock', req.sku);
  const have = (stock?.units as number | undefined) ?? 0;
  if (have < req.quantity) throw new HttpError(409, `only ${have} ${req.sku} left`);
  await db.promises.put('stock', { id: req.sku, units: have - req.quantity });
  return db.promises.put('orders', { id: req.id, user: req.user, sku: req.sku, quantity: req.quantity, status: 'open' });
}
