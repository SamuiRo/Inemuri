/**
 * Призначення доставки — `{ telegram: [ids], discord: [ids] }`. Чисті функції.
 *
 * Спільні для всіх, хто читає призначення з конфігу: resolve TheFlow,
 * статус-борд, нагляд, дайджест. Окремо від ResolveStage, щоб модуль поза
 * TheFlow (статус-борд) не імпортував стадію TheFlow заради копії об'єкта.
 */

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** Копія призначень: викликач не має отримати посилання всередину конфігу. Порожні id відкидаються. */
export function copyDestinations(d) {
  const out = {};
  for (const [platform, ids] of Object.entries(d ?? {})) {
    const list = asArray(ids).map(String).filter((id) => id.trim() !== "");
    if (list.length) out[platform] = list;
  }
  return out;
}

const DISCORD_ID = /^[0-9]{17,20}$/;
const TELEGRAM_CHAT_ID = /^-?[0-9]+$/;
const TELEGRAM_USERNAME = /^@[A-Za-z0-9_]{4,}$/;

/**
 * Ідентифікатори, які платформа точно не прийме: Discord — лише snowflake,
 * Telegram — числовий chat id або @username. Ловить заглушки на кшталт
 * "TODO:claims", що лишились у routing.json до створення каналу: інакше
 * доставка мовчки не дійшла б нікуди.
 *
 * @param {object} destinations
 * @param {string} at  Де в конфігу (для тексту проблеми).
 * @returns {string[]}
 */
export function destinationIdProblems(destinations, at) {
  const problems = [];
  for (const [platform, ids] of Object.entries(copyDestinations(destinations))) {
    for (const id of ids) {
      const ok = platform === "discord" ? DISCORD_ID.test(id)
        : platform === "telegram" ? TELEGRAM_CHAT_ID.test(id) || TELEGRAM_USERNAME.test(id)
          : true;
      if (!ok) problems.push(`${at}.${platform} "${id}" is not a valid ${platform} id`);
    }
  }
  return problems;
}
