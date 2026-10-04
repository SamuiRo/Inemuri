import test from "node:test";
import assert from "node:assert/strict";

import {
  render, composeBody, truncateWithEntities, collectUpdates, unverifiedCodes, TEMPLATE, LIMITS, MAX_ADDITIONS,
} from "../src/module/theflow/delivery/render.js";

const post = (over = {}) => ({
  id: 1,
  topic: "steam",
  signal_type: "promo_code",
  confidence: 0.91,
  model_used: "m",
  taxonomy_version: 1,
  raw_text: "Code SAVE20 works today",
  text_md: "Code **SAVE20** works today",
  entities: [{ className: "MessageEntityBold", offset: 5, length: 6 }],
  analysis: { summary_uk: "Код SAVE20 діє сьогодні", extracted: { promo_codes: [] } },
  ...over,
});
const routed = { outcome: "routed", reason: "matched_rule" };

test("telegram: entities of the body are rebased past the lead and still cover the same word", () => {
  const r = render({ post: post(), source: "Chan", resolved: routed, platform: "telegram" });
  assert.equal(r.header, "Chan — 🎮 steam · promo_code");
  const e = r.entities[0];
  assert.equal(r.body.slice(e.offset, e.offset + e.length), "SAVE20");
  assert.ok(r.body.startsWith(TEMPLATE.lead("Код SAVE20 діє сьогодні")));
});

test("emoji in the lead are counted in UTF-16 units, like MTProto offsets", () => {
  const r = render({ post: post({ analysis: { summary_uk: "🔥🔥 гаряче" } }), source: "C", resolved: routed, platform: "telegram" });
  const e = r.entities[0];
  assert.equal(r.body.slice(e.offset, e.offset + e.length), "SAVE20");
});

test("diagnostics only in #unsorted", () => {
  const a = render({ post: post(), source: "C", resolved: routed, platform: "telegram" });
  assert.ok(!a.body.includes("🔧"));
  const b = render({ post: post(), source: "C", resolved: { outcome: "unsorted", reason: "low_confidence" }, platform: "telegram" });
  assert.match(b.body, /🔧 low_confidence · confidence 0\.91 · m · taxonomy v1/);
});

test("unverified OCR codes are marked; verified ones are not listed", () => {
  const p = post({ analysis: { extracted: { promo_codes: [
    { code: "TXT1", verified: true }, { code: "OCR9", verified: false, source: "ocr" },
  ] } } });
  assert.deepEqual(unverifiedCodes(p), ["OCR9"]);
  const r = render({ post: p, source: "C", resolved: routed, platform: "telegram" });
  assert.ok(r.body.includes(TEMPLATE.unverified(["OCR9"])));
  assert.ok(!r.body.includes("TXT1,"));
});

test("cluster size renders 'also reported by N'", () => {
  const r = render({ post: post(), cluster: { members_count: 3 }, source: "C", resolved: routed, platform: "telegram" });
  assert.ok(r.body.includes(TEMPLATE.alsoReported(2)));
  const one = render({ post: post(), cluster: { members_count: 1 }, source: "C", resolved: routed, platform: "telegram" });
  assert.ok(!one.body.includes("📡"));
});

test("additions are capped at three with a counter; corrections and denials are never capped", () => {
  const members = [
    { adds: { relation: "adds", adds: [{ text: "a1" }, { text: "a2" }, "a3", "a4", "a5"] } },
    { adds: { relation: "denies", adds: [{ text: "event cancelled" }] } },
    { adds: { relation: "corrects", adds: ["starts at 18:00, not 16:00"] } },
    { adds: null },
  ];
  const { additions, corrections } = collectUpdates(members);
  assert.equal(additions.length, 5);
  assert.equal(corrections.length, 2);

  const r = render({ post: post(), members, source: "C", resolved: routed, platform: "telegram" });
  assert.equal((r.body.match(/➕/g) ?? []).length, MAX_ADDITIONS);
  assert.ok(r.body.includes(TEMPLATE.moreAdditions(2)));
  assert.ok(r.body.startsWith(TEMPLATE.denial("event cancelled")), "the denial is the first thing read");
  assert.ok(r.body.includes(TEMPLATE.correction("starts at 18:00, not 16:00")));
});

