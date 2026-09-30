import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { Post, Source, ProviderQuota } from "../src/module/teapot/models/index.js";
import { collectHealthSnapshot, assessHealth } from "../src/module/theflow/FlowHealth.js";

// Пише в SQLite — лише на одноразовій базі з `npm test` (test/support).
// Знімок рахує по всій таблиці, тож тест прибирає за собою і не покладається
// на відсутність чужих рядків — порівнює приріст.
const XID = `__fh_${process.pid}_`;
const QKEY = `${XID}provider:model`;
let sourceId;

test.before(async () => {
  assertTestDatabase();
  await database.connect();
  const [source] = await Source.findOrCreate({
    where: { channel_id: `${XID}channel` },
    defaults: {
      platform: "telegram", channel_id: `${XID}channel`, channel_name: "flow health test",
      flow: { enabled: true },
    },
  });
  sourceId = source.id;
});
test.after(async () => {
  await Post.destroy({ where: { source_id: sourceId } });
  await Source.destroy({ where: { id: sourceId } });
  await ProviderQuota.destroy({ where: { provider: QKEY } });
  await database.disconnect();
});

let seq = 0;
async function make(over) {
  seq += 1;
  const [p] = await Post.ingest({
    source_id: sourceId, platform: "telegram", external_id: `${XID}${seq}`,
    channel_id: "-100test", raw_text: "t", text_md: "t",
    text_hash: `${XID}h${seq}`, status: "pending", attempts: 0, ...over,
  });
  return p;
}

test("collectHealthSnapshot reads the window, the oldest pending and the quota row", async () => {
  const base = await collectHealthSnapshot({ failureWindowMin: 60 });

  for (let i = 0; i < 6; i++) await make({ status: "failed", last_error: "bad_response: HTTP 400 schema" });
  await make({ status: "enriched" });
  const old = await make({ status: "pending" });
  // Старий pending: createdAt у минуле напряму, бо ingest ставить now.
  const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000);
  await Post.update({ createdAt: threeHoursAgo }, { where: { id: old.id }, silent: true });
  // failed поза вікном не рахується.
  const stale = await make({ status: "failed", last_error: "old" });
  await database.sequelize.query("UPDATE posts SET updatedAt = ? WHERE id = ?", {
    replacements: ["2000-01-01 00:00:00.000 +00:00", stale.id],
  });
  await ProviderQuota.bump(QKEY, ProviderQuota.today("America/Los_Angeles"));

  const s = await collectHealthSnapshot({
    failureWindowMin: 60,
    quota: { key: QKEY, timeZone: "America/Los_Angeles", rpd: 500 },
  });

  assert.equal(s.window.failed - base.window.failed, 6);
  assert.equal(s.window.enriched - base.window.enriched, 1);
  assert.equal(s.window.topErrors[0].error, "bad_response: HTTP 400 schema");
  assert.equal(s.pending - base.pending, 1);
  assert.ok(s.oldestPendingAt instanceof Date);
  assert.ok(s.oldestPendingAt.getTime() <= threeHoursAgo.getTime() + 1000);
  assert.ok(s.flowSources >= 1);
  assert.deepEqual(s.quota, { key: QKEY, used: 1, rpd: 500, exhausted: false });

  const r = assessHealth(s, { pendingMaxAgeMin: 120, failureMin: 5, failureShare: 0.5, ingestSilentHours: 24 });
  assert.ok(r.problems.some((p) => p.key === "enrich_failing"));
  // Щойно завершені пости — воркер іде, старий pending ще не застій.
  assert.ok(s.lastFinishedAt instanceof Date);
  assert.ok(Date.now() - s.lastFinishedAt.getTime() < 60_000);
  assert.ok(!r.problems.some((p) => p.key === "enrich_stalled"));
});
