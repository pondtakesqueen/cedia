import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

// Moves units of one sku to another sku's count (a repack). Both rows are written, source first.
export async function transferStock(req: { from: string; to: string; units: number }): Promise<{ from: Row; to: Row }> {
  if (req.from === req.to) throw new HttpError(400, 'from and to are the same');
  const a = await db.promises.get('stock', req.from);
  const have = (a?.units as number | undefined) ?? 0;
  if (have < req.units) throw new HttpError(409, `only ${have} ${req.from} left`);
  const b = await db.promises.get('stock', req.to);
  const from = await db.promises.put('stock', { id: req.from, units: have - req.units });
  const to = await db.promises.put('stock', { id: req.to, units: ((b?.units as number | undefined) ?? 0) + req.units });
  return { from, to };
}
