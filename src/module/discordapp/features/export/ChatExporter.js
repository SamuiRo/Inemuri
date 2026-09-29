import fs from "fs/promises";
import path from "path";
import { gzipSync } from "zlib";
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
 * Які файли їдуть у Discord і в якому вигляді: як є, якщо влазять у ліміт;
 * стиснуті gzip, якщо влазять лише так; інакше — лишаються тільки на диску.
 *
 * @param {{ name: string, data: Buffer }[]} files
 * @param {number} limitBytes
 * @returns {{ attachments: { name: string, data: Buffer }[], tooLarge: string[] }}
 */
export function prepareAttachments(files, limitBytes) {
  const attachments = [];
  const tooLarge = [];
  for (const file of files) {
    if (file.data.length <= limitBytes) {
      attachments.push({ name: file.name, data: file.data });
      continue;
    }
    const gz = gzipSync(file.data);
    if (gz.length <= limitBytes) attachments.push({ name: `${file.name}.gz`, data: gz });
    else tooLarge.push(file.name);
  }
  return { attachments, tooLarge };
}

/**
 * Текст відповіді команди.
 * @param {object} snapshot
 * @param {{ saved: string[], tooLarge: string[] }} files  Імена файлів.
 */
export function describeResult(snapshot, { saved, tooLarge }) {
  const stats = summarize(snapshot);
  const lines = [
    `📦 Exported **${stats.messages}** messages from **${stats.channels}** channels` +
      (stats.guilds > 1 ? ` across ${stats.guilds} servers` : "") + ".",
    `💾 Saved: ${saved.map((name) => `\`exports/${name}\``).join(", ")}`,
  ];

  if (tooLarge.length) {
    lines.push(`⚠️ Too large to attach even gzipped, kept on disk only: ${tooLarge.join(", ")}`);
  }
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
