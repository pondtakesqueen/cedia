import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

// Adds delta units (negative to remove); stock never goes below zero.
export async function adjustStock(req: { sku: string; delta: number }): Promise<Row> {
  if (!Number.isInteger(req.delta) || req.delta === 0) throw new HttpError(400, 'delta must be a non-zero integer');
  const stock = await db.promises.get('stock', req.sku);
  const units = ((stock?.units as number | undefined) ?? 0) + req.delta;
  if (units < 0) throw new HttpError(409, `stock of ${req.sku} would be ${units}`);
  return db.promises.put('stock', { id: req.sku, units });
}
