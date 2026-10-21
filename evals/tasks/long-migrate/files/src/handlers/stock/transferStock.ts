import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

// Moves units of one sku to another sku's count (a repack). Both rows are written, source first.
export function transferStock(req: { from: string; to: string; units: number }, done: (err: Error | null, res?: { from: Row; to: Row }) => void): void {
  if (req.from === req.to) return done(new HttpError(400, 'from and to are the same'));
  db.get('stock', req.from, (err, a) => {
    if (err) return done(err);
    const have = (a?.units as number | undefined) ?? 0;
    if (have < req.units) return done(new HttpError(409, `only ${have} ${req.from} left`));
    db.get('stock', req.to, (err2, b) => {
      if (err2) return done(err2);
      db.put('stock', { id: req.from, units: have - req.units }, (err3, from) => {
        if (err3) return done(err3);
        db.put('stock', { id: req.to, units: ((b?.units as number | undefined) ?? 0) + req.units }, (err4, to) => {
          if (err4) return done(err4);
          done(null, { from: from!, to: to! });
        });
      });
    });
  });
}
