import { print } from "../../shared/utils.js";
import { Source } from "../teapot/models/index.js";
import { SOURCE_CONFIG } from "../../config/app.config.js";
import { DISCOVERY_KINDS } from "../../sources/feeds/discovery.js";

const VALID_MODES = ["listener", "polling", "both"];
// reddit / rss — стрічки (ROADMAP §7): channel_id — сабреддит ("r/cs2") або
// URL стрічки; `mode` для них не має сенсу, вони завжди опитуються.
const SOURCE_PLATFORMS = ["telegram", "discord", "reddit", "rss"];
const FEED_PLATFORMS = new Set(["reddit", "rss"]);

// Дефолт колонки Source.flow. Тримаємо синхронним з моделлю (Source.js)
// і docs/theflow/DATA_MODEL.md.
const FLOW_DEFAULT = {
  enabled: false,
  topics: null,
  min_confidence: 0.6,
  dedup_window_hours: null,
  vision: { enabled: false, text_threshold: 200, max_images_per_post: 2 },
};

/**
 * Зливає частковий flow-конфіг із sources.json з дефолтами, щоб у БД
 * завжди лежав повний об'єкт. flow керується декларативно через sources.json.
 */
/**
 * Інтервал полінгу з конфігу. Усе, що не додатне число, стає NULL —
 * тобто «як усі». Нуль у колонці означав би due кожен тік.
 */
