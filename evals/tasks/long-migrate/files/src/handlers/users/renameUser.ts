import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

export function renameUser(req: { id: string; name: string }, done: (err: Error | null, res?: Row) => void): void {
  db.get('users', req.id, (err, user) => {
    if (err) return done(err);
    if (!user) return done(new HttpError(404, `no user ${req.id}`));
    const name = req.name.trim();
    if (!name) return done(new HttpError(400, 'name is required'));
    if (name === user.name) return done(null, user);
    db.put('users', { ...user, name }, done);
  });
}
