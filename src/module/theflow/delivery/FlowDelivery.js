import { Op } from "sequelize";

import database from "../../teapot/sqlite/sqlite_db.js";
import { Post, Source, Cluster } from "../../teapot/models/index.js";
import { resolve } from "../ResolveStage.js";
import { render, renderNotice } from "./render.js";
import { telegramLink } from "../search/HistorySearch.js";

const HOUR = 3_600_000;
const timeOf = (p) => new Date(p.posted_at ?? p.createdAt).getTime();
const plainOf = (row) => (row?.get ? row.get({ plain: true }) : row);

// Що качати для доставки. Ті самі типи, що й класичний шлях; фільтр і ліміт
// діють ДО завантаження (MediaResolver), тож пост-дубль ніколи не тягне відео.
const MEDIA_TYPES = ["photo", "video", "animation", "document"];
const MEDIA_LIMIT = 10;

const PLATFORMS = ["telegram", "discord"];

// DEDUPLICATION.md «Step 3»: після трьох доповнень повідомлення стає
// нечитабельним — далі лише лічильник. Виправлення й спростування — поза капом.
export const MAX_APPENDS = 3;

/** Рендер → messageData у форматі, який розуміють наявні адаптери. */
export function toMessageData(rendered, destinations = {}, media = []) {
  if (rendered.platform === "telegram") {
    return {
      platform: "theflow",
      source: { name: rendered.header, destinations },
      rawText: rendered.body,
      text: rendered.body,
      entities: rendered.entities,
      downloadedMedia: media,
    };
  }
  return {
    platform: "theflow",
    source: { name: rendered.author, destinations },
    text: rendered.description,
    embed: { color: rendered.color, footer: rendered.footer, url: rendered.url },
    downloadedMedia: media,
  };
}

/**
 * TheFlow — доставка (ROADMAP §5.4–5.6, §6.6; DELIVERY.md).
 *
 * Нові пости:
 *   вибір    enriched-пости, що пройшли дедуплікацію як канонічні (або без
 *            неї, коли стадію вимкнено), і failed — ті йдуть у #unsorted;
 *   resolve  вердикт → призначення (ResolveStage, чиста);
 *   медіа    ліниво, лише для того, що справді надсилається;
 *   render   на кожну платформу окремо (render.js, чиста);
 *   send     через ін'єктований `route(messageData)` — це
 *            MessageRouter.routeMessage, який не змінюється (§5);
 *   запис    posts.status → routed | unsorted, posts.delivery, clusters.delivered.
 *
 * Оновлення вже надісланого (§6.6), коли delta-виклик щось визначив:
 *   adds       повний перерендер і правка кожного надісланого повідомлення,
 *              не більше MAX_APPENDS разів на кластер;
 *   corrects / правка з банером І нове повідомлення-відповідь — правка не дає
 *   denies     сповіщення (DELIVERY.md, рішення 3). Капу немає ніколи;
 *   новий канонічний пост у доставленому кластері — повний перерендер.
 * Невдала правка — не невдала доставка: замість неї йде відповідь із
 * перерендереним вмістом.
 *
 * Не надсилає нічого, що старше за `maxAgeHours` (позначає too_old).
 * Модуль не знає ні Telegram, ні Discord: відправку, правку й медіа ін'єктує
 * inemuri.js.
 */
