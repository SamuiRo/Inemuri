/**
 * TheFlow — one-pass volume estimate (ROADMAP §2.1).
 *
 * Answers "how much traffic will reach the AI" from data that already exists:
 * no waiting, no second snapshot, no TheFlow running.
 *
 * For each active Telegram source:
 *   - read the current last message id from Telegram (getMessages, limit 1);
 *   - diff it against that source's `source_states.last_message_id`;
 *   - divide by the days since that row's own `updatedAt` (per-row baseline —
 *     the rows were written on different dates, a shared denominator would
 *     understate the busy channels and overstate the quiet ones);
 *   - print messages/day per channel plus the total, then × 2 requests/post.
 *
 * Listener-mode sources have no `source_states` row, so they produce no
 * estimate here. Pass --save-baselines to record their current id now as a
 * fresh baseline and re-run in a few days; otherwise treat the polling
 * sources as a representative sample (they include the three busiest
 * channels).
 *
 * The figure counts every message in the channel — deleted and service
 * messages included — so it is an upper bound, which is the right direction
 * to be wrong in when sizing a provider tier.
 *
 *   node scripts/estimate-volume.js
 *   node scripts/estimate-volume.js --save-baselines
 *
 * Requires a valid TELEGRAM_SESSION in .env (connects as the user account,
 * exactly like `npm start`).
 */

import { print, sleep } from "../src/shared/utils.js";
import { POLLING_CHANNEL_DELAY_MS } from "../src/config/app.config.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import telegramClient from "../src/module/telegram/TelegramClient.js";
import { Source, SourceState } from "../src/module/teapot/models/index.js";

const SAVE_BASELINES = process.argv.includes("--save-baselines");
const DAY_MS = 24 * 60 * 60 * 1000;

// A channel whose cursor has barely moved, or whose baseline is very old,
// is either dead or has broken polling — flagged, and left out of the total.
const STALE_PER_DAY = 0.5;
const STALE_DAYS = 45;

function pad(value, width) {
  return String(value).padStart(width);
}

async function main() {
  print("TheFlow volume estimate — start", "system");

  await database.connect();
  await telegramClient.connect();
  const client = telegramClient.getClient();

  const sources = await Source.findAll({
    where: { platform: "telegram", is_active: true },
    order: [["id", "ASC"]],
  });
  print(`${sources.length} active telegram source(s)`, "info");

  const rows = [];
  let isFirst = true;

  for (const source of sources) {
    // Same fixed pause between channels as the polling hot path. This is a
    // script, not a hot path, but there is no reason to spike requests.
    if (!isFirst) await sleep(POLLING_CHANNEL_DELAY_MS);
    isFirst = false;

    let currentId = null;
    try {
      const messages = await client.getMessages(source.channel_id, { limit: 1 });
      currentId = messages?.[0]?.id ?? null;
    } catch (error) {
      print(`  ${source.channel_name}: getMessages failed — ${error.message}`, "error");
      rows.push({ source, error: error.message });
      continue;
    }

    const state = await SourceState.findOne({ where: { source_id: source.id } });
    const baselineId = state?.last_message_id ?? null;
    const baselineAt = state ? new Date(state.updatedAt) : null;

    if (baselineId === null || baselineAt === null) {
      if (SAVE_BASELINES && currentId !== null) {
        const target = state ?? (await SourceState.getOrCreate(source.id));
        await target.setBaseline(currentId);
        print(
          `  ${source.channel_name}: baseline recorded at id=${currentId} — re-run in a few days`,
          "warning",
        );
      } else {
        print(
          `  ${source.channel_name}: no baseline (current id=${currentId}); pass --save-baselines to record`,
          "warning",
        );
      }
      rows.push({ source, currentId, baselineId: null });
      continue;
    }

    const days = (Date.now() - baselineAt.getTime()) / DAY_MS;
    const delta = currentId - baselineId;
    const perDay = days > 0 ? delta / days : null;
    rows.push({ source, currentId, baselineId, baselineAt, days, delta, perDay });
  }

  // ── Report ────────────────────────────────────────────────────────
  print("", "info");
  print(
    "  source                         mode      baseline→current       Δ    days  msg/day",
    "system",
  );
  print("  " + "─".repeat(80), "system");

  let total = 0;
  let counted = 0;

  for (const row of rows) {
    const name = row.source.channel_name.slice(0, 28).padEnd(28);
    const mode = String(row.source.mode ?? "listener").padEnd(8);

    if (row.error) {
      print(`  ${name} ${mode} ERROR: ${row.error}`, "error");
      continue;
    }
    if (row.baselineId === null) {
      print(`  ${name} ${mode} no baseline (current=${row.currentId})`, "warning");
      continue;
    }

    const stale =
      row.perDay !== null && (row.perDay < STALE_PER_DAY || row.days > STALE_DAYS);
    const perDayStr = row.perDay === null ? "    n/a" : pad(row.perDay.toFixed(1), 7);

    print(
      `  ${name} ${mode} ${pad(row.baselineId, 8)}→${pad(row.currentId, 8)} ` +
        `${pad(row.delta, 7)} ${pad(row.days.toFixed(1), 6)} ${perDayStr}` +
        `${stale ? "  stale — check polling" : ""}`,
      stale ? "warning" : "info",
    );

    if (row.perDay !== null && !stale) {
      total += row.perDay;
      counted += 1;
    }
  }

  print("  " + "─".repeat(80), "system");
  print(`  counted ${counted} source(s) with a usable, non-stale baseline`, "info");
  print(`  Σ messages/day                    ≈ ${total.toFixed(0)}`, "success");
  print(
    `  × 2 requests/post (enrich + embed) ≈ ${(total * 2).toFixed(0)} RPD, ` +
      "before regex-stage rejects and gateway cache",
    "success",
  );
  print("", "info");
  print(
    "Compare the RPD figure against the daily limit of the model ids in ROADMAP §3.1 —",
    "info",
  );
  print("that comparison is the whole input to the provider decision.", "info");

  await telegramClient.disconnect();
  await database.disconnect();
  print("TheFlow volume estimate — done", "success");
}

main().catch(async (error) => {
  print(`Volume estimate failed: ${error.message}`, "error");
  console.error(error);
  try { await telegramClient.disconnect(); } catch { /* already down */ }
  try { await database.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
