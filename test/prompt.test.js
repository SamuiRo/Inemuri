import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";

import { askText, askSecret } from "../src/shared/prompt.js";

/** Потік, що віддає задані рядки так, ніби їх набрали в терміналі. */
function fakeStdin(...lines) {
  return Readable.from(lines.map((l) => `${l}\n`));
}

/** Потік, що збирає все написане, щоб перевірити, що саме побачив користувач. */
function capture() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  stream.written = () => chunks.join("");
  return stream;
}

// ── askText ───────────────────────────────────────────────────────────

test("askText — returns the typed line", async () => {
  const out = capture();
  const answer = await askText("Phone number: ", { input: fakeStdin("+380001112233"), output: out });
  assert.equal(answer, "+380001112233");
});

test("askText — shows the prompt", async () => {
  const out = capture();
  await askText("Verification code: ", { input: fakeStdin("12345"), output: out });
  assert.match(out.written(), /Verification code: /);
});

test("askText — trims whitespace a paste can bring along", async () => {
  const out = capture();
  assert.equal(await askText("x", { input: fakeStdin("  12345  "), output: out }), "12345");
});

test("askText — an empty line is an empty string, not a hang", async () => {
  const out = capture();
  assert.equal(await askText("x", { input: fakeStdin(""), output: out }), "");
});

test("askText — does not keep the event loop alive", async () => {
  // Відкритий readline на stdin тримає процес живим: якби інтерфейс не
  // закривався, `npm start` не завершився б після авторизації.
  const out = capture();
  const before = process.getActiveResourcesInfo().length;
  await askText("x", { input: fakeStdin("y"), output: out });
  assert.ok(
    process.getActiveResourcesInfo().length <= before,
    "після запиту не має лишатися відкритих ресурсів",
  );
});

// ── askSecret ─────────────────────────────────────────────────────────

test("askSecret — returns the typed secret", async () => {
  const out = capture();
  const answer = await askSecret("Password: ", { input: fakeStdin("hunter2"), output: out });
  assert.equal(answer, "hunter2");
});

test("askSecret — the secret never reaches the output", async () => {
  // Головне у цій заміні: `input.text()` зі старого пакета друкував 2FA-пароль
  // у термінал відкритим текстом і лишав його в історії сесії.
  const out = capture();
  await askSecret("Password: ", { input: fakeStdin("s3cr3t-value"), output: out });
  const seen = out.written();
  assert.match(seen, /Password: /, "сам запит показати треба");
  assert.equal(seen.includes("s3cr3t-value"), false, "а відповідь — ні");
});

test("askSecret — no partial echo either", async () => {
  // Луна в терміналі йде посимвольно, тож перевіряємо і підрядки.
  const out = capture();
  await askSecret("P: ", { input: fakeStdin("abcdef"), output: out });
  const seen = out.written();
  for (const part of ["abcdef", "abcde", "abc", "ab"]) {
    assert.equal(seen.includes(part), false, `не має бути "${part}"`);
  }
});

test("askSecret — trims, and an empty secret is an empty string", async () => {
  const out1 = capture();
  assert.equal(await askSecret("x", { input: fakeStdin("  pw  "), output: out1 }), "pw");
  const out2 = capture();
  assert.equal(await askSecret("x", { input: fakeStdin(""), output: out2 }), "");
});

test("askSecret — unmutes afterwards, so later output is not swallowed", async () => {
  const out = capture();
  await askSecret("P: ", { input: fakeStdin("pw"), output: out });
  out.write("visible again");
  assert.match(out.written(), /visible again/);
});

test("askSecret — the control case: without muting, readline DOES echo", async () => {
  // Без цього тест «секрет не потрапив у вивід» нічого не доводив би: могло б
  // виявитись, що readline на фейковому потоці не робить луни взагалі.
  // Тут той самий інтерфейс без глушіння — і луна є.
  const readline = (await import("node:readline/promises")).default;
  const out = capture();
  const rl = readline.createInterface({
    input: fakeStdin("s3cr3t-value"), output: out, terminal: true,
  });
  await rl.question("Password: ");
  rl.close();
  assert.ok(out.written().includes("s3cr3t-value"), "контроль: луна має бути");

  const muted = capture();
  await askSecret("Password: ", { input: fakeStdin("s3cr3t-value"), output: muted });
  assert.equal(muted.written().includes("s3cr3t-value"), false, "а з глушінням — ні");
});