function normalizePollInterval(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Додаткові типи медіа. Порожнє / не масив -> NULL («лише глобальні»).
 * Значення не валідуємо проти списку відомих типів навмисно: невідомий тип
 * просто ніколи не збігається з media.type, тобто нічого не ламає, а жорстка
 * перевірка зламала б сід при додаванні нового типу в парсер.
 */
function normalizeExtraMediaTypes(raw) {
  if (!Array.isArray(raw)) return null;
  const cleaned = [...new Set(raw.filter((t) => typeof t === "string" && t.trim() !== ""))];
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Налаштування стрічки (NEWS_INTAKE.md §2.1–2.2). Лише для rss; типові
 * значення (discovery rss, без triage) не зберігаються — NULL означає те саме.
 */
function normalizeFeed(platform, feed) {
  if (platform !== "rss" || !feed || typeof feed !== "object") return null;
  const out = {};
  if (feed.discovery && feed.discovery !== "rss") out.discovery = feed.discovery;
  if (feed.triage === true) out.triage = true;
  return Object.keys(out).length ? out : null;
}

function mergeFlow(flow) {
  if (!flow || typeof flow !== "object") return { ...FLOW_DEFAULT };
  return {
    ...FLOW_DEFAULT,
    ...flow,
    vision: { ...FLOW_DEFAULT.vision, ...(flow.vision || {}) },
  };
}

class SourceSeeder {
  /**
   * Валідація одного джерела
   */
  validateSource(source) {
    const required = ["platform", "channel_id", "channel_name"];

    for (const field of required) {
      if (!source[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    if (!SOURCE_PLATFORMS.includes(source.platform)) {
      throw new Error(`Invalid platform: ${source.platform} (expected ${SOURCE_PLATFORMS.join(" / ")})`);
    }
    // Discord: id каналу, не сервера і не посилання. Інше ніколи не збіглося б
    // з channelId повідомлення — джерело мовчало б без жодної помилки.
    if (source.platform === "discord" && !/^\d{17,20}$/.test(String(source.channel_id))) {
      throw new Error(`discord source "${source.channel_name}": channel_id must be the channel id (17–20 digits)`);
    }
    if (source.platform === "rss" && !/^https?:\/\//i.test(String(source.channel_id))) {
      throw new Error(`rss source "${source.channel_name}": channel_id must be the feed, sitemap or site URL`);
    }
    const discovery = source.feed?.discovery;
    if (discovery !== undefined && !DISCOVERY_KINDS.includes(discovery)) {
      throw new Error(`source "${source.channel_name}": feed.discovery must be one of ${DISCOVERY_KINDS.join(" / ")}`);
    }
    // Triage пропускає статті в TheFlow — без нього пропускати нікуди.
    if (source.feed?.triage === true && source.flow?.enabled !== true) {
      throw new Error(`source "${source.channel_name}": feed.triage needs flow.enabled`);
    }

    if (source.mode && !VALID_MODES.includes(source.mode)) {
      throw new Error(
        `Invalid mode: "${source.mode}". Must be one of: ${VALID_MODES.join(", ")}`,
      );
    }

    return true;
  }

  /**
   * Імпорт одного джерела
   */
  async importSource(sourceData) {
    try {
      this.validateSource(sourceData);

      // Перевіряємо чи вже існує
      const existing = await Source.findOne({
        where: {
          platform: sourceData.platform,
          channel_id: String(sourceData.channel_id),
        },
      });

      const data = {
        platform: sourceData.platform,
        channel_id: String(sourceData.channel_id),
        channel_name: sourceData.channel_name,
        is_active: sourceData.is_active ?? true,
        // Якщо mode не вказано — залишаємо дефолт 'listener'; стрічки
        // лише опитуються, тож для них — 'polling'; Discord лише слухає.
        mode: FEED_PLATFORMS.has(sourceData.platform) ? "polling"
          : sourceData.platform === "discord" ? "listener"
            : (sourceData.mode ?? "listener"),
        // NULL = глобальний POLLING_INTERVAL_MIN (див. Source.getPollIntervalMin)
        poll_interval_min: normalizePollInterval(sourceData.poll_interval_min),
        // NULL = лише глобальний DOWNLOADABLE_MEDIA_TYPES
        extra_media_types: normalizeExtraMediaTypes(sourceData.extra_media_types),
        // NULL = звичайна RSS/Atom
        feed: normalizeFeed(sourceData.platform, sourceData.feed),
        text_replacements: sourceData.text_replacements || {
          enabled: false,
          patterns: [],
        },
        filters: sourceData.filters || {
          enabled: false,
          keywords: [],
          blacklist: [],
          case_sensitive: false,
        },
        destinations: sourceData.destinations || {
          telegram: [],
          discord: [],
        },
        flow: mergeFlow(sourceData.flow),
      };

      if (existing) {
        await existing.update(data);
        print(`✓ Updated: ${data.channel_name} (${data.platform}) [mode: ${data.mode}]`);
        return { action: "updated", source: existing };
      } else {
        const newSource = await Source.create(data);
        print(`✓ Created: ${data.channel_name} (${data.platform}) [mode: ${data.mode}]`, "success");
        return { action: "created", source: newSource };
      }
    } catch (error) {
      print(
        `✗ Failed to import ${sourceData.channel_name}: ${error.message}`,
        "error",
      );
      return { action: "failed", error: error.message };
    }
  }

  /**
   * Імпорт всіх джерел
   */
  async seed() {
    try {
      print("Starting sources seeding...");

      const sources = SOURCE_CONFIG.sources;
      print(`Found ${sources.length} sources in config`);

      const results = { created: 0, updated: 0, failed: 0 };

      for (const sourceData of sources) {
        const result = await this.importSource(sourceData);
        if (result.action === "created") results.created++;
        else if (result.action === "updated") results.updated++;
        else if (result.action === "failed") results.failed++;
      }

      print("=== Seeding Results ===", "success");
      print(`Created: ${results.created}`);
      print(`Updated: ${results.updated}`);
      print(`Failed:  ${results.failed}`);
      print("=====================");

      return results;
    } catch (error) {
      print(`Seeding failed: ${error.message}`, "error");
      throw error;
    }
  }

  async clear() {
    print("Clearing all sources...", "warning");
    await Source.destroy({ where: {} });
    print("All sources cleared", "success");
  }

  async freshSeed() {
    await this.clear();
    return await this.seed();
  }
}

export default SourceSeeder;

export const seedSources = () => new SourceSeeder().seed();
export const freshSeedSources = () => new SourceSeeder().freshSeed();
