import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { assessStorage, formatBytes, collectStorage, storageLine } from "../src/module/theflow/Storage.js";

test("assessStorage: a review point, not a failure — rows or bytes", () => {
  const T = { reviewRows: 500_000, reviewBytes: 2 * 1024 ** 3 };
  assert.deepEqual(assessStorage({ posts: 10, dbBytes: 1e6 }, T), { reviewDue: false, note: null });
  assert.match(assessStorage({ posts: 500_000, dbBytes: 1e6 }, T).note, /500000 posts ≥ 500000/);
  assert.match(assessStorage({ posts: 1, dbBytes: 3 * 1024 ** 3 }, T).note, /database 3\.00 GB ≥ 2\.00 GB/);
  assert.equal(assessStorage({ posts: 1, dbBytes: null }, T).reviewDue, false);
  assert.deepEqual([formatBytes(500), formatBytes(2048), formatBytes(5 * 1024 ** 2), formatBytes(null)], ["500 B", "2.0 KB", "5.0 MB", "?"]);
});

test("collectStorage reads counts and the database file size", async () => {
  assertTestDatabase();
  await database.connect();
  const s = await collectStorage();
  await database.disconnect();
  assert.ok(Number.isInteger(s.posts));
  assert.ok(s.dbBytes > 0, "the throwaway database file exists");
  assert.match(storageLine(s), /^storage: \d+ posts · database /);
});
