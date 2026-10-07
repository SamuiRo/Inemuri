/**
 * Щоденний крипто-звіт — задача CronScheduler і команда /daily.
 *
 * Розділено як скрізь у проєкті: чисті функції (`dropsInfo`,
 * `formatDailyReport`) рахують і форматують, `createDailyJob` збирає задачу з
 * переданих залежностей (джерело даних, картинка, призначення). Розклад і
 * призначення — з конфігу, не звідси.
 */

/** Щотижневі дропи ігор: день тижня (0 = неділя) і час. Факт про ігри, не налаштування розгортання. */
export const GAME_DROPS = Object.freeze([
  { name: "CS2", dayOfWeek: 3, timeKyiv: "~03:00", timeGMT: "~01:00" },
  { name: "TF2", dayOfWeek: 4, timeKyiv: "~03:00", timeGMT: "~01:00" },
]);

/**
 * Коли наступний дроп кожної гри відносно `now`.
 * @param {Date} now
 * @param {typeof GAME_DROPS} [drops]
 * @returns {{ game: string, status: string, timeKyiv: string, timeGMT: string }[]}
 */
export function dropsInfo(now, drops = GAME_DROPS) {
  const today = now.getDay();
  return drops.map((g) => {
    const days = (g.dayOfWeek - today + 7) % 7;
    const status = days === 0 ? "Сьогодні" : days === 1 ? "Завтра" : `in ${days} days`;
    return { game: g.name, status, timeKyiv: g.timeKyiv, timeGMT: g.timeGMT };
  });
}

/**
 * Текст звіту. null — якщо бракує даних (звіт без них не має сенсу).
 * @param {{ globalMetrics: object, btcStat: object, fearAndGreed: object, drops?: object[] }} data
 */
export function formatDailyReport({ globalMetrics, btcStat, fearAndGreed, drops = [] }) {
  if (!globalMetrics || !btcStat || !fearAndGreed) return null;

  const usd = btcStat.quote.USD;
  const btcChange = usd.percent_change_24h.toFixed(1);
  const defiChange = globalMetrics.defi_24h_percentage_change.toFixed(1);
  const btcEmoji = parseFloat(btcChange) >= 0 ? "📈" : "📉";
  const defiEmoji = parseFloat(defiChange) >= 0 ? "🟢" : "🔴";

  let dropsBlock = "";
  if (drops.length > 0) {
    const rows = drops.map((d) => `${d.game.padEnd(4)} | ${d.status.padEnd(13)} | ${d.timeKyiv.padEnd(9)} | ${d.timeGMT}`);
    dropsBlock = "\n\n**Weekly Drops**\n```\n" +
      "Game | Status        | Kyiv      | GMT\n" +
      "-----+---------------+-----------+-------------\n" +
      rows.join("\n") + "\n```";
  }

  return "**Crypto Daily Metrics**\n```\n" +
    `${btcEmoji} BTC | Price: $${usd.price.toFixed(1)} | 24h: ${btcChange}%\n` +
    `BTC.D: ${globalMetrics.btc_dominance.toFixed(1)}% | Yesterday: ${globalMetrics.btc_dominance_yesterday.toFixed(1)}%\n` +
    `${defiEmoji} DeFi 24h: ${defiChange}%\n` +
    `${fearAndGreed.classification}: ${fearAndGreed.value}/100\n` +
    "```" + dropsBlock;
}

/**
 * Задача для CronScheduler.
 * @param {{ crypto: { getGlobalMetrics, findToken, getFearAndGreedIndex },
 *           loadImage: (name: string) => Promise<object|null>,
 *           destinations: object, schedule: string, enabled?: boolean,
 *           now?: () => Date, log?: (msg: string, level?: string) => void }} deps
 */
export function createDailyJob({ crypto, loadImage, destinations, schedule, enabled = true, now = () => new Date(), log = () => {} }) {
  return {
    id: "dailyinfo",
    schedule,
    description: "Daily crypto report",
    enabled,
    handler: async () => {
      log("[CronJob] Generating daily crypto report...");
      const [globalMetrics, btcStat, fearAndGreed] = await Promise.all([
        crypto.getGlobalMetrics(),
        crypto.findToken("BTC"),
        crypto.getFearAndGreedIndex(),
      ]);
      const text = formatDailyReport({ globalMetrics, btcStat, fearAndGreed, drops: dropsInfo(now()) });
      if (!text) {
        log("[CronJob] Failed to fetch all required data", "error");
        return null;
      }
      const messageData = {
        platform: "cron",
        text,
        source: { name: "", destinations },
        metadata: {
          jobId: "daily-crypto-report",
          btcPrice: btcStat.quote.USD.price,
          btcChange: btcStat.quote.USD.percent_change_24h,
          fearAndGreed: fearAndGreed.value,
        },
      };
      const image = await loadImage("daily.png");
      if (image) messageData.downloadedMedia = [image];
      log("[CronJob] Daily crypto report generated successfully");
      return messageData;
    },
  };
}
