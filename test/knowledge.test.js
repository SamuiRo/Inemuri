import test from "node:test";
import assert from "node:assert/strict";

import { contentHash, snapshotFromPost } from "../src/module/theflow/knowledge/snapshot.js";
import {
  serialize, parse, toRecord, validateRecord, EXCHANGE_FIELDS, KNOWLEDGE_FORMAT,
} from "../src/module/theflow/knowledge/exchange.js";

const post = {
  id: 7, source_id: 3, platform: "rss", title: "Fed holds rates",
  raw_text: "The Fed kept rates  unchanged.", text_ocr: "chart: 5.25%", text_en: "The Fed kept rates unchanged.",
  external_url: "https://example.com/fed", posted_at: new Date("2026-10-01T12:00:00Z"),
  topic: "macro", signal_type: "news", taxonomy_version: 2,
  analysis: JSON.stringify({ entities: { orgs: ["Fed"] }, extracted: { amounts: [] }, summary_uk: "x" }),
};
const label = { verdict: "good", origin: "review", sourceName: "Example News", feedbackId: 11, createdAt: new Date("2026-10-02T00:00:00Z") };

test("contentHash ignores whitespace and case, but not level or title", () => {
  const a = contentHash({ level: "post", title: "T", body: "Some  Text" });
  assert.equal(a, contentHash({ level: "post", title: "t", body: " some text " }));
  assert.notEqual(a, contentHash({ level: "headline", title: "T", body: "Some Text" }));
  assert.notEqual(a, contentHash({ level: "post", title: "Other", body: "Some Text" }));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("snapshotFromPost carries the content, classification and local links", () => {
  const s = snapshotFromPost(post, { ...label, reason: "  rate decision  " });
  assert.equal(s.body, "The Fed kept rates  unchanged.\n\nchart: 5.25%");
  assert.equal(s.level, "post");
  assert.equal(s.reason, "rate decision");
  assert.equal(s.source_name, "Example News");
  assert.equal(s.url, "https://example.com/fed");
  assert.deepEqual(s.extracted, { entities: { orgs: ["Fed"] }, extracted: { amounts: [] } });
  assert.equal(s.taxonomy_version, 2);
  assert.equal(s.post_id, 7);
  assert.equal(s.feedback_id, 11);
  assert.equal(s.content_hash, contentHash({ level: "post", title: "Fed holds rates", body: s.body }));
  assert.match(s.uid, /^[0-9a-f-]{36}$/);
  assert.notEqual(s.uid, snapshotFromPost(post, label).uid);
});

test("snapshotFromPost falls back to text_en, and refuses a post with no text at all", () => {
  assert.equal(snapshotFromPost({ ...post, raw_text: "", text_ocr: null }, label).body, "The Fed kept rates unchanged.");
  assert.equal(snapshotFromPost({ id: 1, raw_text: " ", text_en: null }, label), null);
  assert.equal(snapshotFromPost({ ...post, analysis: null }, label).extracted, null);
});

test("export → parse round-trips every exported field and never leaks local ids", () => {
  const row = { id: 99, ...snapshotFromPost(post, label) };
  const text = serialize([row], { now: new Date("2026-10-03T00:00:00Z") });
  const [headerLine, recordLine] = text.trim().split("\n");
  assert.deepEqual(JSON.parse(headerLine), { format: KNOWLEDGE_FORMAT, version: 1, exported_at: "2026-10-03T00:00:00.000Z", count: 1 });

  const record = JSON.parse(recordLine);
  assert.deepEqual(Object.keys(record), EXCHANGE_FIELDS);
  for (const local of ["id", "post_id", "feedback_id", "content_hash"]) assert.ok(!(local in record), local);

  const { rows, errors } = parse(text);
  assert.deepEqual(errors, []);
  assert.equal(rows[0].uid, row.uid);
  assert.equal(rows[0].content_hash, row.content_hash);
  assert.equal(rows[0].created_at.toISOString(), "2026-10-02T00:00:00.000Z");
  assert.deepEqual(toRecord(rows[0]), record);
});

test("parse refuses a foreign or newer file outright, and skips bad lines by number", () => {
  assert.throws(() => parse("not json\n"), /line 1/);
  assert.throws(() => parse('{"format":"other","version":1}\n'), /format/);
  assert.throws(() => parse(`{"format":"${KNOWLEDGE_FORMAT}","version":2}\n`), /unsupported version 2/);

  const good = toRecord(snapshotFromPost(post, label));
  const text = [
    JSON.stringify({ format: KNOWLEDGE_FORMAT, version: 1, exported_at: "2026-10-03T00:00:00Z", count: 3 }),
    JSON.stringify(good),
    "{oops",
    "",
    JSON.stringify({ ...good, verdict: "great" }),
  ].join("\n");
  const { rows, errors } = parse(text);
  assert.equal(rows.length, 1);
  assert.deepEqual(errors, [{ line: 3, error: "not JSON" }, { line: 5, error: 'unknown verdict "great"' }]);
});

test("validateRecord checks identity, vocabulary, body and types", () => {
  const good = toRecord(snapshotFromPost(post, label));
  assert.equal(validateRecord(good), null);
  assert.match(validateRecord({ ...good, uid: "7" }), /uid/);
  assert.match(validateRecord({ ...good, level: "tweet" }), /level/);
  assert.match(validateRecord({ ...good, origin: "guess" }), /origin/);
  assert.match(validateRecord({ ...good, body: "  " }), /body/);
  assert.match(validateRecord({ ...good, created_at: "yesterday" }), /created_at/);
  assert.match(validateRecord({ ...good, taxonomy_version: "2" }), /taxonomy_version/);
  assert.match(validateRecord({ ...good, extracted: [] }), /extracted/);
  assert.match(validateRecord({ ...good, topic: 5 }), /topic/);
  assert.match(validateRecord([]), /object/);
});
