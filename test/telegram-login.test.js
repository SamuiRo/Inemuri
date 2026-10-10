import test from "node:test";
import assert from "node:assert/strict";
import { Api } from "telegram";

import { describeSentCode, readCodeAnswer } from "../src/module/telegram/loginCode.js";

const sent = (type, extra = {}) => new Api.auth.SentCode({ type, phoneCodeHash: "h", ...extra });

test("describeSentCode: the app, not SMS — the most common 'code never came'", () => {
  const d = describeSentCode(sent(new Api.auth.SentCodeTypeApp({ length: 5 })));
  assert.equal(d.where, "app");
  assert.equal(d.expectCode, true);
  assert.match(d.hint, /Telegram app/);
  assert.match(d.hint, /5 digits/);
});

test("describeSentCode: no code at all — email setup required, Firebase", () => {
  for (const type of [
    new Api.auth.SentCodeTypeSetUpEmailRequired({}),
    new Api.auth.SentCodeTypeFirebaseSms({ length: 5 }),
  ]) {
    const d = describeSentCode(sent(type));
    assert.equal(d.expectCode, false, type.className);
    assert.match(d.hint, /no code/);
  }
});

test("describeSentCode: next way and timeout come from nextType", () => {
  const d = describeSentCode(sent(new Api.auth.SentCodeTypeApp({ length: 5 }), { nextType: new Api.auth.CodeTypeSms(), timeout: 60 }));
  assert.equal(d.next, "SMS");
  assert.equal(d.timeout, 60);
  assert.equal(describeSentCode(sent(new Api.auth.SentCodeTypeSms({ length: 5 }))).next, null);
});

test("describeSentCode: email, missed call, word, unknown type, success", () => {
  assert.match(describeSentCode(sent(new Api.auth.SentCodeTypeEmailCode({ emailPattern: "a***@x.com", length: 6 }))).hint, /a\*\*\*@x\.com/);
  assert.match(describeSentCode(sent(new Api.auth.SentCodeTypeMissedCall({ prefix: "+44", length: 4 }))).hint, /last 4 digits/);
  assert.match(describeSentCode(sent(new Api.auth.SentCodeTypeSmsWord({ beginning: "ap" }))).hint, /"ap"/);
  const unknown = describeSentCode({ type: { className: "auth.SentCodeTypeFuture" } });
  assert.equal(unknown.where, "unknown");
  assert.equal(unknown.expectCode, true);
  assert.equal(describeSentCode(new Api.auth.SentCodeSuccess({ authorization: new Api.auth.Authorization({}) })).success, true);
});

test("readCodeAnswer: commands, digits with separators, words kept", () => {
  assert.deepEqual(readCodeAnswer("resend"), { action: "resend" });
  assert.deepEqual(readCodeAnswer(" R "), { action: "resend" });
  assert.deepEqual(readCodeAnswer("qr"), { action: "qr" });
  assert.deepEqual(readCodeAnswer(""), { action: "empty" });
  assert.deepEqual(readCodeAnswer("12 345"), { action: "code", code: "12345" });
  assert.deepEqual(readCodeAnswer("12-345"), { action: "code", code: "12345" });
  assert.deepEqual(readCodeAnswer("apple tree"), { action: "code", code: "apple tree" });
});
