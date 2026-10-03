import { Source, SourceState } from "../../module/teapot/models/index.js";
import messageFilter from "../../module/filters/MessageFilter.js";
import FlowIngest from "../../module/theflow/FlowIngest.js";
import { print } from "../../shared/utils.js";
import { FEEDS } from "../../config/app.config.js";
import { fetchFeed, feedThrottle, RedditAuth } from "./http.js";
import { selectNew } from "./parsers.js";
import { strategyFor, usesTriage } from "./discovery.js";
import TriageQueue from "../../module/theflow/triage/TriageQueue.js";
import { toItem } from "../../module/theflow/triage/candidates.js";

export const FEED_PLATFORMS = ["reddit", "rss"];
const MIN = 60_000;

/** Звідки опитувати джерело. null — конфіг джерела непридатний. */
export function feedUrlOf(source, maxItems = FEEDS.maxItems, { oauth = false } = {}) {
  return strategyFor(source)?.url(source, { maxItems, oauth }) ?? null;
}

/**
 * Елемент стрічки → messageData, який розуміють і FlowIngest, і класичний
 * форвардинг. Для Telegram-адресатів заголовок жирний — entity на початку
 * rawText; для Discord — Markdown у `text`.
 */
export function toFeedMessageData(source, item) {
  const title = item.title ?? "";
  const body = item.text ?? "";
  const link = item.link ?? "";
  const plain = [title, body, link].filter(Boolean).join("\n\n");
  const md = [title ? `**${title}**` : "", body, link].filter(Boolean).join("\n\n");
  return {
    platform: source.platform,
    channelId: source.channel_id,
    externalId: String(item.id),
    externalUrl: item.link ?? null,
    title: item.title ?? null,
    author: item.author ?? null,
    timestamp: item.publishedAt ? new Date(item.publishedAt) : new Date(),
    // TheFlow: тіло окремо від заголовка (ROADMAP §7).
    body,
    mediaUrls: item.imageUrls ?? [],
    // Класичний форвардинг: заголовок + тіло + посилання.
    rawText: plain,
    text: md,
    entities: title ? [{ className: "MessageEntityBold", offset: 0, length: title.length }] : [],
  };
}

/**
 * Опитувач стрічок: Reddit, RSS/Atom, news sitemap, WordPress API
 * (ROADMAP §7.1–7.5, NEWS_INTAKE.md §2.1; спосіб — discovery.js).
 *
 * На кожне джерело — свій розклад (`poll_interval_min`, інакше
 * FEED_POLL_INTERVAL_MIN), курсор у SourceState.cursor (`{ ts, seen, url,
 * etag, lastModified }`), перший прохід — лише baseline. Запити йдуть через
 * HostThrottle (пауза між запитами до одного хоста), умовно (304 — дешево),
 * а 429/503 відкладають джерело на Retry-After.
 *
 * Кожен новий елемент проходить той самий шлях, що й Telegram: replacements →
 * для flow-джерела FlowIngest (blacklist, repost, INSERT), інакше фільтр і
 * `message.received` для класичного форвардингу (без медіа: адресати
 * покажуть прев'ю посилання).
 */
export class FeedPoller {
  /**
   * @param {{
   *   eventBus: object,
   *   fetch?: typeof fetchFeed,
   *   throttle?: object,
   *   flowIngest?: FlowIngest,
   *   config?: typeof FEEDS,
   *   now?: () => number,
   *   log?: (msg: string, level?: string) => void,
   * }} deps
   */
  constructor({
    eventBus, fetch = fetchFeed, throttle = feedThrottle, flowIngest = new FlowIngest(),
    triage = new TriageQueue(), config = FEEDS, redditAuth = null, now = Date.now, log = print,
  }) {
    this.eventBus = eventBus;
    this.fetch = fetch;
    this.throttle = throttle;
    // OAuth для Reddit, якщо в конфігу є client id і secret; інакше — публічний JSON.
    this.redditAuth = redditAuth ?? (config.reddit?.clientId && config.reddit?.clientSecret
      ? new RedditAuth({ ...config.reddit, userAgent: config.userAgent })
      : null);
    this._warnedForbidden = new Set();
    this.flowIngest = flowIngest;
    this.triage = triage;
    this.config = config;
    this.now = now;
    this.log = log;
    this.sources = [];
    this._nextAt = new Map(); // source.id -> мс
    this._timer = null;
    this._running = false;
  }

