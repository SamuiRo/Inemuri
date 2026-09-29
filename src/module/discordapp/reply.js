// Discord обрізає content на 2000; запас — під рядок про вкладення.
const INLINE_LIMIT = 1900;

/**
 * Довгий текст для відповіді: якщо влазить — як є, інакше — початок у
 * повідомленні і повний текст файлом. Чиста функція.
 *
 * @param {string} text
 * @param {string} fileName  Ім'я вкладення, напр. "provision-plan.md".
 * @returns {string|{ content: string, files: { attachment: Buffer, name: string }[] }}
 */
export function textReply(text, fileName) {
  if (text.length <= INLINE_LIMIT) return text;

  const notice = `\n…the full text is attached as \`${fileName}\`.`;
  const head = [];
  let length = notice.length;
  for (const line of text.split("\n")) {
    if (length + line.length + 1 > INLINE_LIMIT) break;
    head.push(line);
    length += line.length + 1;
  }
  return {
    content: `${head.join("\n")}${notice}`,
    files: [{ attachment: Buffer.from(text, "utf8"), name: fileName }],
  };
}
