import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

export function getUser(req: { id: string }, done: (err: Error | null, res?: Row) => void): void {
  db.get('users', req.id, (err, user) => {
    if (err) return done(err);
    if (!user || user.active === false) return done(new HttpError(404, `no user ${req.id}`));
    done(null, user);
  });
}