  async load() {
    this.sources = (await Source.findAll({ where: { platform: FEED_PLATFORMS, is_active: true } }))
      .filter((s) => {
        if (feedUrlOf(s, this.config.maxItems, { oauth: Boolean(this.redditAuth?.configured) })) return true;
        this.log(`[FEEDS] ${s.platform} source "${s.channel_name}": unusable channel_id ${JSON.stringify(s.channel_id)} or feed.discovery — skipped`, "warning");
        return false;
      });
    return this.sources.length;
  }

  async start() {
    const n = await this.load();
    if (n === 0) {
      this.log("[FEEDS] no active reddit/rss sources", "debug");
      return;
    }
    this._running = true;
    this.log(`[FEEDS] polling ${n} feed source(s)`, "success");
    this._schedule(0);
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  _schedule(ms) {
    if (!this._running) return;
    this._timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (error) {
        this.log(`[FEEDS] tick error: ${error.message}`, "error");
      }
      this._schedule(this.config.tickMs);
    }, ms);
    this._timer.unref?.();
  }

  _intervalMs(source) {
    const own = Number(source.poll_interval_min);
    return (Number.isFinite(own) && own > 0 ? own : this.config.pollIntervalMin) * MIN;
  }

  /** Опитати всі джерела, чий час настав. Повертає кількість нових елементів. */
  async tick() {
    let total = 0;
    for (const source of this.sources) {
      if ((this._nextAt.get(source.id) ?? 0) > this.now()) continue;
      try {
        total += await this.pollSource(source);
      } catch (error) {
        this.log(`[FEEDS] "${source.channel_name}" poll failed: ${error.message}`, "warning");
        this._nextAt.set(source.id, this.now() + this._intervalMs(source));
      }
    }
    return total;
  }

  async pollSource(source) {
    const strategy = strategyFor(source);
    const oauth = source.platform === "reddit" && Boolean(this.redditAuth?.configured);
    const parseOpts = { maxTextChars: this.config.maxTextChars };
    const state = await SourceState.getOrCreate(source.id);
    const cursor = state.cursor && typeof state.cursor === "object" && "seen" in state.cursor ? state.cursor : null;

    let url = feedUrlOf(source, this.config.maxItems, { oauth });
    let res = await this._get(source, url, strategy.accept, cursor, { oauth, configuredUrl: url });
    if (!this._shouldParse(source, res, { oauth })) return 0;
    let parsed = strategy.parse(res.body, parseOpts);

    // Індекс sitemap-ів: статті — у найсвіжішому дочірньому. Індекс сам
    // запитується без умовних заголовків (див. _get), тож новий дочірній
    // sitemap не загубиться за 304 незмінного індексу. Один рівень вкладення.
    if (parsed.children.length) {
      url = parsed.children[0];
      res = await this._get(source, url, strategy.accept, cursor, { oauth });
      if (!this._shouldParse(source, res, { oauth })) return 0;
      parsed = strategy.parse(res.body, parseOpts);
      if (parsed.children.length) {
        this.log(`[FEEDS] "${source.channel_name}": sitemap index nested deeper than one level — point channel_id at an inner index`, "warning");
        return 0;
      }
    }

    const items = parsed.items;
    const picked = selectNew(items.slice(0, this.config.maxItems), cursor, { seenMax: this.config.seenGuids });
    for (const item of picked.items) await this.handleItem(source, item);

    await state.update({
      cursor: { ...picked.cursor, url, etag: res.etag ?? null, lastModified: res.lastModified ?? null },
      ...(state.baseline_set_at ? {} : { baseline_set_at: new Date(this.now()) }),
    });
    if (picked.baseline) {
      this.log(`[FEEDS] baseline for "${source.channel_name}": ${items.length} existing item(s) skipped`, "info");
    } else if (picked.items.length) {
      this.log(`[FEEDS] "${source.channel_name}": ${picked.items.length} new item(s)`, "success");
    }
    return picked.items.length;
  }

  /**
   * Один GET через throttle. Умовні заголовки — лише для тієї адреси, чиї
   * ETag/Last-Modified лежать у курсорі (`cursor.url`; у старих курсорів
   * його немає — тоді це адреса з конфігу).
   */
  async _get(source, url, accept, cursor, { oauth, configuredUrl = null }) {
    const own = cursor && (cursor.url ?? configuredUrl) === url;
    const headers = oauth ? { authorization: `bearer ${await this.redditAuth.token()}` } : {};
    return this.throttle.run(url, () => this.fetch(url, {
      userAgent: this.config.userAgent,
      timeoutMs: this.config.timeoutMs,
      maxBytes: this.config.maxFeedBytes,
      etag: own ? cursor.etag ?? null : null,
      lastModified: own ? cursor.lastModified ?? null : null,
      accept,
      headers,
    }));
  }

  /**
   * Чи є що розбирати. Ні — коли джерело закрите (401/403), просить почекати
   * (429/503) або нічого не змінилось (304); тоді тут же планується наступне
   * опитування.
   */
  _shouldParse(source, res, { oauth }) {
    if (res.forbidden) {
      if (oauth && res.status === 401) this.redditAuth.invalidate(); // протухлий токен — новий наступного разу
      const backoff = (this.config.forbiddenBackoffMin ?? 360) * MIN;
      this._nextAt.set(source.id, this.now() + backoff);
      if (!this._warnedForbidden.has(source.id)) {
        this._warnedForbidden.add(source.id);
        const hint = source.platform === "reddit" && !oauth
          ? " — Reddit blocks unauthenticated requests from many addresses; set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET (a \"script\" app at reddit.com/prefs/apps)"
          : "";
        this.log(`[FEEDS] "${source.channel_name}" answered ${res.status}${hint}. Retrying every ${Math.round(backoff / MIN)} min.`, "warning");
      }
      return false;
    }
    this._warnedForbidden.delete(source.id);

    if (res.retryAfterMs != null) {
      this._nextAt.set(source.id, this.now() + Math.max(res.retryAfterMs, this._intervalMs(source)));
      this.log(`[FEEDS] "${source.channel_name}" rate-limited (${res.status}), next in ${Math.round(res.retryAfterMs / 1000)}s+`, "warning");
      return false;
    }
    this._nextAt.set(source.id, this.now() + this._intervalMs(source));
    return res.status !== 304;
  }

  /**
   * Новий елемент: джерело з triage — у чергу triage (NEWS_INTAKE.md §2.2),
   * решта — одразу далі (ingestItem).
   */
  async handleItem(source, item) {
    if (usesTriage(source)) return this.triage.add(source, item);
    return this.ingestItem(source, item);
  }

  /**
   * Кандидат, пропущений triage, → пост (TriageStage викликає через
   * ін'єкцію). Той самий шлях, яким пройшов би елемент без triage.
   *
   * @param {object} row discovered_items
   * @returns {Promise<object>} створений (або вже наявний) пост.
   */
  async promote(row) {
    const source = await Source.findByPk(row.source_id);
    if (!source) throw new Error("source no longer exists");
    if (!source.isFlowEnabled()) throw new Error(`source "${source.channel_name}" is no longer flow-enabled`);
    return this.ingestItem(source, toItem(row));
  }

  /**
   * Елемент → replacements → FlowIngest (flow-джерело) або фільтр і
   * `message.received` (класичний форвардинг).
   *
   * @returns {Promise<object|null>} пост flow-джерела; null — класичний шлях.
   */
  async ingestItem(source, item) {
    const messageData = toFeedMessageData(source, item);
    const replacements = messageFilter.getCompiledReplacements(source);
    const filter = messageFilter.getCompiledFilter(source);

    if (source.isFlowEnabled()) {
      const text = messageFilter.preprocessText(replacements, messageData.body);
      const { created, post, status } = await this.flowIngest.ingest({
        source,
        messageData,
        text,
        blacklist: filter?.blacklist ?? null,
        caseSensitive: filter?.caseSensitive ?? false,
        rejectShouty: filter?.rejectShouty ?? null,
      });
      if (created) this.log(`[THEFLOW] ${source.channel_name} ${item.id} → posts#${post.id} [${status}]`, status === "pending" ? "success" : "debug");
      return post;
    }

    const plain = messageFilter.preprocessText(replacements, messageData.rawText);
    if (!messageFilter.checkMessageFast(null, filter, plain)) return null;
    this.eventBus.emit("message.received", {
      ...messageData,
      rawText: plain,
      // Replacements могли зсунути текст — жирний заголовок лише коли він
      // лишився на місці.
      entities: plain.startsWith(messageData.title ?? " ") ? messageData.entities : [],
      text: plain === messageData.rawText ? messageData.text : plain,
      source: { id: source.id, name: source.channel_name, destinations: source.getAllDestinations() },
    });
    return null;
  }
}

export default FeedPoller;