test("truncation cuts only the original, at the platform limit; mandatory lines and a denial survive", () => {
  const long = "x".repeat(10_000);
  const p = post({
    raw_text: long, text_md: long,
    entities: [{ className: "MessageEntityBold", offset: 9_990, length: 5 }, { className: "MessageEntityItalic", offset: 0, length: 5 }],
    analysis: { extracted: { promo_codes: [{ code: "OCR9", verified: false }] } },
  });
  const members = [{ adds: { relation: "denies", adds: ["cancelled"] } }];
  const r = render({ post: p, members, cluster: { members_count: 2 }, source: "Chan", resolved: routed, platform: "telegram", link: "https://t.me/c/1/2" });
  assert.equal(r.header.length + 1 + r.body.length <= LIMITS.telegram, true);
  assert.ok(r.body.includes(TEMPLATE.denial("cancelled")));
  assert.ok(r.body.includes(TEMPLATE.unverified(["OCR9"])));
  assert.ok(r.body.includes(TEMPLATE.alsoReported(1)));
  assert.ok(r.body.includes("https://t.me/c/1/2"));
  assert.equal(r.entities.length, 1, "the entity past the cut is dropped");
  assert.ok(r.entities.every((e) => e.offset + e.length <= r.body.length));

  const d = render({ post: p, members, source: "Chan", resolved: routed, platform: "discord" });
  assert.ok(d.description.length <= LIMITS.discord);
  assert.ok(d.description.includes(TEMPLATE.denial("cancelled")));
});

test("entities pointing past the text (drift from text replacements) are clipped, never sent broken", () => {
  const r = truncateWithEntities("short", [
    { className: "B", offset: 2, length: 10 }, { className: "I", offset: 9, length: 2 }, { className: "X", offset: -1, length: 3 },
  ], 100);
  assert.deepEqual(r.entities, [{ className: "B", offset: 2, length: 3 }]);
});

test("truncation never splits an emoji's surrogate pair", () => {
  const r = truncateWithEntities("ab😀cd", [], 4, "…");
  assert.equal(r.text, "ab…");
});

test("composeBody without before/after is the original as is", () => {
  const b = composeBody({ before: [], original: "hi", originalEntities: [{ offset: 0, length: 2 }], after: [], max: 100 });
  assert.deepEqual(b, { text: "hi", entities: [{ offset: 0, length: 2 }] });
});

test("discord: markdown body, author, footer with axes, colour by signal, url", () => {
  const r = render({ post: post({ signal_type: "security" }), source: "Chan", resolved: routed, platform: "discord", link: "https://t.me/c/1/2" });
  assert.equal(r.author, "Chan — 🎮 steam · security");
  assert.ok(r.description.includes("Code **SAVE20** works today"));
  assert.equal(r.footer, "steam · security");
  assert.equal(r.color, TEMPLATE.signalColor.security);
  assert.equal(r.url, "https://t.me/c/1/2");
  assert.ok(!r.description.includes("🔗"), "the link is the author url on Discord, not a body line");
});

test("a failed post (no verdict) renders with the raw text into #unsorted", () => {
  const r = render({
    post: { id: 9, raw_text: "text", text_md: "text", status: "failed", analysis: null },
    source: "C", resolved: { outcome: "unsorted", reason: "model_failed" }, platform: "telegram",
  });
  assert.equal(r.header, "C");
  assert.match(r.body, /^text\n\n🔧 model_failed/);
});

test("unknown platform throws", () => {
  assert.throws(() => render({ post: post(), resolved: routed, platform: "fax" }), /unknown platform/);
});

