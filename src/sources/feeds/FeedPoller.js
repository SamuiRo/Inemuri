import { Source, SourceState } from "../../module/teapot/models/index.js";
import messageFilter from "../../module/filters/MessageFilter.js";
import FlowIngest from "../../module/theflow/FlowIngest.js";
import { print } from "../../shared/utils.js";
import { FEEDS } from "../../config/app.config.js";
import { fetchFeed, feedThrottle, RedditAuth } from "./http.js";
import {
  parseFeed, parseRedditListing, normalizeSubreddit, redditListingUrl, selectNew,
} from "./parsers.js";

export const FEED_PLATFORMS = ["reddit", "rss"];
const MIN = 60_000;

/** Звідки опитувати джерело. null — конфіг джерела непридатний. */
export function feedUrlOf(source, maxItems = FEEDS.maxItems, { oauth = false } = {}) {
  if (source.platform === "reddit") {
    const sub = normalizeSubreddit(source.channel_id);
    return sub ? redditListingUrl(sub, maxItems, { oauth }) : null;
  }
  if (source.platform === "rss") return /^https?:\/\//i.test(source.channel_id) ? source.channel_id : null;
  return null;
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
 * Опитувач стрічок: Reddit і RSS/Atom (ROADMAP §7.1–7.5).
 *
 * На кожне джерело — свій розклад (`poll_interval_min`, інакше
 * FEED_POLL_INTERVAL_MIN), курсор у SourceState.cursor (`{ ts, seen, etag,
 * lastModified }`), перший прохід — лише baseline. Запити йдуть через
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
    config = FEEDS, redditAuth = null, now = Date.now, log = print,
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
        this.log(`[FEEDS] ${s.platform} source "${s.channel_name}": unusable channel_id ${JSON.stringify(s.channel_id)} — skipped`, "warning");
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
    const oauth = source.platform === "reddit" && Boolean(this.redditAuth?.configured);
    const url = feedUrlOf(source, this.config.maxItems, { oauth });
    const state = await SourceState.getOrCreate(source.id);
    const cursor = state.cursor && typeof state.cursor === "object" && "seen" in state.cursor ? state.cursor : null;

    const headers = oauth ? { authorization: `bearer ${await this.redditAuth.token()}` } : {};
    const res = await this.throttle.run(url, () => this.fetch(url, {
      userAgent: this.config.userAgent,
      timeoutMs: this.config.timeoutMs,
      maxBytes: this.config.maxFeedBytes,
      etag: cursor?.etag ?? null,
      lastModified: cursor?.lastModified ?? null,
      accept: source.platform === "reddit" ? "application/json" : undefined,
      headers,
    }));

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
      return 0;
    }
    this._warnedForbidden.delete(source.id);

    if (res.retryAfterMs != null) {
      this._nextAt.set(source.id, this.now() + Math.max(res.retryAfterMs, this._intervalMs(source)));
      this.log(`[FEEDS] "${source.channel_name}" rate-limited (${res.status}), next in ${Math.round(res.retryAfterMs / 1000)}s+`, "warning");
      return 0;
    }
    this._nextAt.set(source.id, this.now() + this._intervalMs(source));
    if (res.status === 304) return 0;

    const items = source.platform === "reddit"
      ? parseRedditListing(JSON.parse(res.body), { maxTextChars: this.config.maxTextChars })
      : parseFeed(res.body, { maxTextChars: this.config.maxTextChars });

    const picked = selectNew(items.slice(0, this.config.maxItems), cursor, { seenMax: this.config.seenGuids });
    for (const item of picked.items) await this.handleItem(source, item);

    await state.update({
      cursor: { ...picked.cursor, etag: res.etag ?? null, lastModified: res.lastModified ?? null },
      ...(state.baseline_set_at ? {} : { baseline_set_at: new Date(this.now()) }),
    });
    if (picked.baseline) {
      this.log(`[FEEDS] baseline for "${source.channel_name}": ${items.length} existing item(s) skipped`, "info");
    } else if (picked.items.length) {
      this.log(`[FEEDS] "${source.channel_name}": ${picked.items.length} new item(s)`, "success");
    }
    return picked.items.length;
  }

  async handleItem(source, item) {
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
      return;
    }

    const plain = messageFilter.preprocessText(replacements, messageData.rawText);
    if (!messageFilter.checkMessageFast(null, filter, plain)) return;
    this.eventBus.emit("message.received", {
      ...messageData,
      rawText: plain,
      // Replacements могли зсунути текст — жирний заголовок лише коли він
      // лишився на місці.
      entities: plain.startsWith(messageData.title ?? " ") ? messageData.entities : [],
      text: plain === messageData.rawText ? messageData.text : plain,
      source: { id: source.id, name: source.channel_name, destinations: source.getAllDestinations() },
    });
  }
}

export default FeedPoller;