export class FlowDelivery {
  /**
   * @param {{
   *   route: (messageData: object) => Promise<object[]|undefined>,
   *   sendTo?: (platform: string, destinationId: string, messageData: object) => Promise<object|null>,
   *   edit?: (platform: string, channelId: string, messageId: string|number, messageData: object, identity: object) => Promise<unknown>,
   *   resolveMedia?: (post: object, opts: object) => Promise<object[]>,
   *   routing: object,
   *   flowFor?: (post: object) => Promise<object|null>,
   *   dedupEnabled?: boolean,
   *   maxAgeHours?: number,
   *   batchSize?: number,
   *   maxAttempts?: number,
   *   intervalMs?: number,
   *   now?: () => number,
   *   log?: (msg: string, level?: string) => void,
   * }} deps
   */
  constructor({
    route, sendTo = async () => null, edit = async () => { throw new Error("edit not wired"); },
    resolveMedia = async () => [], routing, flowFor = async () => null,
    dedupEnabled = true, maxAgeHours = 24, batchSize = 5, maxAttempts = 3,
    intervalMs = 15_000, now = Date.now, log = () => {},
  }) {
    this.route = route;
    this.sendTo = sendTo;
    this.edit = edit;
    this.resolveMedia = resolveMedia;
    this.routing = routing;
    this.flowFor = flowFor;
    this.dedupEnabled = dedupEnabled;
    this.maxAgeHours = maxAgeHours;
    this.batchSize = batchSize;
    this.maxAttempts = maxAttempts;
    this.intervalMs = intervalMs;
    this.now = now;
    this.log = log;
    this._timer = null;
    this._running = false;
    this._sources = new Map();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._schedule(this.intervalMs);
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  _schedule(ms) {
    if (!this._running) return;
    this._timer = setTimeout(async () => {
      let n = 0;
      try {
        n = await this.runOnce();
      } catch (error) {
        this.log(`[DELIVERY] tick error: ${error.message}`, "error");
      }
      this._schedule(n > 0 ? 1_000 : this.intervalMs);
    }, ms);
    this._timer.unref?.();
  }

  /** Один прохід: спершу оновлення (спростування не чекають), потім нові. */
  async runOnce() {
    const updated = await this.refreshOnce();

    const batch = await this.candidates();
    for (const post of batch) {
      try {
        await this.deliver(post);
      } catch (error) {
        this.log(`[DELIVERY] posts#${post.id} failed: ${error.message}`, "warning");
        await this._recordFailure(post, error.message);
      }
    }
    return updated + batch.length;
  }

  // ── нові пости ─────────────────────────────────────────────────────

  /** Пости, що чекають доставки, найстаріші першими. */
  async candidates(limit = this.batchSize) {
    const undecided = {
      [Op.or]: [
        { delivery: null },
        // Невдала відправка — повтор, поки не вичерпано спроби.
        database.sequelize.literal(
          `(json_extract(\`Post\`.\`delivery\`, '$.failed') = 1 AND json_extract(\`Post\`.\`delivery\`, '$.attempts') < ${Number(this.maxAttempts)})`,
        ),
      ],
    };
    const enriched = {
      status: "enriched",
      [Op.or]: [{ link_role: null }, { link_role: "canonical" }],
      ...(this.dedupEnabled ? { dedup: { [Op.ne]: null } } : {}),
    };
    return await Post.findAll({
      where: { [Op.and]: [undecided, { [Op.or]: [enriched, { status: "failed" }] }] },
      order: [
        [database.sequelize.fn("COALESCE", database.sequelize.col("posted_at"), database.sequelize.col("Post.createdAt")), "ASC"],
        ["id", "ASC"],
      ],
      limit,
    });
  }

  async _source(id) {
    if (!this._sources.has(id)) this._sources.set(id, id ? await Source.findByPk(id) : null);
    return this._sources.get(id);
  }

  async _resolve(post) {
    const flow = (await this.flowFor(post)) ?? (await this._source(post.source_id))?.getFlowConfig?.() ?? {};
    return resolve({ post, flow, routing: this.routing });
  }

  /** Рендер поста кластера для однієї платформи. */
  async _render(post, cluster, resolved, platform) {
    const members = cluster
      ? await Post.findAll({
        where: { cluster_id: cluster.id, id: { [Op.ne]: post.id }, link_role: ["linked", "correction"] },
        attributes: ["id", "adds", "link_role"],
        order: [["id", "ASC"]],
      })
      : [];
    const plain = plainOf(post);
    return render({
      post: plain, cluster: plainOf(cluster), members: members.map(plainOf),
      source: (await this._source(post.source_id))?.channel_name ?? null,
      resolved, link: telegramLink(plain), platform,
    });
  }

  /**
   * Що і куди пішло б — без медіа й без відправки. Використовують deliver()
   * і `flow preview`.
   */
  async plan(post) {
    if (this.now() - timeOf(post) > this.maxAgeHours * HOUR) {
      return { skip: "too_old", messages: [] };
    }

    const cluster = post.cluster_id ? await Cluster.findByPk(post.cluster_id) : null;
    if (cluster && Array.isArray(cluster.delivered) && cluster.delivered.length > 0) {
      // Подію вже доставлено. Якщо цей пост став її канонічним — переписати
      // надіслане (DEDUPLICATION.md «Replacing the canonical post»), а не
      // надсилати друге повідомлення.
      if (cluster.canonical_post_id === post.id) return { rewrite: true, cluster, messages: [] };
      return { skip: "cluster_already_delivered", cluster, messages: [] };
    }

    const resolved = await this._resolve(post);
    const messages = [];
    for (const platform of PLATFORMS) {
      const ids = resolved.destinations[platform];
      if (!ids?.length) continue;
      messages.push({ platform, ids, rendered: await this._render(post, cluster, resolved, platform) });
    }
    if (messages.length === 0) return { skip: "no_destinations", resolved, cluster, messages };
    return { resolved, cluster, messages };
  }

  /** Надіслати один пост і записати результат. */
  async deliver(post) {
    const p = await this.plan(post);
    const at = () => new Date(this.now()).toISOString();

    if (p.rewrite) {
      const resolved = await this._resolve(post);
      const results = await this.refreshCluster(p.cluster.id, [], { force: true });
      await post.update({
        status: resolved.outcome === "routed" ? "routed" : "unsorted",
        delivery: {
          outcome: resolved.outcome, reason: resolved.reason,
          rewrote_cluster: p.cluster.id, applied: results, at: at(),
        },
      });
      return { rewrote: p.cluster.id };
    }

    if (p.skip) {
      await post.update({
        delivery: {
          skipped: p.skip,
          outcome: p.resolved?.outcome ?? null,
          reason: p.resolved?.reason ?? null,
          at: at(),
        },
      });
      return { skipped: p.skip };
    }

    let media = [];
    let mediaError = null;
    if (post.has_media) {
      try {
        media = await this.resolveMedia(post, { types: MEDIA_TYPES, limit: MEDIA_LIMIT });
      } catch (error) {
        // Без медіа краще, ніж ніяк: текст і посилання на оригінал доходять.
        mediaError = String(error.message).slice(0, 200);
        this.log(`[DELIVERY] posts#${post.id} media unavailable: ${mediaError}`, "warning");
      }
    }

    const delivered = [];
    let wanted = 0;
    for (const m of p.messages) {
      wanted += m.ids.length;
      const sent = await this.route(toMessageData(m.rendered, { [m.platform]: m.ids }, media));
      if (Array.isArray(sent)) delivered.push(...sent);
    }

    if (delivered.length === 0) {
      await this._recordFailure(post, "no destination accepted the message", p.resolved);
      return { failed: true };
    }

    const record = delivered.map((d) => ({
      ...d, sent_at: d.sent_at instanceof Date ? d.sent_at.toISOString() : d.sent_at,
    }));
    await database.sequelize.transaction(async (transaction) => {
      await post.update({
        status: p.resolved.outcome === "routed" ? "routed" : "unsorted",
        delivery: {
          outcome: p.resolved.outcome,
          reason: p.resolved.reason,
          rule: p.resolved.rule,
          delivered: record,
          partial: delivered.length < wanted,
          ...(mediaError ? { media_error: mediaError } : {}),
          at: at(),
        },
      }, { transaction });
      if (p.cluster) {
        const prev = Array.isArray(p.cluster.delivered) ? p.cluster.delivered : [];
        await Cluster.update({ delivered: [...prev, ...record] }, { where: { id: p.cluster.id }, transaction });
      }
    });
    this.log(
      `[DELIVERY] posts#${post.id} → ${p.resolved.outcome} (${p.resolved.reason}), ${delivered.length}/${wanted} sent`,
      "success",
    );
    return { outcome: p.resolved.outcome, delivered: record };
  }

  async _recordFailure(post, message, resolved = null) {
    const attempts = Number(post.delivery?.failed ? post.delivery.attempts : 0) + 1;
    await post.update({
      delivery: {
        failed: true,
        attempts,
        error: String(message).slice(0, 300),
        outcome: resolved?.outcome ?? null,
        reason: resolved?.reason ?? null,
        at: new Date(this.now()).toISOString(),
      },
    });
  }

  // ── оновлення надісланого (§6.6) ───────────────────────────────────

  /** Члени кластерів, чиє доповнення чи виправлення ще не застосовано. */
  async pendingUpdates(limit = 20) {
    return await Post.findAll({
      where: {
        link_role: ["linked", "correction"],
        cluster_id: { [Op.ne]: null },
        [Op.and]: [
          database.sequelize.literal("json_extract(`Post`.`adds`, '$.relation') IN ('adds', 'corrects', 'denies')"),
          database.sequelize.literal("json_extract(`Post`.`adds`, '$.applied_at') IS NULL"),
        ],
      },
      order: [["id", "ASC"]],
      limit,
    });
  }

  async refreshOnce() {
    const posts = await this.pendingUpdates();
    const byCluster = new Map();
    for (const p of posts) {
      if (!byCluster.has(p.cluster_id)) byCluster.set(p.cluster_id, []);
      byCluster.get(p.cluster_id).push(p);
    }
    for (const [clusterId, triggers] of byCluster) {
      try {
        await this.refreshCluster(clusterId, triggers);
      } catch (error) {
        this.log(`[DELIVERY] cluster#${clusterId} update failed: ${error.message}`, "warning");
      }
    }
    return posts.length;
  }

  /**
   * Переписати доставлені повідомлення кластера і, для виправлень, надіслати
   * відповідь. `triggers` — пости, що спричинили оновлення; кожен отримує
   * `adds.applied_at` і `adds.applied` (що саме зроблено, куди).
   *
   * @param {number} clusterId
   * @param {object[]} triggers
   * @param {{ force?: boolean }} [options]  force — переписати без тригерів
   *   (новий канонічний пост).
   * @returns {Promise<object[]>} Що зроблено з кожним повідомленням.
   */
  async refreshCluster(clusterId, triggers, { force = false } = {}) {
    const at = new Date(this.now()).toISOString();
    const cluster = await Cluster.findByPk(clusterId);
    const delivered = (Array.isArray(cluster?.delivered) ? cluster.delivered : []).filter((d) => d?.message_id != null);
    const mark = async (applied) => {
      for (const t of triggers) await t.update({ adds: { ...t.adds, applied_at: at, applied } });
    };

    if (!cluster || delivered.length === 0) {
      // Ще не доставлено: перший рендер кластера і так покаже ці доповнення.
      await mark([{ mode: "before_delivery" }]);
      return [];
    }

    const canonical = await Post.findByPk(cluster.canonical_post_id);
    if (!canonical) {
      await mark([{ mode: "no_canonical" }]);
      return [];
    }
    const resolved = canonical.delivery?.outcome
      ? { outcome: canonical.delivery.outcome, reason: canonical.delivery.reason }
      : await this._resolve(canonical);

    const corrections = triggers.filter((t) => t.adds?.relation === "corrects" || t.adds?.relation === "denies");
    const additions = triggers.filter((t) => t.adds?.relation === "adds");
    const underCap = Number(cluster.appends_count ?? 0) < MAX_APPENDS;
    const doEdit = force || corrections.length > 0 || (additions.length > 0 && underCap);

    const results = [];
    const rendered = new Map();
    const renderFor = async (platform) => {
      if (!rendered.has(platform)) rendered.set(platform, await this._render(canonical, cluster, resolved, platform));
      return rendered.get(platform);
    };

    if (doEdit) {
      for (const d of delivered) {
        const r = await renderFor(d.platform);
        const md = toMessageData(r);
        const where = { platform: d.platform, channel_id: d.channel_id, message_id: d.message_id };
        try {
          await this.edit(d.platform, d.channel_id, d.message_id, md, d);
          results.push({ ...where, mode: "edit" });
        } catch (error) {
          // Видалене, без прав, минуло вікно правки — відповідь замість правки.
          const reply = await this.sendTo(d.platform, d.channel_id, { ...md, replyTo: d.message_id });
          results.push({ ...where, mode: reply ? "reply" : "failed", error: String(error.message).slice(0, 200) });
        }
      }
    } else if (additions.length > 0) {
      results.push({ mode: "capped", appends_count: cluster.appends_count });
    }

    // Спростування — окремим повідомленням-відповіддю, завжди.
    for (const c of corrections) {
      const text = (c.adds.adds ?? []).map((a) => a.text_uk || a.text).filter(Boolean).join("; ") || "see update";
      for (const d of delivered) {
        const header = d.platform === "telegram" ? (await renderFor("telegram")).header : (await renderFor("discord")).author;
        const notice = renderNotice({ header, relation: c.adds.relation, text, platform: d.platform });
        const sent = await this.sendTo(d.platform, d.channel_id, { ...toMessageData(notice), replyTo: d.message_id });
        results.push({ platform: d.platform, channel_id: d.channel_id, reply_to: d.message_id,
          message_id: sent?.message_id ?? null, mode: sent ? "notice" : "failed", relation: c.adds.relation });
      }
    }

    const edited = results.some((x) => x.mode === "edit" || x.mode === "reply");
    if (edited && additions.length > 0) {
      await Cluster.update({ appends_count: Number(cluster.appends_count ?? 0) + additions.length }, { where: { id: cluster.id } });
    }
    await mark(results);
    this.log(
      `[DELIVERY] cluster#${cluster.id} updated: ${results.map((x) => x.mode).join(", ") || "nothing"}`,
      "success",
    );
    return results;
  }
}

export default FlowDelivery;
