import test from "node:test";
import assert from "node:assert/strict";

import FlowIngest from "../src/module/theflow/FlowIngest.js";

// The static helpers on FlowIngest are pure — no DB, no network. They shape
// every row that reaches the corpus, so they are worth pinning down.

test("_serializeEntities — keeps MessageEntity* only, drops the rest", () => {
  const out = FlowIngest._serializeEntities([
    { className: "MessageEntityBold", offset: 0, length: 4 },
    { className: "MessageEntityTextUrl", offset: 5, length: 3, url: "https://x.io" },
    { className: "MessageEntityPre", offset: 9, length: 2, language: "js" },
    { offset: 0, length: 3 }, // no className -> dropped
    { className: "SomethingElse", offset: 0, length: 1 }, // not MessageEntity* -> dropped
    { className: "MessageEntityBold", offset: "x", length: 4 }, // bad offset -> dropped
  ]);
  assert.deepEqual(out, [
    { className: "MessageEntityBold", offset: 0, length: 4 },
    { className: "MessageEntityTextUrl", offset: 5, length: 3, url: "https://x.io" },
    { className: "MessageEntityPre", offset: 9, length: 2, language: "js" },
  ]);
});

test("_serializeEntities — empty / non-array / all-dropped => null", () => {
  assert.equal(FlowIngest._serializeEntities([]), null);
  assert.equal(FlowIngest._serializeEntities(null), null);
  assert.equal(FlowIngest._serializeEntities(undefined), null);
  assert.equal(FlowIngest._serializeEntities([{ foo: 1 }]), null);
});

test("_buildMediaRef — telegram shape", () => {
  const ref = FlowIngest._buildMediaRef("-100123", { messageId: 42, groupedId: "G7" });
  assert.deepEqual(ref, {
    kind: "telegram",
    channel_id: "-100123",
    message_id: 42,
    grouped_id: "G7",
  });
  assert.equal(
    FlowIngest._buildMediaRef("-100123", { messageId: 42, groupedId: undefined }).grouped_id,
    null,
  );
});

test("_hasRealMedia — only real media types count", () => {
  assert.equal(FlowIngest._hasRealMedia(null), false);
  assert.equal(FlowIngest._hasRealMedia({ type: "webpage" }), false);
  assert.equal(FlowIngest._hasRealMedia({ type: "photo" }), true);
  assert.equal(FlowIngest._hasRealMedia([{ type: "poll" }, { type: "video" }]), true);
  assert.equal(FlowIngest._hasRealMedia([{ type: "poll" }]), false);
});

test("_toDate — unix seconds, Date passthrough, null", () => {
  assert.equal(FlowIngest._toDate(null), null);
  assert.equal(FlowIngest._toDate(undefined), null);
  const d = new Date("2026-01-02T03:04:05Z");
  assert.equal(FlowIngest._toDate(d), d);
  assert.deepEqual(FlowIngest._toDate(1_700_000_000), new Date(1_700_000_000 * 1000));
  assert.equal(FlowIngest._toDate("not a date"), null);
});
