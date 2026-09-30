import { Op } from "sequelize";

import database from "../../teapot/sqlite/sqlite_db.js";
import { Post, Source, Cluster } from "../../teapot/models/index.js";
import { resolve } from "../ResolveStage.js";
import { render } from "./render.js";
import { telegramLink } from "../search/HistorySearch.js";

const HOUR = 3_600_000;
const timeOf = (p) => new Date(p.posted_at ?? p.createdAt).getTime();

// Що качати для доставки. Ті самі типи, що й класичний шлях; фільтр і ліміт
// діють ДО завантаження (MediaResolver), тож пост-дубль ніколи не тягне відео.
const MEDIA_TYPES = ["photo", "video", "animation", "document"];
const MEDIA_LIMIT = 10;

const PLATFORMS = ["telegram", "discord"];

/**
 * TheFlow — доставка (ROADMAP §5.4–5.6, DELIVERY.md).
 *
 *   вибір    enriched-пости, що пройшли дедуплікацію як канонічні (або без
 *            неї, коли стадію вимкнено), і failed — ті йдуть у #unsorted;
 *   resolve  вердикт → призначення (ResolveStage, чиста);
 *   медіа    ліниво, лише для того, що справді надсилається (§5, «Lazy media
 *            is as much the point as routing»);
 *   render   на кожну платформу окремо (render.js, чиста);
 *   send     через ін'єктований `route(messageData)` — це
 *            MessageRouter.routeMessage, який не змінюється (§5: «Do not
 *            refactor MessageRouter»); він повертає ідентичності надісланого;
 *   запис    posts.status → routed | unsorted (§5.6), posts.delivery — журнал,
 *            clusters.delivered — куди пішло (§5.5), для майбутніх правок (§6.6).
 *
 * Не надсилає нічого, що старше за `maxAgeHours`: корпус може містити історію
 * каналу, і перше ж увімкнення вивалило б її в канали. Такі пости
 * позначаються `delivery.skipped = "too_old"` і більше не вибираються.
 *
 * Модуль не знає ні Telegram, ні Discord: відправку й медіа ін'єктує inemuri.js.
 */
export class FlowDelivery {
  /**
   * @param {{
   *   route: (messageData: object) => Promise<object[]|undefined>,
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
    route, resolveMedia = async () => [], routing, flowFor = async () => null,
    dedupEnabled = true, maxAgeHours = 24, batchSize = 5, maxAttempts = 3,
    intervalMs = 15_000, now = Date.now, log = () => {},
  }) {
    this.route = route;
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

  async runOnce() {
    const batch = await this.candidates();
    for (const post of batch) {
      try {
        await this.deliver(post);
      } catch (error) {
        this.log(`[DELIVERY] posts#${post.id} failed: ${error.message}`, "warning");
        await this._recordFailure(post, error.message);
      }
    }
    return batch.length;
  }

  async _source(id) {
    if (!this._sources.has(id)) this._sources.set(id, id ? await Source.findByPk(id) : null);
    return this._sources.get(id);
  }

  /**
   * Що і куди пішло б — без медіа й без відправки. Використовують deliver()
   * і `flow preview`.
   *
   * @returns {Promise<{ skip?: string, resolved?: object, cluster?: object,
   *   messages: Array<{ platform: string, ids: string[], rendered: object }> }>}
   */
  async plan(post) {
    if (this.now() - timeOf(post) > this.maxAgeHours * HOUR) {
      return { skip: "too_old", messages: [] };
    }

    const cluster = post.cluster_id ? await Cluster.findByPk(post.cluster_id) : null;
    if (cluster && Array.isArray(cluster.delivered) && cluster.delivered.length > 0) {
      // Подію вже доставлено іншим постом; новий канонічний — справа §6.6
      // (переписати надіслане), не другого повідомлення.
      return { skip: "cluster_already_delivered", cluster, messages: [] };
    }

    const flow = (await this.flowFor(post)) ?? (await this._source(post.source_id))?.getFlowConfig?.() ?? {};
    const resolved = resolve({ post, flow, routing: this.routing });
    const members = cluster
      ? await Post.findAll({
        where: { cluster_id: cluster.id, id: { [Op.ne]: post.id }, link_role: ["linked", "correction"] },
        attributes: ["id", "adds", "link_role"],
      })
      : [];
    const source = (await this._source(post.source_id))?.channel_name ?? null;
    const plain = post.get ? post.get({ plain: true }) : post;

    const messages = [];
    for (const platform of PLATFORMS) {
      const ids = resolved.destinations[platform];
      if (!ids?.length) continue;
      messages.push({
        platform,
        ids,
        rendered: render({
          post: plain, cluster, members: members.map((m) => (m.get ? m.get({ plain: true }) : m)),
          source, resolved, link: telegramLink(plain), platform,
        }),
      });
    }
    if (messages.length === 0) return { skip: "no_destinations", resolved, cluster, messages };
    return { resolved, cluster, messages };
  }

  /** Надіслати один пост і записати результат. */
  async deliver(post) {
    const p = await this.plan(post);
    if (p.skip) {
      await post.update({
        delivery: {
          skipped: p.skip,
          outcome: p.resolved?.outcome ?? null,
          reason: p.resolved?.reason ?? null,
          at: new Date(this.now()).toISOString(),
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
      const r = m.rendered;
      const messageData = m.platform === "telegram"
        ? { platform: "theflow", source: { name: r.header, destinations: { telegram: m.ids } },
          rawText: r.body, text: r.body, entities: r.entities, downloadedMedia: media }
        : { platform: "theflow", source: { name: r.author, destinations: { discord: m.ids } },
          text: r.description, embed: { color: r.color, footer: r.footer, url: r.url }, downloadedMedia: media };
      const sent = await this.route(messageData);
      if (Array.isArray(sent)) delivered.push(...sent);
    }

    if (delivered.length === 0) {
      await this._recordFailure(post, "no destination accepted the message", p.resolved);
      return { failed: true };
    }

    const at = new Date(this.now()).toISOString();
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
          at,
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
}

export default FlowDelivery;
