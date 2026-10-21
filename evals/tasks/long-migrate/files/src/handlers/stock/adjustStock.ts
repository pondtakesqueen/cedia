import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

// Adds delta units (negative to remove); stock never goes below zero.
export function adjustStock(req: { sku: string; delta: number }, done: (err: Error | null, res?: Row) => void): void {
  if (!Number.isInteger(req.delta) || req.delta === 0) return done(new HttpError(400, 'delta must be a non-zero integer'));
  db.get('stock', req.sku, (err, stock) => {
    if (err) return done(err);
    const units = ((stock?.units as number | undefined) ?? 0) + req.delta;
    if (units < 0) return done(new HttpError(409, `stock of ${req.sku} would be ${units}`));
    db.put('stock', { id: req.sku, units }, done);
  });
}
