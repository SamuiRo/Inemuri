import CryptoDataService from "../services/crypto/CryptoDataService.js";
import { loadImage, print } from "../shared/utils.js";
import cronjob_config from "./cronjob.config.json" with { type: "json" };

const cryptoService = new CryptoDataService();

const daily = {
  id: "dailyinfo",
  schedule: "5 0 * * *", // Кожні 6 годин
  //   schedule: "*/5 * * * *", // Кожні 6 годин
  description: "Metrics gathering",
  enabled: true,
  handler: async () => {
    print("[CronJob] Generating daily crypto report...");
    // Отримуємо всі дані паралельно
    const [globalMetrics, btcStat, fearAndGreed] = await Promise.all([
      cryptoService.getGlobalMetrics(),
      cryptoService.findToken("BTC"),
      cryptoService.getFearAndGreedIndex(),
    ]);

    // Перевіряємо чи всі дані отримані
    if (!globalMetrics || !btcStat || !fearAndGreed) {
      print("[CronJob] Failed to fetch all required data", "error");
      return null;
    }

    // Форматуємо повідомлення
    const btcPrice = btcStat.quote.USD.price.toFixed(1);
    const btcChange = btcStat.quote.USD.percent_change_24h.toFixed(1);
    const btcDominance = globalMetrics.btc_dominance.toFixed(1);
    const btcDominanceYesterday =
      globalMetrics.btc_dominance_yesterday.toFixed(1);
    const defiChange = globalMetrics.defi_24h_percentage_change.toFixed(1);

    // Емодзі для BTC зміни
    const btcEmoji = parseFloat(btcChange) >= 0 ? "📈" : "📉";
    const defiEmoji = parseFloat(defiChange) >= 0 ? "🟢" : "🔴";

    const message =
      "**Crypto Daily Metrics**\n" +
      "```java\n" +
      `${btcEmoji} BTC | Price: $${btcPrice} | 24h: ${btcChange}%\n` +
      `BTC.D: ${btcDominance}% | Yesterday: ${btcDominanceYesterday}%\n` +
      `${defiEmoji} DeFi 24h: ${defiChange}%\n` +
      `${fearAndGreed.classification}: ${fearAndGreed.value}/100\n` +
      "```";

    // Завантажуємо картинку для daily звіту
    const image = await loadImage("daily.png");

    const messageData = {
      platform: "cron",
      text: message,
      source: {
        name: "daily-cron",
        destinations: cronjob_config.dailyinfo.destinations,
      },
      metadata: {
        jobId: "daily-crypto-report",
        btcPrice: btcStat.quote.USD.price,
        btcChange: btcStat.quote.USD.percent_change_24h,
        fearAndGreed: fearAndGreed.value,
      },
    };

    if (image) {
      messageData.downloadedMedia = [image];
      // messageData.useEmbed = true; // Discord буде використовувати embed для фото
    }

    print("[CronJob] Daily crypto report generated successfully");
    return messageData;
  },
};

export const CRON_JOBS = [daily];
