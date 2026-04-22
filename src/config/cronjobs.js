import CryptoDataService from "../services/crypto/CryptoDataService.js";
import { loadImage, print } from "../shared/utils.js";
import cronjob_config from "./cronjob.config.json" with { type: "json" };

const cryptoService = new CryptoDataService();

// Конфігурація дропів для ігор
const GAME_DROPS = {
  CS2: {
    name: "CS2",
    dayOfWeek: 3, // середа (0 = неділя, 3 = середа)
    timeKyiv: "~03:00",
    timeGMT: "~01:00",
  },
  TF2: {
    name: "TF2",
    dayOfWeek: 4, // четвер
    timeKyiv: "~03:00",
    timeGMT: "~01:00",
  },
};

/**
 * Розраховує інформацію про дропи для поточного дня
 */
function getDropsInfo() {
  const now = new Date();
  const currentDay = now.getDay(); // 0 = неділя, 1 = понеділок, ..., 6 = субота
  
  const drops = [];
  
  for (const [gameKey, gameInfo] of Object.entries(GAME_DROPS)) {
    let daysUntilDrop;
    
    if (currentDay === gameInfo.dayOfWeek) {
      // Сьогодні дроп
      drops.push({
        game: gameInfo.name,
        status: "Сьогодні",
        timeKyiv: gameInfo.timeKyiv,
        timeGMT: gameInfo.timeGMT,
      });
    } else {
      // Розраховуємо скільки днів до дропу
      daysUntilDrop = (gameInfo.dayOfWeek - currentDay + 7) % 7;
      
      if (daysUntilDrop === 0) {
        daysUntilDrop = 7; // Якщо дроп був сьогодні, то наступний через 7 днів
      }
      
      const statusText = daysUntilDrop === 1 ? "Завтра" : `in ${daysUntilDrop} days`;
      
      drops.push({
        game: gameInfo.name,
        status: statusText,
        timeKyiv: gameInfo.timeKyiv,
        timeGMT: gameInfo.timeGMT,
      });
    }
  }
  
  return drops;
}

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

    // Отримуємо інформацію про дропи
    const dropsInfo = getDropsInfo();
    
    // Форматуємо таблицю дропів
    let dropsBlock = "";
    if (dropsInfo.length > 0) {
      dropsBlock = "\n\n**Weekly Drops**\n```\n";
      dropsBlock += "Game | Status        | Kyiv      | GMT\n";
      dropsBlock += "-----+---------------+-----------+-------------\n";
      
      dropsInfo.forEach((drop) => {
        const game = drop.game.padEnd(4);
        const status = drop.status.padEnd(13);
        const kyiv = drop.timeKyiv.padEnd(9);
        const gmt = drop.timeGMT;
        dropsBlock += `${game} | ${status} | ${kyiv} | ${gmt}\n`;
      });
      
      dropsBlock += "```";
    }

    const message =
      "**Crypto Daily Metrics**\n" +
      "```\n" +
      `${btcEmoji} BTC | Price: $${btcPrice} | 24h: ${btcChange}%\n` +
      `BTC.D: ${btcDominance}% | Yesterday: ${btcDominanceYesterday}%\n` +
      `${defiEmoji} DeFi 24h: ${defiChange}%\n` +
      `${fearAndGreed.classification}: ${fearAndGreed.value}/100\n` +
      "```" +
      dropsBlock;

    // Завантажуємо картинку для daily звіту
    const image = await loadImage("daily.png");

    const messageData = {
      platform: "cron",
      text: message,
      source: {
        name: "",
        destinations: cronjob_config.dailyinfo.destinations,
      },
      useEmbed: true,
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

/**
 * Discord команди для ручного запуску cronjobs
 */
export const COMMANDS = [
  {
    name: "daily",
    description: "Manually trigger daily crypto report",
    handler: async (interaction, eventBus) => {
      try {
        print("[Command] Executing daily report...");
        
        // Викликаємо handler з daily cronjob
        const messageData = await daily.handler();
        
        if (!messageData) {
          return {
            success: false,
            message: "❌ Failed to generate daily report. Check logs for details.",
          };
        }

        // Відправляємо повідомлення через eventBus
        eventBus.emitMessageReceived({
          ...messageData,
          metadata: {
            ...messageData.metadata,
            source: "discord-command",
            commandName: "daily",
            triggeredBy: interaction.user.tag,
            timestamp: new Date().toISOString(),
          },
        });

        print("[Command] Daily report message emitted to EventBus");

        return {
          success: true,
          message: "✅ Daily report generated and sent successfully!",
        };
      } catch (error) {
        print(`[Command] Error executing daily: ${error.message}`, "error");
        return {
          success: false,
          message: `❌ Error: ${error.message}`,
        };
      }
    },
  },
];