test("DiscordDestination takes colour, footer and author url from a flow message; classic is unchanged", async () => {
  const { default: DiscordDestination } = await import("../src/destinations/discord/DiscordDestination.js");
  const EventBus = (await import("../src/module/eventbus/EventBus.js")).default;
  const d = new DiscordDestination(new EventBus());

  const flow = (await d._buildPayload({
    source: { name: "Chan — 🎮 steam · security" }, text: "body",
    embed: { color: 0xe03131, footer: "steam · security", url: "https://t.me/c/1/2" },
  })).embeds[0].toJSON();
  assert.equal(flow.color, 0xe03131);
  assert.equal(flow.footer.text, "steam · security");
  assert.equal(flow.author.url, "https://t.me/c/1/2");

  const classic = (await d._buildPayload({ source: { name: "Chan" }, text: "body" })).embeds[0].toJSON();
  assert.equal(classic.color, 0x5865f2);
  assert.equal(classic.footer, undefined);
  assert.equal(classic.author.url, undefined);
});

test("phase 4 — the event line sits under the lead; a date from an image says so", async () => {
  const { eventLine } = await import("../src/module/theflow/delivery/render.js");
  const withEvent = (event) => post({ analysis: { summary_uk: "Лід", extracted: { event } } });
  const r = render({ post: withEvent({ name: "Case drop", starts_at: "2026-10-05T18:00+00:00", ends_at: "2026-10-12", verified: true }),
    source: "C", resolved: routed, platform: "telegram" });
  assert.match(r.body, /^🇺🇦 Лід\n📅 Case drop — 2026-10-05 18:00 → 2026-10-12\n\n/);
  const e = r.entities[0];
  assert.equal(r.body.slice(e.offset, e.offset + e.length), "SAVE20", "entities still rebased past two lead lines");
  assert.match(eventLine(withEvent({ name: "X", starts_at: "2026-10-05", verified: false })), /unverified/);
  assert.equal(eventLine(withEvent({ name: "No date", starts_at: null, ends_at: null })), null);
});

test("text_uk — a non-Ukrainian post is delivered in translation, without the original's entities", () => {
  const p = post({ analysis: { summary_uk: "Код діє", text_uk: "Код SAVE20 діє сьогодні (переклад)" } });
  const tg = render({ post: p, source: "C", resolved: routed, platform: "telegram" });
  assert.ok(tg.body.includes("Код SAVE20 діє сьогодні (переклад)"));
  assert.ok(!tg.body.includes("Code SAVE20 works today"));
  assert.deepEqual(tg.entities, [], "entities оригіналу індексують інший рядок");
  const dc = render({ post: p, source: "C", resolved: routed, platform: "discord" });
  assert.ok(dc.description.includes("(переклад)"));
  assert.ok(!dc.description.includes("**SAVE20**"));
});

test("text_uk — absent or blank keeps the original body and entities", () => {
  for (const text_uk of [null, undefined, "   "]) {
    const r = render({ post: post({ analysis: { summary_uk: "x", text_uk } }), source: "C", resolved: routed, platform: "telegram" });
    assert.ok(r.body.includes("Code SAVE20 works today"));
    assert.equal(r.entities.length, 1);
  }
});

test("telegram: a post with media fits the caption limit (1024 without Premium), text-only keeps 4096", () => {
  const long = "x".repeat(10_000);
  const withMedia = post({ raw_text: long, has_media: true });
  const r = render({ post: withMedia, source: "Chan", resolved: routed, platform: "telegram", link: "https://t.me/c/1/2" });
  assert.equal(LIMITS.telegramCaption, 1024, "the safe default");
  assert.ok(r.header.length + 1 + r.body.length <= 1024);
  assert.ok(r.body.includes("https://t.me/c/1/2"), "mandatory lines survive the shorter budget");

  const premium = render({ post: withMedia, source: "Chan", resolved: routed, platform: "telegram", captionLimit: 4096 });
  assert.ok(premium.header.length + 1 + premium.body.length > 1024);
  assert.ok(premium.header.length + 1 + premium.body.length <= 4096);

  const textOnly = render({ post: post({ raw_text: long }), source: "Chan", resolved: routed, platform: "telegram" });
  assert.ok(textOnly.header.length + 1 + textOnly.body.length > 1024, "no media — the message limit applies");
});
