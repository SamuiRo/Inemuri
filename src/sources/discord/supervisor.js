/**
 * Нагляд за дочірнім процесом джерела Discord (docs/DISCORD_SOURCE.md).
 * Чисті функції: рішення окремо від таймерів і процесів (DiscordSelfSource).
 */

/** Код виходу дочірнього процесу, після якого перезапуск не допоможе. */
export const FATAL_EXIT_CODE = 2;

/**
 * Коди закриття gateway, на які повтор не допоможе: 4004 — токен не прийнято,
 * 4010–4014 — помилки шардів, версії API й intents. Решту бібліотека
 * перепідключає сама.
 */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export function isFatalCloseCode(code) {
  return FATAL_CLOSE_CODES.has(Number(code));
}

/**
 * Пауза перед n-м перезапуском поспіль: base, 2·base, 4·base… не більше cap.
 * Лічильник скидається на READY, тож разове падіння коштує base.
 */
export function restartDelayMs(attempt, { restartBaseMs, restartCapMs }) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  return Math.min(restartBaseMs * 2 ** (n - 1), restartCapMs);
}

/**
 * Чи перезапускати дочірній процес за його звітом. Метрика — RSS: heapUsed /
 * heapTotal у V8 майже завжди високий і нічого не означає (CloakCord ISSUES F5).
 *
 * @param {{ rssMb: number }} stats
 * @param {{ maxRssMb: number }} limits
 * @returns {{ restart: boolean, reason: string|null }}
 */
export function assessStats(stats, { maxRssMb }) {
  const rss = Number(stats?.rssMb);
  if (Number.isFinite(rss) && rss > maxRssMb) {
    return { restart: true, reason: `RSS ${rss.toFixed(0)} MB > ${maxRssMb} MB` };
  }
  return { restart: false, reason: null };
}

/**
 * Рядок статистики, як [MEMSTAT] у CloakCord: пам'ять, кеші (members і users
 * мають лишатися малими — це показник, що ліміти кешу діють), лічильники.
 *
 *   seen     — повідомлення з відстежуваних каналів (до фільтра);
 *   matched  — пройшли фільтр (класика) або записані в TheFlow;
 *   watched  — скільки налаштованих каналів акаунт бачить (visible/total).
 */
export function formatStats(stats, counters) {
  const mb = (v) => `${Number(v ?? 0).toFixed(0)}MB`;
  return [
    `uptime=${Math.round(Number(stats.uptimeMin ?? 0))}m rss=${mb(stats.rssMb)} heap=${mb(stats.heapMb)}`,
    `guilds=${stats.guilds ?? 0} channels=${stats.channels ?? 0} members=${stats.members ?? 0} users=${stats.users ?? 0}`,
    `events=${stats.events ?? 0} watched=${stats.visible ?? 0}/${stats.watched ?? 0} seen=${stats.seen ?? 0}`,
    `matched=${counters.matched} ingested=${counters.ingested} errors=${counters.errors}`,
  ].join(" | ");
}

/**
 * Порівняння основного транспорту з тіньовим за id побачених повідомлень.
 * Рахуються лише ті, що старші за `settleMs` (інший міг ще не встигнути);
 * пораховані повертаються в `done`, щоб викликач їх забув.
 *
 * @param {Map<string, number>} primary  id → коли побачив основний (мс).
 * @param {Map<string, number>} shadow   id → коли побачив тіньовий.
 * @returns {{ both: number, onlyPrimary: number, onlyShadow: number, done: string[] }}
 */
export function compareSeen(primary, shadow, { now, settleMs }) {
  const cutoff = now - settleMs;
  const result = { both: 0, onlyPrimary: 0, onlyShadow: 0, done: [] };
  for (const [id, at] of primary) {
    const other = shadow.get(id);
    if (Math.max(at, other ?? 0) > cutoff) continue;
    if (other != null) result.both++;
    else result.onlyPrimary++;
    result.done.push(id);
  }
  for (const [id, at] of shadow) {
    if (primary.has(id) || at > cutoff) continue;
    result.onlyShadow++;
    result.done.push(id);
  }
  return result;
}

/**
 * Попередження про канали, яких акаунт не бачить (вийшов із сервера, втратив
 * доступ, хибний id). null — бачить усі.
 *
 * @param {string[]} missing  id каналів, яких немає в кеші клієнта.
 * @param {(id: string) => string} nameOf
 */
export function describeMissing(missing, nameOf) {
  if (!Array.isArray(missing) || missing.length === 0) return null;
  const names = missing.slice(0, 10).map((id) => `${nameOf(id)} (${id})`);
  const more = missing.length > names.length ? ` and ${missing.length - names.length} more` : "";
  return `${missing.length} channel(s) not visible to the account — left the server, lost access or a wrong id: ${names.join(", ")}${more}`;
}
