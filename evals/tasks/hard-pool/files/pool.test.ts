import { expect, test } from "bun:test";
import { runPool } from "./pool";

const later = <T>(ms: number, v: T) => () => new Promise<T>((r) => setTimeout(() => r(v), ms));

test("runs every task and resolves with their values", async () => {
  const out = await runPool([later(5, "a"), later(5, "b")], 2);
  expect(out.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
});

test("an empty list resolves with nothing", async () => {
  expect(await runPool([], 3)).toEqual([]);
});

test("a limit of zero is refused", async () => {
  await expect(runPool([later(1, 1)], 0)).rejects.toBeInstanceOf(RangeError);
});
