/**
 * Переїзд у instance/ (v4.67.0): чисті частини `npm run instance:init`.
 *
 * Конфіг сервера до v4.67.0 посилався на тексти відносно спільної теки
 * messages/: "plane-of-euthymia/welcome.md". Тепер тексти лежать поруч із
 * server.json, тож посилання — відносно теки сервера: "welcome.md".
 */

/** Усі значення ключів `file` і `avatar` у конфігу сервера (будь-яка глибина). */
export function referencedFiles(raw) {
  const out = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === "file" || k === "avatar") && typeof x === "string") out.add(x);
      else walk(x);
    }
  };
  walk(raw);
  return [...out];
}

/** Куди в теці сервера лягає файл, на який було посилання `ref`. */
export function targetPath(ref, serverName) {
  const prefix = `${serverName}/`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

/**
 * Текст server.json з посиланнями відносно теки сервера. Правиться текст, а
 * не JSON.stringify: конфіг оформлений вручну (канал — рядок), і переформатування
 * зіпсувало б його.
 *
 * @param {string} text  вміст старого servers/<name>.json
 * @param {string} serverName
 */
export function rewriteRefs(text, serverName) {
  let out = text;
  for (const key of ["file", "avatar"]) {
    out = out.split(`"${key}": "${serverName}/`).join(`"${key}": "`);
    out = out.split(`"${key}":"${serverName}/`).join(`"${key}":"`);
  }
  return out;
}
