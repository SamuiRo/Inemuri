import test from "node:test";
import assert from "node:assert/strict";

import RegexStage from "../src/module/theflow/RegexStage.js";

// RegexStage.evaluate() is a pure function and the phase 0.5 exit gate asks
// for it to be covered: four rejection paths, the rejection order, and the
// five candidate extractors.

const stage = new RegexStage({ minTextLength: 10 });

test("skipped_empty — shorter than minTextLength after normalization", () => {
  assert.equal(stage.evaluate({ text: "", blacklist: null }).status, "skipped_empty");
  assert.equal(stage.evaluate({ text: "   \n  ", blacklist: null }).status, "skipped_empty");
  assert.equal(stage.evaluate({ text: "too short", blacklist: null }).status, "skipped_empty");
  // whitespace collapses, so this is 9 visible chars -> still short
  assert.equal(stage.evaluate({ text: "a b c d e", blacklist: null }).status, "skipped_empty");
});

test("ok — ordinary text of sufficient length", () => {
  const r = stage.evaluate({ text: "New airdrop is live, claim before Friday", blacklist: null });
  assert.equal(r.status, "ok");
  assert.equal(typeof r.textHash, "string");
  assert.equal(r.textHash.length, 40); // sha1 hex
});

test("skipped_blacklist — case-insensitive substring match", () => {
  const bl = new Set(["розыгрыш завершен"]);
  const r = stage.evaluate({ text: "РОЗЫГРЫШ ЗАВЕРШЕН! Победители ниже", blacklist: bl });
  assert.equal(r.status, "skipped_blacklist");
});

test("blacklist — caseSensitive must match how the Set was compiled", () => {
  // case_sensitive=false: MessageFilter lowercases the words, RegexStage
  // lowercases the haystack -> a mixed-case hit still matches.
  assert.equal(
    stage.evaluate({
      text: "Big STREAM starts now, come watch it live",
      blacklist: new Set(["stream"]),
      caseSensitive: false,
    }).status,
    "skipped_blacklist",
  );
  // case_sensitive=true: the word keeps its case and so does the haystack.
  assert.equal(
    stage.evaluate({
      text: "Big STREAM starts now, come watch it live",
      blacklist: new Set(["STREAM"]),
      caseSensitive: true,
    }).status,
    "skipped_blacklist",
  );
  // case_sensitive=true with a wrong-case word -> no match (the latent bug
  // this guards: RegexStage must NOT force-lowercase here).
  assert.equal(
    stage.evaluate({
      text: "Big STREAM starts now, come watch it live",
      blacklist: new Set(["stream"]),
      caseSensitive: true,
    }).status,
    "ok",
  );
});

test("blacklist does not fire when empty, null, or not matched", () => {
  const text = "Genuine content that should pass through cleanly";
  assert.equal(stage.evaluate({ text, blacklist: null }).status, "ok");
  assert.equal(stage.evaluate({ text, blacklist: new Set() }).status, "ok");
  assert.equal(stage.evaluate({ text, blacklist: new Set(["unrelated"]) }).status, "ok");
});

test("skipped_noise — link only / emoji only, but long enough to pass the empty check", () => {
  assert.equal(
    stage.evaluate({ text: "https://example.com/a/very/long/path/here", blacklist: null }).status,
    "skipped_noise",
  );
  assert.equal(
    stage.evaluate({ text: "🔥 🔥 🔥 🔥 🔥 🔥 🔥", blacklist: null }).status,
    "skipped_noise",
  );
});

test("rejection order — empty beats blacklist beats noise", () => {
  // short AND blacklisted -> empty wins (checked first)
  assert.equal(
    stage.evaluate({ text: "spam", blacklist: new Set(["spam"]) }).status,
    "skipped_empty",
  );
  // long link-only AND blacklisted -> blacklist wins (checked before noise)
  assert.equal(
    stage.evaluate({
      text: "https://spammy.example.com/aaaaaaaaaa",
      blacklist: new Set(["spammy"]),
    }).status,
    "skipped_blacklist",
  );
});

