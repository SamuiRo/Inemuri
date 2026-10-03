import fs from "fs/promises";
import readline from "node:readline/promises";

import { Command } from "commander";
import { Op } from "sequelize";
import database from "./module/teapot/sqlite/sqlite_db.js";
import SourceSeeder from "./module/seeders/Sourceseeder.js";
import { Source, Post, PostFeedback, Cluster } from "./module/teapot/models/index.js";
import { print } from "./shared/utils.js";
import { collectHealthSnapshot, assessHealth, primaryQuota } from "./module/theflow/FlowHealth.js";
import DedupStage from "./module/theflow/dedup/DedupStage.js";
import HistorySearch from "./module/theflow/search/HistorySearch.js";
import FlowDelivery from "./module/theflow/delivery/FlowDelivery.js";
import { collectStorage, assessStorage, storageLine } from "./module/theflow/Storage.js";
import { buildDigestMessage } from "./module/theflow/digest/Digest.js";
import LLMGateway from "./services/ai/LLMGateway.js";
import {
  recordLabel, backfillFromFeedback, exportKnowledge, importKnowledge, knowledgeStats,
} from "./module/theflow/knowledge/KnowledgeBase.js";
import { serialize as serializeKnowledge, parse as parseKnowledge } from "./module/theflow/knowledge/exchange.js";
import {
  FLOW_HEALTH, LLM_PROVIDERS, LLM_PRIMARY, ENRICH_WORKER_ENABLED, CATEGORIES, DEDUP,
  FLOW_DELIVERY, ROUTING, FLOW_DIGEST,
} from "./config/app.config.js";

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

/** §13.9: розмір корпусу і точка перегляду — у stats і health. */
async function printStorage() {
  const s = await collectStorage();
  print(storageLine(s), "info");
  const a = assessStorage(s);
  if (a.reviewDue) print(a.note, "warning");
}

const flow = program.command("flow").description("TheFlow corpus inspection (ROADMAP 2.8)");

