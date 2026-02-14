import { Command } from "commander";
import database from "./module/teapot/sqlite/sqlite_db.js";
import SourceSeeder from "./module/seeders/Sourceseeder.js";
import { Source } from "./module/teapot/models/index.js";
import { print } from "./shared/utils.js";

const program = new Command();

program
  .name("inemuri-sources")
  .description("CLI для управління джерелами Inemuri")
  .version("1.0.0");

// Seed команда
program
  .command("seed")
  .description("Завантажити джерела з app.config")
  .option("--fresh", "Очистити всі джерела перед seed")
  .action(async (options) => {
    try {
      await database.connect();
      await database.sync();

      const seeder = new SourceSeeder();

      if (options.fresh) {
        await seeder.freshSeed();
      } else {
        await seeder.seed();
      }

      await database.disconnect();
    } catch (error) {
      print(`Error: ${error.message}`, "error");
      process.exit(1);
    }
  });

// List команда
program
  .command("list")
  .description("Показати всі джерела")
  .option(
    "-p, --platform <platform>",
    "Фільтрувати за платформою (telegram/discord)",
  )
  .option("-a, --active-only", "Показати тільки активні")
  .action(async (options) => {
    try {
      await database.connect();

      let sources;
      if (options.platform) {
        sources = options.activeOnly
          ? await Source.getActiveByPlatform(options.platform)
          : await Source.findAll({ where: { platform: options.platform } });
      } else {
        sources = options.activeOnly
          ? await Source.findAll({ where: { is_active: true } })
          : await Source.findAll();
      }

      if (sources.length === 0) {
        print("No sources found");
      } else {
        print(`\nFound ${sources.length} sources:\n`);
        sources.forEach((source) => {
          const status = source.is_active ? "✓" : "✗";
          const filterStatus = source.filters?.enabled ? "[F]" : "";
          print(
            `${status} ${filterStatus} [${source.platform}] ${source.channel_name} (${source.channel_id})`,
          );

          if (source.filters?.enabled) {
            print(
              `    Keywords: ${source.filters.keywords?.join(", ") || "none"}`,
            );
            print(
              `    Blacklist: ${source.filters.blacklist?.join(", ") || "none"}`,
            );
          }

          const dests = source.getAllDestinations();
          if (dests.telegram?.length || dests.discord?.length) {
            print(
              `    Destinations: TG[${dests.telegram?.length || 0}] DC[${dests.discord?.length || 0}]`,
            );
          }
          print("");
        });
      }

      await database.disconnect();
    } catch (error) {
      print(`Error: ${error.message}`, "error");
      process.exit(1);
    }
  });

// Toggle команда
program
  .command("toggle <channelId>")
  .description("Увімкнути/вимкнути джерело")
  .action(async (channelId) => {
    try {
      await database.connect();

      const source = await Source.findOne({
        where: { channel_id: channelId },
      });

      if (!source) {
        print(`Source with channel_id ${channelId} not found`, "error");
        process.exit(1);
      }

      source.is_active = !source.is_active;
      await source.save();

      const status = source.is_active ? "enabled" : "disabled";
      print(`Source "${source.channel_name}" ${status}`, "success");

      await database.disconnect();
    } catch (error) {
      print(`Error: ${error.message}`, "error");
      process.exit(1);
    }
  });

// Clear команда
program
  .command("clear")
  .description("Видалити всі джерела (ОБЕРЕЖНО!)")
  .option("--confirm", "Підтвердження видалення")
  .action(async (options) => {
    if (!options.confirm) {
      print("Use --confirm flag to confirm deletion", "warning");
      process.exit(1);
    }

    try {
      await database.connect();

      const count = await Source.count();
      await Source.destroy({ where: {} });

      print(`Deleted ${count} sources`, "success");

      await database.disconnect();
    } catch (error) {
      print(`Error: ${error.message}`, "error");
      process.exit(1);
    }
  });

program.parse();
