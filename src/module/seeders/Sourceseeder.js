import { print } from "../../shared/utils.js";
import { Source } from "../teapot/models/index.js";
import { SOURCE_CONFIG } from "../../config/app.config.js";

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

    if (!["telegram", "discord"].includes(source.platform)) {
      throw new Error(`Invalid platform: ${source.platform}`);
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
      };

      if (existing) {
        // Оновлюємо існуюче
        await existing.update(data);
        print(`✓ Updated: ${data.channel_name} (${data.platform})`);
        return { action: "updated", source: existing };
      } else {
        // Створюємо нове
        const newSource = await Source.create(data);
        print(`✓ Created: ${data.channel_name} (${data.platform})`, "success");
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
      print(`Found ${sources.length} sources in JSON file`);

      const results = {
        created: 0,
        updated: 0,
        failed: 0,
      };

      for (const sourceData of sources) {
        const result = await this.importSource(sourceData);

        if (result.action === "created") results.created++;
        else if (result.action === "updated") results.updated++;
        else if (result.action === "failed") results.failed++;
      }

      print("=== Seeding Results ===", "success");
      print(`Created: ${results.created}`);
      print(`Updated: ${results.updated}`);
      print(`Failed: ${results.failed}`);
      print("=====================");

      return results;
    } catch (error) {
      print(`Seeding failed: ${error.message}`, "error");
      throw error;
    }
  }

  /**
   * Очистити всі джерела (ОБЕРЕЖНО!)
   */
  async clear() {
    print("Clearing all sources...", "warning");
    await Source.destroy({ where: {} });
    print("All sources cleared", "success");
  }

  /**
   * Seed з очищенням (fresh seed)
   */
  async freshSeed() {
    await this.clear();
    return await this.seed();
  }
}

// Експортуємо клас і готовий інстанс
export default SourceSeeder;

// Для швидкого використання
export const seedSources = () => new SourceSeeder().seed();
export const freshSeedSources = () => new SourceSeeder().freshSeed();
