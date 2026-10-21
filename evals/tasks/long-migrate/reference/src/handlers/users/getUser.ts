import { db, type Row } from '../../db.ts';
import { HttpError } from '../../errors.ts';

export async function getUser(req: { id: string }): Promise<Row> {
  const user = await db.promises.get('users', req.id);
  if (!user || user.active === false) throw new HttpError(404, `no user ${req.id}`);
  return user;
}
