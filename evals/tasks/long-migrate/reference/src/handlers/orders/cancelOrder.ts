import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

// Cancels an open order and puts its units back in stock.
export async function cancelOrder(req: { id: string }): Promise<Row> {
  const order = await db.promises.get('orders', req.id);
  if (!order) throw new HttpError(404, `no order ${req.id}`);
  if (order.status !== 'open') throw new HttpError(409, `order ${req.id} is ${order.status}`);
  const stock = await db.promises.get('stock', order.sku as string);
  const units = ((stock?.units as number | undefined) ?? 0) + (order.quantity as number);
  await db.promises.put('stock', { id: order.sku as string, units });
  return db.promises.put('orders', { ...order, status: 'cancelled' });
}
