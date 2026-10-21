import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

// Deactivates the user and cancels their open orders, one at a time.
export function deactivateUser(req: { id: string }, done: (err: Error | null, res?: { cancelled: number }) => void): void {
  db.get('users', req.id, (err, user) => {
    if (err) return done(err);
    if (!user) return done(new HttpError(404, `no user ${req.id}`));
    db.put('users', { ...user, active: false }, (err2) => {
      if (err2) return done(err2);
      db.query('orders', (o) => o.user === req.id && o.status === 'open', (err3, orders) => {
        if (err3) return done(err3);
        const list = orders ?? [];
        let i = 0;
        const next = (): void => {
          if (i === list.length) return done(null, { cancelled: list.length });
          const o = list[i++]!;
          db.put('orders', { ...o, status: 'cancelled' }, (err4) => (err4 ? done(err4) : next()));
        };
        next();
      });
    });
  });
}
