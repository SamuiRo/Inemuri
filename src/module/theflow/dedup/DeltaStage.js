import { Op } from "sequelize";

import database from "../../teapot/sqlite/sqlite_db.js";
import { Post, Cluster } from "../../teapot/models/index.js";
import { NEVER_SUPPRESS_SIGNALS } from "./DedupCore.js";
import { isDeferrable } from "../../../services/ai/LLMGateway.js";

/**
 * TheFlow — delta-виклик (ROADMAP §6.6, DEDUPLICATION.md «Step 2»).
 *
 * Бере пости, які дедуплікація приєднала як `linked` (пройшли дешевий гейт —
 * можуть щось додавати), і питає gateway, що саме: `same` / `adds` /
 * `corrects` / `denies`. Результат — у `posts.adds`:
 *
 *   same      → duplicate, suppressed (як і на гейті)
 *   adds      → лишається linked; доставка допише доповнення (FlowDelivery)
 *   corrects  → correction; доставка перепише повідомлення І надішле нове
 *   denies    → correction, кластер закривається
 *
 * `security` не пригнічується ніколи (ROADMAP §6 «Non-negotiable»): `same`
 * на такому пості лишає його linked без доповнень — лише рахується.
 *
 * Shed (квота під тиском) — не спроба: пакет зупиняється, пости чекають
 * наступного тіку. Помилка — спроба; після `maxAttempts` пост лишається
 * linked з `adds.error` і більше не береться.
 *
 * Не знає ні Telegram, ні Discord: лише posts, clusters і gateway.
 */
export class DeltaStage {
  constructor({ gateway, batchSize = 5, maxAttempts = 3, now = Date.now, log = () => {} }) {
    if (!gateway) throw new Error("DeltaStage: a gateway is required");
    this.gateway = gateway;
    this.batchSize = batchSize;
    this.maxAttempts = maxAttempts;
    this.now = now;
    this.log = log;
  }

  async candidates(limit = this.batchSize) {
    return await Post.findAll({
      where: {
        link_role: "linked",
        cluster_id: { [Op.ne]: null },
        [Op.or]: [
          { adds: null },
          database.sequelize.literal(
            `(json_extract(\`Post\`.\`adds\`, '$.error') IS NOT NULL AND json_extract(\`Post\`.\`adds\`, '$.attempts') < ${Number(this.maxAttempts)})`,
          ),
        ],
      },
      order: [
        [database.sequelize.fn("COALESCE", database.sequelize.col("posted_at"), database.sequelize.col("Post.createdAt")), "ASC"],
        ["id", "ASC"],
      ],
      limit,
    });
  }

  /** Повертає кількість постів, що отримали відповідь (або остаточну помилку). */
  async runOnce() {
    const batch = await this.candidates();
    let done = 0;
    for (const post of batch) {
      const cluster = await Cluster.findByPk(post.cluster_id);
      const canonical = cluster?.canonical_post_id && cluster.canonical_post_id !== post.id
        ? await Post.findByPk(cluster.canonical_post_id)
        : null;
      if (!cluster || !canonical) {
        // Нема з чим порівнювати (кластер зник або пост сам став канонічним).
        await post.update({ adds: { skipped: "no_canonical", at: new Date(this.now()).toISOString() } });
        done += 1;
        continue;
      }

      let r;
      try {
        r = await this.gateway.delta(
          { canonical: canonical.text_en ?? canonical.raw_text ?? "", candidate: post.text_en ?? post.raw_text ?? "" },
          { priority: "normal" },
        );
      } catch (error) {
        // Квота чи rate limit — як shed: не спроба, пакет чекає наступного тіку.
        if (isDeferrable(error)) {
          this.log(`[DELTA] deferred (${error.message})`, "warning");
          break;
        }
        const attempts = Number(post.adds?.error ? post.adds.attempts : 0) + 1;
        await post.update({
          adds: { error: String(error.message).slice(0, 300), attempts, at: new Date(this.now()).toISOString() },
        });
        this.log(`[DELTA] posts#${post.id} failed (${attempts}/${this.maxAttempts}): ${error.message}`, "warning");
        done += 1;
        continue;
      }
      if (r?.shed) break;

      await this.apply(post, cluster, r);
      done += 1;
    }
    return done;
  }

  async apply(post, cluster, r) {
    const neverSuppress = NEVER_SUPPRESS_SIGNALS.has(post.signal_type) || NEVER_SUPPRESS_SIGNALS.has(cluster.signal_type);
    const adds = {
      relation: r.relation,
      adds: r.adds ?? [],
      confidence: r.confidence,
      model_used: r.model_used ?? null,
      at: new Date(this.now()).toISOString(),
    };
    const patch = { adds };
    if (r.relation === "same" && !neverSuppress) {
      patch.link_role = "duplicate";
      patch.status = "suppressed";
    } else if (r.relation === "corrects" || r.relation === "denies") {
      patch.link_role = "correction";
    }

    await database.sequelize.transaction(async (transaction) => {
      await post.update(patch, { transaction });
      if (r.relation === "denies") {
        // Подію скасовано: нові пости до неї більше не приєднуються.
        await Cluster.update({ closed: true }, { where: { id: cluster.id }, transaction });
      }
    });
    this.log(`[DELTA] posts#${post.id} → ${r.relation}${adds.adds.length ? ` (+${adds.adds.length})` : ""}`, "success");
  }
}

export default DeltaStage;
