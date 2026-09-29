import fs from "fs/promises";
import path from "path";
import { collectGuild } from "./collector.js";
import { formatJson, formatMarkdown, summarize } from "./format.js";
import { looksLikeMissingContentIntent } from "./snapshot.js";
import { DISCORD_EXPORT_DIR } from "../../../../config/app.config.js";
import { print } from "../../../../shared/utils.js";

const FORMATTERS = { md: formatMarkdown, json: formatJson };
// Скільки пропущених каналів перелічувати у відповіді, решту — числом.
const SKIPPED_IN_REPLY = 10;

/**
 * Експорт чатів: збирає знімок серверів, форматує і пише файли в exports/.
 *
 * @param {object} options
 * @param {import("discord.js").Guild[]} options.guilds
 * @param {number} options.limit                 1–100 повідомлень на канал.
 * @param {("md"|"json"|"both")} options.format
 * @param {string} options.label                 Для імені файлу: назва сервера або "all".
 * @returns {Promise<{ snapshot: object, files: { name: string, path: string, data: Buffer }[] }>}
 */
export async function exportChats({ guilds, limit, format, label }) {
  const exportedAt = new Date();
  const snapshot = { exportedAt: exportedAt.toISOString(), limit, guilds: [] };

  for (const guild of guilds) {
    snapshot.guilds.push(await collectGuild(guild, { limit }));
  }

  await fs.mkdir(DISCORD_EXPORT_DIR, { recursive: true });
  const files = [];
  for (const ext of format === "both" ? ["md", "json"] : [format]) {
    const name = exportFileName(label, exportedAt, ext);
    const data = Buffer.from(FORMATTERS[ext](snapshot), "utf8");
    const filePath = path.join(DISCORD_EXPORT_DIR, name);
    await fs.writeFile(filePath, data);
    files.push({ name, path: filePath, data });
  }

  print(`[DISCORDAPP] Export written: ${files.map((file) => file.name).join(", ")}`, "success");
  return { snapshot, files };
}

// ── Чисті помічники ────────────────────────────────────────────────────────

/** `export-<label>-20260929-1402.md` (UTC). */
export function exportFileName(label, date, ext) {
  const slug = String(label)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "server";
  const stamp = date.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `export-${slug}-${stamp}.${ext}`;
}

/**
 * Файли експорту як повідомлення для EventBus → MessageRouter → Telegram.
 * discordapp не звертається до Telegram сам (docs/DISCORDAPP.md D1): це та
 * сама доставка, що й для пересилань, з тими самими логами й помилками.
 * Ліміт Telegram — 2 ГБ, тож стискати не треба. Чиста функція.
 *
 * @param {{ name: string, data: Buffer }[]} files
 * @param {{ chat: string, label: string, summary: string }} options
 */
export function exportDeliveryMessage(files, { chat, label, summary }) {
  return {
    platform: "discordapp",
    text: summary,
    source: { name: `Inemuri export · ${label}`, destinations: { telegram: [chat] } },
    downloadedMedia: files.map((file) => ({
      type: "document",
      data: file.data,
      filename: file.name,
      mimeType: file.name.endsWith(".json") ? "application/json" : "text/markdown",
    })),
    metadata: { source: "discordapp-export" },
  };
}

/** Один рядок для підпису в Telegram: скільки чого. Чиста функція. */
export function exportCaption(snapshot) {
  const stats = summarize(snapshot);
  return `${stats.messages} messages · ${stats.channels} channels` +
    (stats.skipped.length ? ` · ${stats.skipped.length} skipped` : "");
}

/**
 * Текст відповіді команди.
 * @param {object} snapshot
 * @param {{ saved: string[], telegram: (string|null) }} delivery
 *   saved — імена файлів на диску; telegram — чат, куди вони пішли, або null.
 */
export function describeResult(snapshot, { saved, telegram }) {
  const stats = summarize(snapshot);
  const lines = [
    `📦 Exported **${stats.messages}** messages from **${stats.channels}** channels` +
      (stats.guilds > 1 ? ` across ${stats.guilds} servers` : "") + ".",
    `💾 Saved: ${saved.map((name) => `\`exports/${name}\``).join(", ")}`,
  ];

  lines.push(telegram
    ? `📨 Sent to Telegram (${telegram}).`
    : "ℹ️ Set `DISCORD_EXPORT_TELEGRAM_CHAT` to also get the files in Telegram.");
  if (looksLikeMissingContentIntent(snapshot)) {
    lines.push(
      "⚠️ Almost every message came back empty — enable **Message Content Intent** " +
        "for the bot in the Developer Portal, then export again.",
    );
  }
  if (stats.truncatedThreads.length) {
    lines.push(`ℹ️ Older archived threads not exported in ${stats.truncatedThreads.length} channel(s).`);
  }
  if (stats.skipped.length) {
    lines.push(`🚫 Skipped ${stats.skipped.length} channel(s):`);
    for (const item of stats.skipped.slice(0, SKIPPED_IN_REPLY)) {
      lines.push(`- ${stats.guilds > 1 ? `${item.guild} / ` : ""}#${item.channel} — ${item.reason}`);
    }
    if (stats.skipped.length > SKIPPED_IN_REPLY) {
      lines.push(`- …and ${stats.skipped.length - SKIPPED_IN_REPLY} more (listed in the file)`);
    }
  }
  return lines.join("\n");
}
