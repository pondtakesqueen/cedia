// An in-memory table store with two APIs: the old callback one and db.promises. They share the same data.
export type Row = { id: string; [field: string]: unknown };
type Cb<T> = (err: Error | null, value?: T) => void;

let tables = new Map<string, Map<string, Row>>();

export function reset(seed: Record<string, Row[]> = {}): void {
  tables = new Map(Object.entries(seed).map(([t, rows]) => [t, new Map(rows.map((r) => [r.id, { ...r }]))]));
}

const table = (name: string) => {
  let t = tables.get(name);
  if (!t) tables.set(name, (t = new Map()));
  return t;
};

const get = (t: string, id: string): Row | undefined => {
  const r = table(t).get(id);
  return r && { ...r };
};
const put = (t: string, row: Row): Row => {
  table(t).set(row.id, { ...row });
  return { ...row };
};
const remove = (t: string, id: string): boolean => table(t).delete(id);
const query = (t: string, where: (r: Row) => boolean): Row[] => [...table(t).values()].filter(where).map((r) => ({ ...r }));

const later = <T>(f: () => T, cb: Cb<T>) =>
  queueMicrotask(() => {
    try {
      cb(null, f());
    } catch (e) {
      cb(e as Error);
    }
  });

export const db = {
  get: (t: string, id: string, cb: Cb<Row | undefined>) => later(() => get(t, id), cb),
  put: (t: string, row: Row, cb: Cb<Row>) => later(() => put(t, row), cb),
  remove: (t: string, id: string, cb: Cb<boolean>) => later(() => remove(t, id), cb),
  query: (t: string, where: (r: Row) => boolean, cb: Cb<Row[]>) => later(() => query(t, where), cb),
  promises: {
    get: async (t: string, id: string) => get(t, id),
    put: async (t: string, row: Row) => put(t, row),
    remove: async (t: string, id: string) => remove(t, id),
    query: async (t: string, where: (r: Row) => boolean) => query(t, where),
  },
};
