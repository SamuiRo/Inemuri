import test from "node:test";
import assert from "node:assert/strict";
import { Api } from "telegram";

import { mergeAlbumText } from "../src/sources/telegram/TelegramGroupBuffer.js";

// Повідомлення альбому так, як їх віддає TelegramMessageParser.
const msg = (id, rawText = "", entities = []) => ({ messageId: id, rawText, text: rawText, entities });

test("caption on the second item — rawText and entities come from it, not from the empty first", () => {
  // Регресія (аудит 2026-10-04): rawText брався з першого повідомлення, і
  // альбом із підписом не на першому елементі ставав skipped_empty у TheFlow,
  // а класичний шлях слав його без підпису.
  const bold = new Api.MessageEntityBold({ offset: 0, length: 4 });
  const r = mergeAlbumText([msg(10), msg(11, "Code SAVE20", [bold]), msg(12)]);
  assert.equal(r.rawText, "Code SAVE20");
  assert.equal(r.text, "Code SAVE20");
  assert.deepEqual(r.entities, [bold]);
});

test("several captions — joined, each one's entities shifted past what precedes it", () => {
  const first = new Api.MessageEntityBold({ offset: 0, length: 3 });
  const second = new Api.MessageEntityItalic({ offset: 3, length: 4 }); // "Two!" після "🎮 " (2 + 1)
  const r = mergeAlbumText([msg(1, "One"), msg(2, "🎮 Two!", [second]), msg(3, "", [])].map((m, i) => (i === 0 ? { ...m, entities: [first] } : m)));
  assert.equal(r.rawText, "One\n🎮 Two!");
  assert.equal(r.entities.length, 2);
  assert.equal(r.entities[0].offset, 0);
  // "One\n" — 4 одиниці UTF-16 зсуву.
  assert.equal(r.entities[1].offset, 7);
  assert.equal(r.entities[1].className, "MessageEntityItalic");
  assert.equal(r.rawText.slice(r.entities[1].offset, r.entities[1].offset + r.entities[1].length), "Two!");
  assert.equal(second.offset, 3, "the message's own entity is not mutated");
});

test("no caption at all — empty text, no entities", () => {
  assert.deepEqual(mergeAlbumText([msg(1), msg(2)]), { rawText: "", text: "", entities: [] });
});