flow
  .command("stats")
  .description("Per-source and total corpus stats (runs on the VPS)")
  .action(async () => {
    try {
      await database.connect();
      await collectFlowStats();
      await printStorage();
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

function truncateForReview(text, max = 400) {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

flow
  .command("review")
  .description("Review enriched posts, write one-key labels to post_feedback and the knowledge base")
  .option("--limit <n>", "max posts this session", "50")
  .option("--topic <t>", "only this topic")
  .action(async (options) => {
    try {
      await database.connect();

      const limit = Math.max(1, Number(options.limit) || 50);
      const labelled = new Set(
        (await PostFeedback.findAll({ attributes: ["post_id"] }))
          .map((r) => r.post_id)
          .filter((id) => id != null),
      );

      const where = { status: "enriched" };
      if (options.topic) where.topic = options.topic;
      const queue = (await Post.findAll({ where, order: [["createdAt", "ASC"]] }))
        .filter((p) => !labelled.has(p.id))
        .slice(0, limit);

      if (queue.length === 0) {
        print("No unreviewed enriched posts.", "success");
        await database.disconnect();
        return;
      }

      print(
        `${queue.length} post(s) to review. Keys: [g]ood  [n]oise  [w]rong-topic  [s]kip  [q]uit`,
        "system",
      );
      // Pull one line per prompt via readline's async iterator — this yields
      // buffered lines one at a time (piped `flow review < answers.txt`) and
      // live lines as typed (a TTY), and returns null cleanly at EOF.
      const rl = readline.createInterface({ input: process.stdin });
      const lines = rl[Symbol.asyncIterator]();
      const ask = async (q) => {
        process.stdout.write(q);
        const { value, done } = await lines.next();
        return done ? null : value;
      };
      const VERDICT = { g: "good", n: "noise", w: "wrong_topic" };

      let written = 0;
      for (const p of queue) {
        print("", "info");
        print(
          `#${p.id}  ${p.topic}/${p.signal_type}  confidence=${p.confidence}  ` +
            `model=${p.model_used}  taxv=${p.taxonomy_version}`,
          "system",
        );
        print(`raw: ${truncateForReview(p.raw_text)}`);
        print(`en : ${truncateForReview(p.text_en)}`);

        const raw = await ask("> ");
        if (raw === null) break; // EOF
        const key = raw.trim().toLowerCase();
        if (key === "q") break;
        if (key === "s" || key === "") continue;

        const verdict = VERDICT[key];
        if (!verdict) {
          print("unknown key — skipped", "warning");
          continue;
        }
        let note = null;
        if (verdict !== "good") {
          const n = await ask("note (optional): ");
          note = n && n.trim() ? n.trim() : null;
        }
        await recordLabel({ post: p, verdict, note });
        written += 1;
        print(`recorded: ${verdict}`, "success");
      }

      rl.close();
      print(`\nDone — ${written} label(s) written.`, "success");
      await database.disconnect();
    } catch (error) {
      print(`Error: ${error.message}`, "error");
      process.exit(1);
    }
  });

// ── База знань (NEWS_INTAKE.md §3) ───────────────────────────────────

/** Підключення, дія, відключення; помилка — повідомлення і код 1. */
const withDatabase = (action) => async (...args) => {
  try {
    await database.connect();
    await action(...args);
    await database.disconnect();
  } catch (error) {
    print(`Error: ${error.message}`, "error");
    process.exit(1);
  }
};

const csv = (value) => (value ? String(value).split(",").map((s) => s.trim()).filter(Boolean) : undefined);

const knowledge = flow
  .command("knowledge")
  .description("The knowledge base: labelled examples that move between instances (NEWS_INTAKE.md §3)");

knowledge
  .command("stats")
  .description("Examples by level, verdict and origin")
  .action(withDatabase(async () => {
    const s = await knowledgeStats();
    const line = (counts) => Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(" · ") || "—";
    print(`Knowledge base: ${s.total} example(s)`, "system");
    print(`  level:   ${line(s.level)}`);
    print(`  verdict: ${line(s.verdict)}`);
    print(`  origin:  ${line(s.origin)}`);
  }));

knowledge
  .command("export")
  .description("Write the knowledge base as JSONL (header line + one example per line)")
  .option("--out <file>", "write to a file instead of stdout")
  .option("--level <list>", "comma-separated levels: post,headline,article")
  .option("--verdict <list>", "comma-separated verdicts: good,noise,wrong_topic,missed")
  .action(withDatabase(async (options) => {
    const rows = await exportKnowledge({ levels: csv(options.level), verdicts: csv(options.verdict) });
    const out = serializeKnowledge(rows);
    if (options.out) {
      await fs.writeFile(options.out, out, "utf-8");
      print(`Wrote ${rows.length} example(s) to ${options.out}`, "success");
    } else {
      process.stdout.write(out);
    }
  }));

knowledge
  .command("import <file>")
  .description("Add examples from a JSONL export; existing uids are left as they are, so a repeat changes nothing")
  .option("--dry-run", "validate and count, write nothing")
  .action(withDatabase(async (file, options) => {
    const { header, rows, errors } = parseKnowledge(await fs.readFile(file, "utf-8"));
    for (const e of errors) print(`line ${e.line}: ${e.error} — skipped`, "warning");
    const { created, existing } = await importKnowledge(rows, { dryRun: Boolean(options.dryRun) });
    print(
      `${options.dryRun ? "Would import" : "Imported"} ${created} example(s); ${existing} already present; ` +
        `${errors.length} invalid line(s). Export of ${header.exported_at}, ${header.count} example(s).`,
      created ? "success" : "info",
    );
  }));

knowledge
  .command("backfill")
  .description("Copy post_feedback labels that are not in the knowledge base yet (migration 015 does this once)")
  .action(withDatabase(async () => {
    const { created, skipped } = await backfillFromFeedback();
    print(`Backfilled ${created} label(s)${skipped ? `, ${skipped} skipped (no post or no text)` : ""}`, "success");
  }));

flow
  .command("requeue")
  .description("Return posts to the enrich queue (pending, attempts 0, verdict cleared)")
  .option("--status <list>", "comma-separated statuses to requeue", "failed")
  .option("--error <text>", "only posts whose last_error contains this text")
  .option("--model <model_used>", "only posts whose verdict came from this model")
  .option("--prompt-below <n>", "only verdicts from an enrich prompt version below n (re-extract after a prompt change)")
  .option("--dry-run", "count, change nothing")
  .action(async (options) => {
    try {
      await database.connect();
      const status = String(options.status).split(",").map((s) => s.trim()).filter(Boolean);
      const { ids, withFeedback } = await Post.requeue({
        status,
        errorLike: options.error,
        modelUsed: options.model,
        promptBelow: options.promptBelow,
        dryRun: Boolean(options.dryRun),
      });

      const verb = options.dryRun ? "Would requeue" : "Requeued";
      print(`${verb} ${ids.length} post(s) [status: ${status.join(",")}]`, ids.length ? "success" : "info");
      if (withFeedback) {
        print(
          `${withFeedback} of them have post_feedback labels for the old verdict — review them again after re-enrichment`,
          "warning",
        );
      }
      if (!options.dryRun && ids.length) {
        print("The enrich worker picks them up on its next tick; a running service needs no restart.", "info");
      }
      await database.disconnect();
    } catch (error) {
      print(`Error: ${error.message}`, "error");
      process.exit(1);
    }
  });

function dedupLogOf(p) {
  let d = p.dedup;
  if (typeof d === "string") {
    try { d = JSON.parse(d); } catch { d = null; }
  }
  return d && typeof d === "object" ? d : null;
}

flow
  .command("dedup")
  .description("Deduplication: report (ROADMAP 6.7), --run to process the backlog, --pairs for threshold calibration (6.8)")
  .option("--reset", "erase every deduplication decision first (refused once anything is delivered)")
  .option("--run", "deduplicate enriched posts that have no decision yet")
  .option("--limit <n>", "with --run: max posts", "100000")
  .option("--days <n>", "report window in days", "7")
  .option("--pairs <n>", "print the n closest non-tier-1 pairs around the thresholds, with both texts")
  .action(async (options) => {
    try {
      await database.connect();

      if (options.reset) {
        const r = await DedupStage.reset();
        print(`Reset: ${r.posts} post(s) back to undecided, ${r.clusters} cluster(s) removed`, "warning");
      }

      if (options.run) {
        const sources = new Map();
        const flowFor = async (post) => {
          if (!sources.has(post.source_id)) sources.set(post.source_id, await Source.findByPk(post.source_id));
          return sources.get(post.source_id)?.getFlowConfig() ?? null;
        };
        const stage = new DedupStage({
          taxonomy: CATEGORIES, thresholds: DEDUP, flowFor,
          batchSize: DEDUP.batchSize, boilerplateMin: DEDUP.boilerplateMin,
          boilerplateDays: DEDUP.boilerplateDays, log: print,
        });
        const limit = Math.max(1, Number(options.limit) || 100000);
        let total = 0;
        for (;;) {
          const n = await stage.runOnce(Math.min(DEDUP.batchSize, limit - total));
          total += n;
          if (n === 0 || total >= limit) break;
        }
        print(`Deduplicated ${total} post(s)`, "success");
      }

      const days = Math.max(1, Number(options.days) || 7);
      const since = new Date(Date.now() - days * 86_400_000);
      const rows = await Post.findAll({
        where: { dedup: { [Op.ne]: null }, updatedAt: { [Op.gte]: since } },
        attributes: ["id", "signal_type", "status", "link_role", "cluster_id", "text_en", "dedup", "posted_at", "createdAt"],
      });

      if (rows.length === 0) {
        print(`No deduplication decisions in the last ${days} day(s).`, "info");
      } else {
        const bucket = () => ({ total: 0, new: 0, t1: 0, t2: 0, suppressed: 0, linked: 0, gray: 0, errors: 0 });
        const byDay = new Map();
        const bySignal = new Map();
        const hist = new Map();
        const add = (map, key, d, p) => {
          if (!map.has(key)) map.set(key, bucket());
          const b = map.get(key);
          b.total += 1;
          if (d.error) { b.errors += 1; return; }
          if (d.decision === "new") b.new += 1;
          if (d.tier === 1) b.t1 += 1;
          if (d.tier === 2) b.t2 += 1;
          if (p.status === "suppressed") b.suppressed += 1;
          if (d.decision === "join" && d.role === "linked") b.linked += 1;
          if (d.gray) b.gray += 1;
        };
        for (const p of rows) {
          const d = dedupLogOf(p);
          if (!d) continue;
          const day = String(d.t ?? new Date(p.posted_at ?? p.createdAt).toISOString()).slice(0, 10);
          add(byDay, day, d, p);
          add(bySignal, p.signal_type ?? "?", d, p);
          if (typeof d.s === "number") {
            const bin = Math.max(0.5, Math.floor(d.s * 20) / 20);
            hist.set(bin, (hist.get(bin) ?? 0) + 1);
          }
        }
        const line = (label, b) => {
          const joined = b.t1 + b.t2;
          const rate = b.total ? ((joined / b.total) * 100).toFixed(1) : "0.0";
          return `${label.padEnd(16)} ${String(b.total).padStart(5)} posts · new ${b.new} · joined ${joined} ` +
            `(t1 ${b.t1}, t2 ${b.t2}) · suppressed ${b.suppressed} · linked ${b.linked} · gray ${b.gray}` +
            (b.errors ? ` · errors ${b.errors}` : "") + ` · collapse ${rate}%`;
        };
        print(`Deduplication — last ${days} day(s), HIGH ${DEDUP.high} / LOW ${DEDUP.low}`, "system");
        for (const [day, b] of [...byDay].sort()) print(line(day, b));
        print("by signal", "system");
        for (const [sig, b] of [...bySignal].sort((a, b2) => b2[1].total - a[1].total)) print(line(sig, b));
        print("nearest-neighbour similarity s (tier 2 candidates)", "system");
        if (hist.size === 0) {
          print(
            "  none — no post had a candidate from another source in its window" +
              (DEDUP.tier2SameSource ? "" : " (same-source matches are off: DEDUP_TIER2_SAME_SOURCE)"),
          );
        }
        for (const [bin, n] of [...hist].sort((a, b2) => b2[0] - a[0])) {
          const mark = bin + 0.05 > DEDUP.high && bin <= DEDUP.high ? " ← HIGH" : bin + 0.05 > DEDUP.low && bin <= DEDUP.low ? " ← LOW" : "";
          print(`  ${bin.toFixed(2)}–${(bin + 0.05).toFixed(2)}  ${"█".repeat(Math.min(n, 60))} ${n}${mark}`);
        }
        const top = await Cluster.findAll({
          where: { members_count: { [Op.gt]: 1 }, updatedAt: { [Op.gte]: since } },
          order: [["members_count", "DESC"]],
          limit: 5,
        });
        if (top.length) {
          print("largest clusters", "system");
          const canon = new Map((await Post.findAll({
            where: { id: top.map((c) => c.canonical_post_id) }, attributes: ["id", "text_en"],
          })).map((p) => [p.id, p.text_en]));
          for (const c of top) {
            print(`  #${c.id} ${c.topic}/${c.signal_type} ×${c.members_count}  ${truncateForReview(canon.get(c.canonical_post_id), 120)}`);
          }
        }
      }

      if (options.pairs) {
        const n = Math.max(1, Number(options.pairs) || 20);
        const near = rows
          .map((p) => ({ p, d: dedupLogOf(p) }))
          .filter(({ d }) => d && d.tier !== 1 && typeof d.s === "number" && d.nearest_post_id &&
            d.s >= DEDUP.low - 0.05 && d.s <= DEDUP.high + 0.05)
          .sort((a, b) => b.d.s - a.d.s)
          .slice(0, n);
        const other = new Map((await Post.findAll({
          where: { id: near.map(({ d }) => d.nearest_post_id) }, attributes: ["id", "text_en"],
        })).map((p) => [p.id, p.text_en]));
        print(`${near.length} pair(s) around the thresholds — same event or not?`, "system");
        for (const { p, d } of near) {
          print(`s=${d.s.toFixed(4)}  ${d.decision}${d.gray ? " (gray)" : ""}  #${p.id} ↔ #${d.nearest_post_id}`, "system");
          print(`  A: ${truncateForReview(other.get(d.nearest_post_id), 200)}`);
          print(`  B: ${truncateForReview(p.text_en, 200)}`);
        }
      }

      await database.disconnect();
    } catch (error) {
      print(`Error: ${error.message}`, "error");
      process.exit(1);
    }
  });

flow
  .command("search")
  .description("Search the corpus (ROADMAP 9.1): keyword via FTS5, or --semantic via one embedding call")
  .argument("<query...>", "words to find")
  .option("--semantic", "embedding similarity instead of keywords (one low-priority provider call)")
  .option("--topic <t>", "only this topic")
  .option("--signal <s>", "only this signal")
  .option("--days <n>", "only the last n days")
  .option("--source <id>", "only this source id")
  .option("--limit <n>", "results, up to 25", "10")
  .action(async (words, options) => {
    try {
      await database.connect();
      const gateway = options.semantic ? new LLMGateway() : null;
      const search = new HistorySearch({ gateway });
      const res = await search.search({
        query: words.join(" "),
        mode: options.semantic ? "semantic" : "keyword",
        topic: options.topic,
        signal: options.signal,
        days: options.days,
        sourceId: options.source,
        limit: options.limit,
      });
      process.stdout.write(res.text + "\n");
      await database.disconnect();
      if (res.error) process.exitCode = 1;
    } catch (error) {
      print(`Error: ${error.message}`, "error");
      process.exit(1);
    }
  });

flow
  .command("preview")
  .description("Show what delivery would send and where (ROADMAP 5.4) — sends nothing")
  .option("--id <postId>", "preview this post (any status the stage would take)")
  .option("--limit <n>", "how many waiting posts to preview", "3")
  .option("--ignore-age", "preview posts older than FLOW_DELIVERY_MAX_AGE_HOURS too")
  .option("--platform <p>", "only telegram or discord")
  .action(async (options) => {
    try {
      await database.connect();
      const stage = new FlowDelivery({
        route: async () => [],
        routing: ROUTING,
        dedupEnabled: DEDUP.enabled,
        maxAgeHours: options.ignoreAge ? Number.MAX_SAFE_INTEGER / 3_600_000 : FLOW_DELIVERY.maxAgeHours,
      });
      const posts = options.id
        ? [await Post.findByPk(Number(options.id))].filter(Boolean)
        : await stage.candidates(Math.max(1, Number(options.limit) || 3));
      if (posts.length === 0) print("Nothing waiting for delivery.", "info");

      print(`delivery is ${FLOW_DELIVERY.enabled ? "ON" : "OFF (shadow mode)"}`, "system");
      for (const post of posts) {
        const p = await stage.plan(post);
        const head = `#${post.id} ${post.status} ${post.topic ?? "-"}/${post.signal_type ?? "-"}`;
        if (p.skip) {
          print(`${head} — skipped: ${p.skip}${p.resolved ? ` (${p.resolved.outcome}, ${p.resolved.reason})` : ""}`, "warning");
          continue;
        }
        print(`${head} → ${p.resolved.outcome} (${p.resolved.reason})`, "system");
        for (const m of p.messages) {
          if (options.platform && m.platform !== options.platform) continue;
          const r = m.rendered;
          process.stdout.write(`\n── ${m.platform} → ${m.ids.join(", ")}\n`);
          if (m.platform === "telegram") {
            process.stdout.write(`${r.header}\n${r.body}\n`);
            process.stdout.write(`   [${r.entities.length} entities, ${r.header.length + 1 + r.body.length}/4096 chars]\n`);
          } else {
            process.stdout.write(`author: ${r.author}\n${r.description}\nfooter: ${r.footer ?? ""} · color #${r.color.toString(16)} · url ${r.url ?? "-"}\n`);
          }
        }
        process.stdout.write("\n");
      }
      await database.disconnect();
    } catch (error) {
      print(`Error: ${error.message}`, "error");
      process.exit(1);
    }
  });

flow
  .command("digest")
  .description("Preview the TheFlow digest (ROADMAP 9) — sends nothing")
  .option("--hours <n>", "period, hours back from now", String(FLOW_DIGEST.hours))
  .option("--per-topic <n>", "posts per section", String(FLOW_DIGEST.perTopic))
  .action(async (options) => {
    try {
      await database.connect();
      const m = await buildDigestMessage({
        hours: Math.max(1, Number(options.hours) || FLOW_DIGEST.hours),
        perTopic: Math.max(1, Number(options.perTopic) || FLOW_DIGEST.perTopic),
        excludeSignals: FLOW_DIGEST.excludeSignals,
        topicOrder: Object.keys(CATEGORIES.topics ?? {}),
      });
      if (!m) print("Nothing for a digest in that period.", "info");
      else process.stdout.write(`${m.rawText}\n\n[${m.metadata.posts} post(s), ${m.rawText.length} chars]\n`);
      await database.disconnect();
    } catch (error) {
      print(`Error: ${error.message}`, "error");
      process.exit(1);
    }
  });

flow
  .command("health")
  .description("Stall / failure check (ROADMAP 13.10); exits 1 when there is a problem")
  .action(async () => {
    try {
      await database.connect();
      const snap = await collectHealthSnapshot({
        failureWindowMin: FLOW_HEALTH.failureWindowMin,
        quota: primaryQuota(LLM_PROVIDERS, LLM_PRIMARY),
      });
      // CLI не знає, чи крутиться воркер у сервісі; судимо за конфігом.
      const workerRunning = ENRICH_WORKER_ENABLED && Boolean(LLM_PROVIDERS[LLM_PRIMARY]?.apiKey);
      const report = assessHealth(snap, FLOW_HEALTH, { workerRunning });
      const w = snap.window;

      print(
        `pending ${snap.pending}` +
          (snap.oldestPendingAt ? ` (oldest ${snap.oldestPendingAt.toISOString()})` : "") +
          ` · last ${w.minutes} min: enriched ${w.enriched}, failed ${w.failed}` +
          ` · last ingest ${snap.lastIngestAt?.toISOString() ?? "never"}` +
          ` · flow sources ${snap.flowSources}` +
          (snap.quota ? ` · quota ${snap.quota.key} ${snap.quota.used}/${snap.quota.rpd ?? "?"}${snap.quota.exhausted ? " exhausted" : ""}` : ""),
        "system",
      );
      for (const e of w.topErrors) print(`  ×${e.count} ${e.error}`, "warning");
      for (const n of report.notes) print(n, "info");
      await printStorage();
      for (const p of report.problems) print(`${p.key}: ${p.message}`, "error");
      if (report.ok) print("TheFlow healthy", "success");

      await database.disconnect();
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      print(`Error: ${error.message}`, "error");
      process.exit(1);
    }
  });

program.parse();
