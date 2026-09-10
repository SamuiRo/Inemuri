import fs from "fs/promises";

import { Command } from "commander";
import database from "./module/teapot/sqlite/sqlite_db.js";
import SourceSeeder from "./module/seeders/Sourceseeder.js";
import { Source, Post } from "./module/teapot/models/index.js";
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

// ── TheFlow inspection (ROADMAP 2.8) ────────────────────────────────────────
const CAND_KEYS = ["promo_codes", "tickers", "urls", "dates", "amounts"];

function emptyStatBucket() {
  return {
    n: 0,
    status: {},
    mediaShort: 0, // has_media AND length(raw_text) < 200 — vision candidate
    lenSum: 0,
    lenMax: 0,
    lenBuckets: { "0": 0, "<50": 0, "<200": 0, "<500": 0, "<1000": 0, "1000+": 0 },
    cand: Object.fromEntries(CAND_KEYS.map((k) => [k, { n: 0, samples: new Set() }])),
  };
}

function addLen(bucket, len) {
  bucket.lenSum += len;
  if (len > bucket.lenMax) bucket.lenMax = len;
  if (len === 0) bucket.lenBuckets["0"]++;
  else if (len < 50) bucket.lenBuckets["<50"]++;
  else if (len < 200) bucket.lenBuckets["<200"]++;
  else if (len < 500) bucket.lenBuckets["<500"]++;
  else if (len < 1000) bucket.lenBuckets["<1000"]++;
  else bucket.lenBuckets["1000+"]++;
}

function parseCandidates(raw) {
  let c = raw;
  if (typeof c === "string") {
    try { c = JSON.parse(c); } catch { return null; }
  }
  return c && typeof c === "object" ? c : null;
}

function printBucket(label, b) {
  print(`\n${label} — ${b.n} post(s)`, "system");
  const statusStr = Object.entries(b.status)
    .sort((a, c) => c[1] - a[1])
    .map(([s, n]) => `${s}:${n}`)
    .join("  ");
  print(`  status      ${statusStr || "—"}`);
  const repost = b.status.skipped_repost ?? 0;
  print(`  skipped_repost share  ${b.n ? ((repost / b.n) * 100).toFixed(1) : "0"}%`);
  print(
    `  raw_text len  avg ${b.n ? Math.round(b.lenSum / b.n) : 0}  max ${b.lenMax}  ` +
      Object.entries(b.lenBuckets).map(([k, v]) => `${k}:${v}`).join(" "),
  );
  print(
    `  vision candidate (has_media & len<200)  ${b.mediaShort}` +
      (b.n ? ` (${((b.mediaShort / b.n) * 100).toFixed(1)}%)` : ""),
  );
  for (const k of CAND_KEYS) {
    const c = b.cand[k];
    if (c.n === 0) continue;
    const samples = [...c.samples].slice(0, 5).join(", ");
    print(`  candidates.${k}  ${c.n} non-empty (${((c.n / b.n) * 100).toFixed(1)}%)  e.g. ${samples}`);
  }
}

async function collectFlowStats() {
  const [rows] = await database.sequelize.query(
    'SELECT source_id, status, has_media, candidates, "createdAt" AS created_at, ' +
      "LENGTH(raw_text) AS len FROM posts",
  );
  if (rows.length === 0) {
    print(
      'No flow posts yet — set "flow": { "enabled": true } on a source, run ' +
        "npm run migrate, and let it ingest.",
      "warning",
    );
    return;
  }

  const sources = await Source.findAll();
  const nameById = new Map(sources.map((s) => [s.id, s.channel_name]));

  const times = rows
    .map((r) => new Date(r.created_at).getTime())
    .filter((t) => !Number.isNaN(t));
  const spanDays = Math.max((Date.now() - Math.min(...times)) / 86_400_000, 1 / 24);

  const total = emptyStatBucket();
  const perSource = new Map();

  for (const r of rows) {
    if (!perSource.has(r.source_id)) perSource.set(r.source_id, emptyStatBucket());
    const buckets = [total, perSource.get(r.source_id)];
    const len = r.len ?? 0;
    const cand = parseCandidates(r.candidates);

    for (const b of buckets) {
      b.n++;
      b.status[r.status] = (b.status[r.status] ?? 0) + 1;
      addLen(b, len);
      if (r.has_media && len < 200) b.mediaShort++;
      if (cand) {
        for (const k of CAND_KEYS) {
          const arr = Array.isArray(cand[k]) ? cand[k] : [];
          if (arr.length === 0) continue;
          b.cand[k].n++;
          for (const v of arr.slice(0, 3)) {
            if (b.cand[k].samples.size < 8) b.cand[k].samples.add(String(v));
          }
        }
      }
    }
  }

  print(
    `Flow corpus: ${total.n} post(s) over ~${spanDays.toFixed(1)} day(s)  ` +
      `≈ ${(total.n / spanDays).toFixed(1)}/day`,
    "success",
  );
  printBucket("TOTAL", total);
  for (const [sourceId, b] of perSource) {
    printBucket(nameById.get(sourceId) ?? `source #${sourceId}`, b);
  }
}

const flow = program.command("flow").description("TheFlow corpus inspection (ROADMAP 2.8)");

flow
  .command("stats")
  .description("Per-source and total corpus stats (runs on the VPS)")
  .action(async () => {
    try {
      await database.connect();
      await collectFlowStats();
      await database.disconnect();
    } catch (error) {
      print(`Error: ${error.message}`, "error");
      process.exit(1);
    }
  });

flow
  .command("export")
  .description("Sanitized JSONL sample for local prompt work")
  .option("--out <file>", "write to a file instead of stdout")
  .option("--limit <n>", "max rows", "500")
  .option("--status <list>", "comma-separated status filter", "pending,enriched")
  .action(async (options) => {
    try {
      await database.connect();

      const limit = Math.max(1, Number(options.limit) || 500);
      const statuses = String(options.status)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const rows = await Post.findAll({
        where: { status: statuses },
        order: [["createdAt", "DESC"]],
        limit,
      });

      const sources = await Source.findAll();
      const nameById = new Map(sources.map((s) => [s.id, s.channel_name]));

      // Sanitized: drop ids that tie a row back to a specific channel/message
      // (channel_id, message_id, external_id/url, media_ref, entities) and the
      // enrichment fields. Keep content, candidates, hash, source name.
      const body = rows
        .map((p) =>
          JSON.stringify({
            id: p.id,
            source: nameById.get(p.source_id) ?? null,
            platform: p.platform,
            posted_at: p.posted_at,
            status: p.status,
            has_media: p.has_media,
            text_hash: p.text_hash,
            raw_text: p.raw_text,
            text_md: p.text_md,
            candidates: p.candidates,
          }),
        )
        .join("\n");
      const out = body + (rows.length ? "\n" : "");

      if (options.out) {
        await fs.writeFile(options.out, out, "utf-8");
        print(`Wrote ${rows.length} row(s) to ${options.out}`, "success");
      } else {
        process.stdout.write(out);
      }

      await database.disconnect();
    } catch (error) {
      print(`Error: ${error.message}`, "error");
      process.exit(1);
    }
  });

program.parse();
