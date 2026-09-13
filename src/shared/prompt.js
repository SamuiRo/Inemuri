import readline from "node:readline/promises";
import { Writable } from "node:stream";

/**
 * Інтерактивні запити в термінал, на вбудованому node:readline/promises.
 *
 * Замінює пакет `input@1.0.1`, який тягнув `inquirer@0.12.0` (реліз 2016) і
 * власну копію `lodash` заради трьох викликів у шляху авторизації Telegram.
 *
 * Один інтерфейс на запит, із закриттям одразу після відповіді. Це не
 * марнотратство: відкритий readline на stdin тримає event loop живим, і
 * процес не завершився б після `npm start`.
 *
 * Потоки ін'єктуються, щоб це можна було перевірити тестом без терміналу.
 */

/**
 * Питання з відкритою відповіддю.
 * @param {string} query Текст запиту разом із роздільником, напр. "Phone: ".
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} [io]
 * @returns {Promise<string>} Відповідь без кінцевих пробілів.
 */
export async function askText(query, io = {}) {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;

  const rl = readline.createInterface({ input, output, terminal: false });
  try {
    const answer = await rl.question(query);
    return String(answer ?? "").trim();
  } finally {
    rl.close();
  }
}

/**
 * Питання, відповідь на яке не має з'явитися на екрані.
 *
 * `input.text()` зі старого пакета використовувався і для пароля теж, тобто
 * 2FA-пароль друкувався у термінал відкритим текстом і лишався в історії
 * сесії. Тут вивід глушиться одразу після того, як надруковано сам запит.
 *
 * @param {string} query
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} [io]
 * @returns {Promise<string>}
 */
export async function askSecret(query, io = {}) {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;

  // Проксі-потік: після ввімкнення `muted` перестає пропускати луну вводу далі.
  const gate = new Writable({
    write(chunk, encoding, callback) {
      if (!gate.muted) output.write(chunk, encoding);
      callback();
    },
  });
  gate.muted = false;

  // terminal: true — інакше readline не робить луни взагалі й глушити нічого,
  // але й сам запит не з'явиться.
  const rl = readline.createInterface({ input, output: gate, terminal: true });
  try {
    const pending = rl.question(query); // запит друкується синхронно
    gate.muted = true;                  // усе після нього — вже ввід
    const answer = await pending;
    return String(answer ?? "").trim();
  } finally {
    gate.muted = false;
    rl.close();
    output.write("\n"); // Enter користувача теж був проковтнутий
  }
}

export default { askText, askSecret };
