import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

export async function renameUser(req: { id: string; name: string }): Promise<Row> {
  const user = await db.promises.get('users', req.id);
  if (!user) throw new HttpError(404, `no user ${req.id}`);
  const name = req.name.trim();
  if (!name) throw new HttpError(400, 'name is required');
  if (name === user.name) return user;
  return db.promises.put('users', { ...user, name });
}
