import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

export function createUser(req: { id: string; name: string }, done: (err: Error | null, res?: Row) => void): void {
  if (!req.name.trim()) return done(new HttpError(400, 'name is required'));
  db.get('users', req.id, (err, existing) => {
    if (err) return done(err);
    if (existing) return done(new HttpError(409, `user ${req.id} exists`));
    db.put('users', { id: req.id, name: req.name.trim(), active: true }, done);
  });
}
