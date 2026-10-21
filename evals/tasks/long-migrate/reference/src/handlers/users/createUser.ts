import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

export async function createUser(req: { id: string; name: string }): Promise<Row> {
  if (!req.name.trim()) throw new HttpError(400, 'name is required');
  const existing = await db.promises.get('users', req.id);
  if (existing) throw new HttpError(409, `user ${req.id} exists`);
  return db.promises.put('users', { id: req.id, name: req.name.trim(), active: true });
}
