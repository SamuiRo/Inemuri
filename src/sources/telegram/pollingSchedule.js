/**
 * Розклад полінгу Telegram — чисті функції (README «Polling schedule»).
 *
 * Один таймер на всі джерела: кожен тік бере тих, чий час настав, не більше
 * стелі, найпрострочених першими. Стан (коли кому наступного разу) тримає
 * TelegramSourceListener; тут — лише рішення над ним.
 */

/**
 * Детермінований зсув фази для джерела, у межах [0, everyMs).
 *
 * Без нього джерела з однаковим інтервалом назавжди лишаються синхронними:
 * «раз на добу» для шести каналів — шість запитів в одну секунду щодоби.
 * Зсув від id, а не від Math.random, — розклад відтворюється після рестарту.
 *
 * @param {number|string} sourceId
 * @param {number} everyMs
 */
export function phaseOffsetMs(sourceId, everyMs) {
  if (!Number.isFinite(everyMs) || everyMs <= 0) return 0;
  // FNV-1a над рядком id: дешево, без залежностей, добре розсіює малі числа.
  let hash = 0x811c9dc5;
  for (const ch of String(sourceId)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % Math.floor(everyMs);
}

/**
 * Джерела, чий час настав: найдовше очікувані першими, не більше `max`.
 * Інакше джерело з коротким інтервалом могло б вічно витісняти те, що
 * чекає з минулого тіку.
 *
 * @param {Map<number, number>} dueAt  sourceId → коли опитувати (мс)
 * @param {number} now
 * @param {number} max
 * @returns {number[]}
 */
export function dueSources(dueAt, now, max) {
  const due = [];
  for (const [sourceId, at] of dueAt) if (at <= now) due.push([sourceId, at]);
  due.sort((a, b) => a[1] - b[1]);
  return due.slice(0, max).map(([sourceId]) => sourceId);
}

/**
 * Наступний час опитування. Зсув фази додається один раз — при першому
 * переплануванні; далі він «вшитий» у dueAt, і інтервал лишається рівним.
 *
 * @param {{ sourceId: number|string, now: number, everyMs: number, phased: boolean }} input
 */
export function nextDueAt({ sourceId, now, everyMs, phased }) {
  return now + (phased ? everyMs : everyMs + phaseOffsetMs(sourceId, everyMs));
}
