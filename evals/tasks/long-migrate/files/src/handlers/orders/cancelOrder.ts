import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

// Cancels an open order and puts its units back in stock.
export function cancelOrder(req: { id: string }, done: (err: Error | null, res?: Row) => void): void {
  db.get('orders', req.id, (err, order) => {
    if (err) return done(err);
    if (!order) return done(new HttpError(404, `no order ${req.id}`));
    if (order.status !== 'open') return done(new HttpError(409, `order ${req.id} is ${order.status}`));
    db.get('stock', order.sku as string, (err2, stock) => {
      if (err2) return done(err2);
      const units = ((stock?.units as number | undefined) ?? 0) + (order.quantity as number);
      db.put('stock', { id: order.sku as string, units }, (err3) => {
        if (err3) return done(err3);
        db.put('orders', { ...order, status: 'cancelled' }, done);
      });
    });
  });
}
