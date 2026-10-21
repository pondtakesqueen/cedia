import { beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, reset } from '../src/db.ts';
import { HttpError } from '../src/errors.ts';
import { createUser } from '../src/handlers/users/createUser.ts';
import { getUser } from '../src/handlers/users/getUser.ts';
import { renameUser } from '../src/handlers/users/renameUser.ts';
import { deactivateUser } from '../src/handlers/users/deactivateUser.ts';
import { createOrder } from '../src/handlers/orders/createOrder.ts';
import { listOrders } from '../src/handlers/orders/listOrders.ts';
import { cancelOrder } from '../src/handlers/orders/cancelOrder.ts';
import { adjustStock } from '../src/handlers/stock/adjustStock.ts';
import { transferStock } from '../src/handlers/stock/transferStock.ts';
import { summary } from '../src/handlers/reports/summary.ts';

// The async API: each handler takes only the request, resolves with the result, rejects with HttpError.
const fails = async (p: Promise<unknown>, status: number, message: string) => {
  const e = await p.then(() => undefined, (err) => err);
  expect(e).toBeInstanceOf(HttpError);
  expect(e).toMatchObject({ status, message });
};

beforeEach(() =>
  reset({
    users: [{ id: 'u1', name: 'Ann', active: true }, { id: 'u2', name: 'Bo', active: true }, { id: 'u3', name: 'Cy', active: false }],
    stock: [{ id: 'MUG', units: 10 }, { id: 'TEE', units: 2 }],
    orders: [
      { id: 'o1', user: 'u1', sku: 'MUG', quantity: 1, status: 'open' },
      { id: 'o2', user: 'u1', sku: 'TEE', quantity: 1, status: 'shipped' },
      { id: 'o3', user: 'u1', sku: 'MUG', quantity: 2, status: 'open' },
      { id: 'o4', user: 'u3', sku: 'MUG', quantity: 5, status: 'open' },
    ],
  }),
);

describe('users', () => {
  test('createUser', async () => {
    expect(await createUser({ id: 'u9', name: '  Dee ' })).toEqual({ id: 'u9', name: 'Dee', active: true });
    await fails(createUser({ id: 'u1', name: 'X' }), 409, 'user u1 exists');
    await fails(createUser({ id: 'u8', name: ' ' }), 400, 'name is required');
  });
  test('getUser', async () => {
    expect(await getUser({ id: 'u2' })).toMatchObject({ name: 'Bo' });
    await fails(getUser({ id: 'u3' }), 404, 'no user u3');
    await fails(getUser({ id: 'zz' }), 404, 'no user zz');
  });
  test('renameUser', async () => {
    expect(await renameUser({ id: 'u2', name: 'Bob' })).toMatchObject({ name: 'Bob' });
    expect(await renameUser({ id: 'u2', name: 'Bob ' })).toMatchObject({ name: 'Bob' });
    await fails(renameUser({ id: 'u2', name: '' }), 400, 'name is required');
    await fails(renameUser({ id: 'zz', name: 'A' }), 404, 'no user zz');
  });
  test('deactivateUser cancels open orders', async () => {
    expect(await deactivateUser({ id: 'u1' })).toEqual({ cancelled: 2 });
    expect(await db.promises.get('users', 'u1')).toMatchObject({ active: false });
    expect((await db.promises.query('orders', (o) => o.user === 'u1')).map((o) => o.status).sort()).toEqual(['cancelled', 'cancelled', 'shipped']);
    await fails(deactivateUser({ id: 'zz' }), 404, 'no user zz');
  });
});

describe('orders', () => {
  test('createOrder takes stock', async () => {
    expect(await createOrder({ id: 'o9', user: 'u2', sku: 'MUG', quantity: 4 })).toMatchObject({ status: 'open', quantity: 4 });
    expect(await db.promises.get('stock', 'MUG')).toMatchObject({ units: 6 });
    await fails(createOrder({ id: 'o10', user: 'u2', sku: 'TEE', quantity: 3 }), 409, 'only 2 TEE left');
    await fails(createOrder({ id: 'o11', user: 'u3', sku: 'MUG', quantity: 1 }), 404, 'no user u3');
    await fails(createOrder({ id: 'o12', user: 'u2', sku: 'MUG', quantity: 0 }), 400, 'quantity must be a positive integer');
    expect(await db.promises.get('orders', 'o10')).toBeUndefined();
  });
  test('listOrders', async () => {
    expect((await listOrders({ user: 'u1' })).map((o) => o.id)).toEqual(['o3', 'o2', 'o1']);
    expect((await listOrders({ user: 'u1', status: 'open' })).map((o) => o.id)).toEqual(['o3', 'o1']);
    expect(await listOrders({ user: 'nobody' })).toEqual([]);
  });
  test('cancelOrder returns units', async () => {
    expect(await cancelOrder({ id: 'o3' })).toMatchObject({ status: 'cancelled' });
    expect(await db.promises.get('stock', 'MUG')).toMatchObject({ units: 12 });
    await fails(cancelOrder({ id: 'o2' }), 409, 'order o2 is shipped');
    await fails(cancelOrder({ id: 'o3' }), 409, 'order o3 is cancelled');
    await fails(cancelOrder({ id: 'zz' }), 404, 'no order zz');
  });
});

describe('stock and reports', () => {
  test('adjustStock', async () => {
    expect(await adjustStock({ sku: 'TEE', delta: 3 })).toEqual({ id: 'TEE', units: 5 });
    expect(await adjustStock({ sku: 'NEW', delta: 1 })).toEqual({ id: 'NEW', units: 1 });
    await fails(adjustStock({ sku: 'TEE', delta: -9 }), 409, 'stock of TEE would be -4');
    await fails(adjustStock({ sku: 'TEE', delta: 0 }), 400, 'delta must be a non-zero integer');
  });
  test('transferStock', async () => {
    expect(await transferStock({ from: 'MUG', to: 'TEE', units: 4 })).toEqual({ from: { id: 'MUG', units: 6 }, to: { id: 'TEE', units: 6 } });
    await fails(transferStock({ from: 'TEE', to: 'MUG', units: 7 }), 409, 'only 6 TEE left');
    await fails(transferStock({ from: 'MUG', to: 'MUG', units: 1 }), 400, 'from and to are the same');
  });
  test('summary leaves out inactive users', async () => {
    expect(await summary({})).toEqual({ byStatus: { open: 2, shipped: 1 }, units: 4 });
  });
});

test('no handler uses the callback API any more', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  for (const f of files(join(import.meta.dir, '..', 'src', 'handlers'))) {
    const src = readFileSync(f, 'utf8');
    expect([f, /\bdone\b|\bdb\.(get|put|remove|query)\(/.test(src)]).toEqual([f, false]);
  }
});