test("normalize + hash — whitespace and case insensitive, stable, null on empty", () => {
  const a = stage.evaluate({ text: "Hello   World  Foo", blacklist: null });
  const b = stage.evaluate({ text: "hello world foo", blacklist: null });
  const c = stage.evaluate({ text: "​HELLO\nWORLD\tFOO​", blacklist: null });
  assert.equal(a.textHash, b.textHash);
  assert.equal(a.textHash, c.textHash);

  const d = stage.evaluate({ text: "hello world bar", blacklist: null });
  assert.notEqual(a.textHash, d.textHash);

  assert.equal(stage.evaluate({ text: "", blacklist: null }).textHash, null);
});

test("candidates — promo codes need both a digit and a letter", () => {
  const { candidates } = stage.evaluate({
    text: "Use code BONUS50 or WELCOME2024, not HELLO or 123456 here today",
    blacklist: null,
  });
  assert.deepEqual(candidates.promo_codes.sort(), ["BONUS50", "WELCOME2024"].sort());
});

test("candidates — letter-only codes of 10+ chars count as promo codes", () => {
  // Коди без жодної цифри: правило digit+letter їх мовчки пропускало.
  // Коротші капсові слова лишаються відсіяними.
  const { candidates } = stage.evaluate({
    text: "Codes: ABCDEFGHJKMN, QRSTUVWXYZAB and CDEFGHJKMNPQ — not STEAM or GIVEAWAY",
    blacklist: null,
  });
  assert.deepEqual(
    candidates.promo_codes.sort(),
    ["ABCDEFGHJKMN", "CDEFGHJKMNPQ", "QRSTUVWXYZAB"].sort(),
  );
});

test("candidates — a multi-code post yields every code, mixed forms", () => {
  // Форма реального поста-переліку: коди по одному на рядок, частина з
  // цифрами, частина без. Раніше поверталися лише ті, що з цифрами.
  const { candidates } = stage.evaluate({
    text: "Codes 💎\n\nAB3CD4EF5GHJ\n\nKM6NP7QR8STU\n\nVWXYZABCDEFG\n",
    blacklist: null,
  });
  assert.deepEqual(
    candidates.promo_codes.sort(),
    ["AB3CD4EF5GHJ", "KM6NP7QR8STU", "VWXYZABCDEFG"].sort(),
  );
});

test("candidates — tickers, urls (trailing punctuation stripped), amounts, dates", () => {
  const { candidates } = stage.evaluate({
    text:
      "Buy $BTC and $ETH now. See (https://site.io/path). " +
      "Deadline 2026-03-01 or 15.04 — up to 50% off, pay $10.",
    blacklist: null,
  });
  assert.ok(candidates.tickers.includes("$BTC"));
  assert.ok(candidates.tickers.includes("$ETH"));
  assert.ok(candidates.urls.includes("https://site.io/path"), "trailing ). stripped");
  assert.ok(candidates.dates.includes("2026-03-01"));
  assert.ok(candidates.dates.includes("15.04"));
  assert.ok(candidates.amounts.some((a) => a.includes("50%")));
  assert.ok(candidates.amounts.some((a) => a.includes("$10")));
});

test("candidates — deduplicated and capped at 20 per list", () => {
  const many = Array.from({ length: 30 }, (_, i) => `CODE${i}A`).join(" ");
  const { candidates } = stage.evaluate({ text: `promo ${many} end`, blacklist: null });
  assert.equal(candidates.promo_codes.length, 20);

  const dup = stage.evaluate({ text: "$BTC $BTC $BTC is the only ticker here", blacklist: null });
  assert.deepEqual(dup.candidates.tickers, ["$BTC"]);
});

test("static normalize / hash are usable directly", () => {
  assert.equal(RegexStage.normalize("  A\tB  "), "a b");
  assert.equal(RegexStage.hash("a b"), RegexStage.hash("a b"));
  assert.notEqual(RegexStage.hash("a b"), RegexStage.hash("a c"));
});
