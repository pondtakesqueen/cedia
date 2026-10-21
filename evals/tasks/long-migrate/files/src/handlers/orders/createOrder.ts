import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

export function createOrder(req: { id: string; user: string; sku: string; quantity: number }, done: (err: Error | null, res?: Row) => void): void {
  if (!Number.isInteger(req.quantity) || req.quantity < 1) return done(new HttpError(400, 'quantity must be a positive integer'));
  db.get('users', req.user, (err, user) => {
    if (err) return done(err);
    if (!user || user.active === false) return done(new HttpError(404, `no user ${req.user}`));
    db.get('stock', req.sku, (err2, stock) => {
      if (err2) return done(err2);
      const have = (stock?.units as number | undefined) ?? 0;
      if (have < req.quantity) return done(new HttpError(409, `only ${have} ${req.sku} left`));
      db.put('stock', { id: req.sku, units: have - req.quantity }, (err3) => {
        if (err3) return done(err3);
        db.put('orders', { id: req.id, user: req.user, sku: req.sku, quantity: req.quantity, status: 'open' }, done);
      });
    });
  });
}
