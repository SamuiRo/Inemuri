/**
 * TheFlow Phase 0 — бекфіл перцептивного хешу зображень.
 *
 * Навіщо окремо: інваріант TheFlow — ingestion НЕ робить вихідних мережевих
 * викликів (інакше update-loop Telegram стопориться під бурстом). Перцептивний
 * хеш потребує байтів зображення → downloadMedia → мережа. Тому image_hash
 * лишається null при ingest, а рахується цим проходом поза гарячим шляхом.
 *
 * Ідемпотентний і резюмований: бере лише posts, де has_media = true й
 * image_hash IS NULL. Rate-limited між повідомленнями.
 *
 *   NODE_ENV=production node scripts/backfill-image-hash.js [--limit N] [--dry]
 *
 * ⚠️ Не протестовано на живих даних: у фазі 0 таблиця posts порожня, поки
 * жодне джерело не має flow.enabled, і для запуску потрібна Telegram-сесія.
 * Код йде за наявними патернами (TelegramMediaDownloader), але прогнати його
 * треба щойно з'явиться перше flow-джерело.
 */

import sharp from "sharp";
import { Op } from "sequelize";

import { print, sleep } from "../src/shared/utils.js";
import { NODE_ENV, POLLING_CHANNEL_DELAY_MS } from "../src/config/app.config.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import telegramClient from "../src/module/telegram/TelegramClient.js";
import { Post } from "../src/module/teapot/models/index.js";

const BATCH = 200;

function parseArgs(argv) {
  const out = { limit: Infinity, dry: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dry") out.dry = true;
    else if (argv[i] === "--limit") out.limit = Number(argv[++i]);
  }
  return out;
}

/**
 * dHash: 9×8 grayscale → порівняння сусідніх пікселів у рядку → 64 біти → hex.
 * Стійкий до масштабування й легкого стиснення — саме те, що треба для
 * «той самий скріншот у п'яти каналах».
 */
async function dhash(buffer) {
  const w = 9, h = 8;
  const px = await sharp(buffer)
    .greyscale()
    .resize(w, h, { fit: "fill" })
    .raw()
    .toBuffer();

  let bits = "";
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w - 1; col++) {
      const left = px[row * w + col];
      const right = px[row * w + col + 1];
      bits += left < right ? "1" : "0";
    }
  }
  // 64 біти → 16 hex
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

async function main() {
  const { limit, dry } = parseArgs(process.argv);
  print(`image_hash backfill — start${dry ? " (dry run)" : ""}`, "system");

  if (NODE_ENV === "development") {
    print("Refusing to run with NODE_ENV=development. Use production.", "error");
    process.exit(1);
  }

  await database.connect();

  const total = await Post.count({
    where: { has_media: true, image_hash: { [Op.is]: null } },
  });
  print(`Candidates (has_media, image_hash IS NULL): ${total}`, "info");
  if (total === 0) {
    await database.disconnect();
    print("Nothing to backfill.", "success");
    return;
  }

  const client = await telegramClient.connect();

  let done = 0, hashed = 0, skipped = 0, failed = 0;
  while (done < Math.min(total, limit)) {
    const rows = await Post.findAll({
      where: { has_media: true, image_hash: { [Op.is]: null } },
      order: [["id", "ASC"]],
      limit: Math.min(BATCH, limit - done),
    });
    if (rows.length === 0) break;

    for (const post of rows) {
      done++;
      try {
        // Медіа дістаємо через media_ref (міграція 002), не через legacy
        // channel_id/message_id. Для telegram-рефа це ті самі поля.
        const ref = post.media_ref;
        if (!ref || ref.kind !== "telegram") {
          print(`posts#${post.id}: no telegram media_ref, skipping`, "debug");
          skipped++;
          continue;
        }
        const [msg] = await client.getMessages(ref.channel_id, {
          ids: [ref.message_id],
        });
        if (!msg || !msg.media) { skipped++; continue; }

        // Найменший доступний thumbnail — дешево і достатньо для dHash.
        const buffer = await client.downloadMedia(msg, { thumb: 0 });
        if (!buffer || buffer.length === 0) { skipped++; continue; }

        const hash = await dhash(buffer);
        if (!dry) {
          post.image_hash = hash;
          await post.save();
        }
        hashed++;
        print(`posts#${post.id} ${ref.channel_id}/${ref.message_id} → ${hash}`, "debug");
      } catch (error) {
        failed++;
        print(`posts#${post.id}: ${error.message}`, "error");
      }
      await sleep(POLLING_CHANNEL_DELAY_MS);
    }
  }

  await telegramClient.disconnect();
  await database.disconnect();

  print(
    `Backfill done — processed ${done}, hashed ${hashed}, skipped ${skipped}, failed ${failed}`,
    failed ? "warning" : "success",
  );
}

main().catch(async (err) => {
  print(`Backfill error: ${err.message}`, "error");
  console.error(err);
  try { await telegramClient.disconnect(); } catch { /* noop */ }
  try { await database.disconnect(); } catch { /* noop */ }
  process.exit(1);
});
