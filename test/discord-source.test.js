import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  normalizeMessage, embedText, messageText, mediaUrlsOf, toDiscordMessageData, passesClassic,
} from "../src/sources/discord/discordMessage.js";
import {
  FATAL_EXIT_CODE, isFatalCloseCode, restartDelayMs, assessStats, formatStats, describeMissing,
} from "../src/sources/discord/supervisor.js";
import { DiscordSelfSource } from "../src/sources/discord/DiscordSelfSource.js";
import messageFilter from "../src/module/filters/MessageFilter.js";

// ── Повідомлення ─────────────────────────────────────────────────────

/** Повідомлення в тому вигляді, що його віддає бібліотека (лише потрібні поля). */
const libMessage = (over = {}) => ({
  id: "1300000000000000001",
  channelId: "1200000000000000001",
  guildId: "1100000000000000001",
  author: { id: "1000000000000000001", username: "announcer" },
  // Кеш учасників — джерело витоку CloakCord; нормалізація його не чіпає.
  get member() { throw new Error("member must not be touched"); },
  content: "Season 3 airdrop is live",
  embeds: [],
  attachments: new Map(),
  createdTimestamp: Date.parse("2026-10-09T10:00:00Z"),
  ...over,
});

test("normalizeMessage → plain object: attachments from a Collection, embeds flattened, no library classes", () => {
  const m = normalizeMessage(libMessage({
    embeds: [{ title: "T", description: "D", url: "https://x.example", fields: [{ name: "Code", value: "ABC" }], image: { url: "https://cdn.example/e.png" } }],
    attachments: new Map([["a", { url: "https://cdn.example/a.png?ex=1", contentType: "image/png", name: "a.png", size: 10 }]]),
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m, "survives IPC as JSON");
  assert.equal(m.authorName, "announcer");
  assert.deepEqual(m.embeds[0], { title: "T", description: "D", url: "https://x.example", fields: [{ name: "Code", value: "ABC" }], imageUrl: "https://cdn.example/e.png" });
  assert.deepEqual(m.attachments, [{ url: "https://cdn.example/a.png?ex=1", contentType: "image/png", name: "a.png" }]);
  assert.equal(m.createdAt, Date.parse("2026-10-09T10:00:00Z"));
});

test("text includes embeds: an embed-only post is matched (CloakCord O6)", () => {
  const m = normalizeMessage(libMessage({
    content: "",
    embeds: [{ title: "New quest", description: "Claim the reward", fields: [{ name: "Ends", value: "Friday" }] }],
  }));
  assert.equal(embedText(m.embeds[0]), "New quest\nClaim the reward\nEnds\nFriday");
  assert.equal(messageText(m), "New quest\nClaim the reward\nEnds\nFriday");
  assert.equal(messageText({ content: "Hi", embeds: [{ title: "T" }] }), "Hi\n\nT");
});

test("mediaUrlsOf: images and videos only, embed images too, no repeats", () => {
  const urls = mediaUrlsOf({
    attachments: [
      { url: "https://cdn.example/a.png", contentType: "image/png" },
      { url: "https://cdn.example/b.mp4", contentType: "video/mp4" },
      { url: "https://cdn.example/c.zip", contentType: "application/zip" },
      { url: "https://cdn.example/d", contentType: null },
    ],
    embeds: [{ imageUrl: "https://cdn.example/a.png" }, { imageUrl: "https://cdn.example/e.webp" }, { imageUrl: null }],
  });
  assert.deepEqual(urls, ["https://cdn.example/a.png", "https://cdn.example/b.mp4", "https://cdn.example/e.webp"]);
});

test("toDiscordMessageData: ids, link to the message, timestamp, Markdown text", () => {
  const d = toDiscordMessageData(normalizeMessage(libMessage()));
  assert.equal(d.platform, "discord");
  assert.equal(d.channelId, "1200000000000000001");
  assert.equal(d.externalId, "1300000000000000001");
  assert.equal(d.externalUrl, "https://discord.com/channels/1100000000000000001/1200000000000000001/1300000000000000001");
  assert.equal(d.timestamp.toISOString(), "2026-10-09T10:00:00.000Z");
  assert.equal(d.body, "Season 3 airdrop is live");
  assert.equal(d.rawText, d.text);
  assert.deepEqual(d.entities, []);
});

test("passesClassic: text goes to the filter; media without text passes only without keywords (CloakCord F9)", () => {
  const yes = () => true;
  const no = () => false;
  assert.equal(passesClassic({ text: "hello", hasMedia: false, filter: null, check: yes }), true);
  assert.equal(passesClassic({ text: "hello", hasMedia: true, filter: null, check: no }), false);
  assert.equal(passesClassic({ text: "", hasMedia: true, filter: null, check: no }), true);
  assert.equal(passesClassic({ text: "", hasMedia: true, filter: { keywords: null }, check: no }), true);
  assert.equal(passesClassic({ text: "", hasMedia: true, filter: { keywords: new Set(["drop"]) }, check: yes }), false);
  assert.equal(passesClassic({ text: "  ", hasMedia: false, filter: null, check: yes }), false);
});

// ── Нагляд ───────────────────────────────────────────────────────────

test("supervisor: fatal close codes, growing restart delay with a cap, RSS verdict", () => {
  assert.equal(isFatalCloseCode(4004), true);
  assert.equal(isFatalCloseCode(4014), true);
  assert.equal(isFatalCloseCode(1000), false);
  assert.equal(isFatalCloseCode(4000), false);

  const cfg = { restartBaseMs: 30_000, restartCapMs: 300_000 };
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => restartDelayMs(n, cfg)), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  assert.equal(restartDelayMs(0, cfg), 30_000);

  assert.deepEqual(assessStats({ rssMb: 200 }, { maxRssMb: 450 }), { restart: false, reason: null });
  assert.equal(assessStats({ rssMb: 451.4 }, { maxRssMb: 450 }).restart, true);
  assert.equal(assessStats({}, { maxRssMb: 450 }).restart, false);
});

test("supervisor: the stats line and the missing-channels warning", () => {
  const line = formatStats(
    { uptimeMin: 120.2, rssMb: 210.4, heapMb: 70.1, guilds: 92, channels: 15188, members: 170, users: 2, events: 8123, watched: 76, visible: 74, seen: 310 },
    { matched: 14, ingested: 0, errors: 0 },
  );
  assert.equal(line, "uptime=120m rss=210MB heap=70MB | guilds=92 channels=15188 members=170 users=2 | events=8123 watched=74/76 seen=310 | matched=14 ingested=0 errors=0");

  assert.equal(describeMissing([], String), null);
  const many = Array.from({ length: 12 }, (_, i) => `id${i}`);
  const warning = describeMissing(many, (id) => `#${id}`);
  assert.match(warning, /^12 channel\(s\) not visible/);
  assert.match(warning, /#id9 \(id9\) and 2 more$/);
});

// ── DiscordSelfSource з підробленою дитиною ──────────────────────────

const CH_CLASSIC = "1200000000000000011";
const CH_FLOW = "1200000000000000012";

let nextSourceId = 9_000_000;
function fakeSource(channelId, { flow = false, keywords = [], destinations = { telegram: [], discord: ["1400000000000000001"] } } = {}) {
  return {
    id: nextSourceId++,
    channel_id: channelId,
    channel_name: `Server · #${channelId.slice(-2)}`,
    filters: { enabled: keywords.length > 0, keywords, blacklist: [], case_sensitive: false },
    text_replacements: { enabled: false, patterns: [] },
    isFlowEnabled: () => flow,
    getAllDestinations: () => destinations,
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.sent = [];
  child.killed = 0;
  child.send = (msg) => child.sent.push(msg);
  child.kill = () => { child.killed++; };
  return child;
}

function harness({ sources, token = "user-token", config = {} } = {}) {
  const children = [];
  const forks = [];
  const emitted = [];
  const ingested = [];
  const logs = [];
  const source = new DiscordSelfSource(
    { emit: (name, data) => emitted.push({ name, data }) },
    {
      token,
      config: {
        heapMb: 256, maxRssMb: 450, statsMin: 10, readyTimeoutMs: 1_000,
        restartBaseMs: 5, restartCapMs: 20, shutdownGraceMs: 50,
        mediaTypes: ["photo"], mediaLimit: 2, ...config,
      },
      flowIngest: { ingest: async (args) => { ingested.push(args); return { created: true, post: { id: 1 }, status: "pending" }; } },
      resolveMedia: async (post) => post.media_ref.urls.map((url) => ({ type: "photo", buffer: Buffer.from(url), filename: "x.png" })),
      activity: { touch: () => {} },
      loadSources: async () => sources,
      forkChild: (path, args, opts) => {
        forks.push({ path, args, opts });
        const c = fakeChild();
        children.push(c);
        return c;
      },
      log: (text, level) => logs.push({ text, level }),
    },
  );
  return { source, children, forks, emitted, ingested, logs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plainMessage = (channelId, over = {}) => normalizeMessage(libMessage({ channelId, ...over }));

test("no sources or no token: nothing is forked", async () => {
  const none = harness({ sources: [] });
  await none.source.connect();
  await none.source.startListening();
  assert.equal(none.forks.length, 0);

  const noToken = harness({ sources: [fakeSource(CH_CLASSIC)], token: null });
  await noToken.source.connect();
  await noToken.source.startListening();
  assert.equal(noToken.forks.length, 0);
  assert.match(noToken.logs.at(-1).text, /DISCORD_USER_TOKEN is not set/);
});

test("spawn: heap ceiling in execArgv, token over IPC (never in argv), watch before login", async () => {
  const h = harness({ sources: [fakeSource(CH_CLASSIC), fakeSource(CH_FLOW)] });
  await h.source.connect();
  await h.source.startListening();
  assert.equal(h.forks.length, 1);
  assert.match(h.forks[0].path, /selfbotChild\.js$/);
  assert.deepEqual(h.forks[0].args, []);
  assert.deepEqual(h.forks[0].opts.execArgv, ["--max-old-space-size=256"]);
  assert.ok(!JSON.stringify(h.forks[0]).includes("user-token"));
  const [watch, login] = h.children[0].sent;
  assert.deepEqual(watch, { type: "watch", channelIds: [CH_CLASSIC, CH_FLOW] });
  assert.equal(login.type, "login");
  assert.equal(login.token, "user-token");
  assert.equal(login.statsMs, 10 * 60_000);
});

test("classic: a keyword match is forwarded with media and destinations; a miss and an unknown channel are not", async () => {
  const src = fakeSource(CH_CLASSIC, { keywords: ["airdrop"] });
  const h = harness({ sources: [src] });
  await h.source.connect();

  await h.source.handleDiscordMessage(plainMessage(CH_CLASSIC, {
    attachments: new Map([["a", { url: "https://cdn.example/a.png", contentType: "image/png", name: "a.png" }]]),
  }));
  await h.source.handleDiscordMessage(plainMessage(CH_CLASSIC, { content: "nothing to see" }));
  await h.source.handleDiscordMessage(plainMessage("1299999999999999999"));

  assert.equal(h.emitted.length, 1);
  const { name, data } = h.emitted[0];
  assert.equal(name, "message.received");
  assert.equal(data.text, "Season 3 airdrop is live");
  assert.deepEqual(data.source, { id: src.id, name: src.channel_name, destinations: src.getAllDestinations() });
  assert.equal(data.downloadedMedia.length, 1);
  assert.ok(Buffer.isBuffer(data.downloadedMedia[0].data), "adapters read `data`, not `buffer`");
  assert.equal(h.source.counters.matched, 1);
  messageFilter.clearCache(src.id);
});

test("classic: an embed-only post matches its keywords", async () => {
  const src = fakeSource(CH_CLASSIC, { keywords: ["quest"] });
  const h = harness({ sources: [src] });
  await h.source.connect();
  await h.source.handleDiscordMessage(plainMessage(CH_CLASSIC, { content: "", embeds: [{ title: "New Quest", description: "go" }] }));
  assert.equal(h.emitted.length, 1);
  messageFilter.clearCache(src.id);
});

test("flow source: the message goes to FlowIngest, not to classic forwarding", async () => {
  const src = fakeSource(CH_FLOW, { flow: true });
  const h = harness({ sources: [src] });
  await h.source.connect();
  const post = await h.source.handleDiscordMessage(plainMessage(CH_FLOW));
  assert.deepEqual(post, { id: 1 });
  assert.equal(h.emitted.length, 0);
  assert.equal(h.ingested.length, 1);
  assert.equal(h.ingested[0].source, src);
  assert.equal(h.ingested[0].text, "Season 3 airdrop is live");
  assert.equal(h.ingested[0].messageData.platform, "discord");
  messageFilter.clearCache(src.id);
});

test("watchdog: RSS over the limit kills the child, the exit restarts it", async () => {
  const h = harness({ sources: [fakeSource(CH_CLASSIC)] });
  await h.source.connect();
  await h.source.startListening();
  const first = h.children[0];

  first.emit("message", { type: "stats", stats: { rssMb: 300 } });
  await sleep(0);
  assert.equal(first.killed, 0);
  first.emit("message", { type: "stats", stats: { rssMb: 500 } });
  await sleep(0);
  assert.equal(first.killed, 1);

  first.emit("exit", null, "SIGTERM");
  await sleep(30);
  assert.equal(h.forks.length, 2, "restarted after the delay");
  await h.source.stopListening().catch(() => {});
});

test("crash loop backs off; READY resets the attempt counter", async () => {
  const h = harness({ sources: [fakeSource(CH_CLASSIC)] });
  await h.source.connect();
  await h.source.startListening();
  h.children[0].emit("exit", 1, null);
  assert.equal(h.source._attempt, 1);
  await sleep(15);
  h.children[1].emit("exit", 1, null);
  assert.equal(h.source._attempt, 2);
  await sleep(30);
  h.children[2].emit("message", { type: "status", state: "ready", detail: { user: "reader", guilds: 3, missing: [] } });
  await sleep(0);
  assert.equal(h.source._attempt, 0);
  await h.source.stopListening().catch(() => {});
});

test("fatal: a rejected token stops the reader for good and reports it", async () => {
  const h = harness({ sources: [fakeSource(CH_CLASSIC)] });
  await h.source.connect();
  await h.source.startListening();
  h.children[0].emit("message", { type: "status", state: "fatal", detail: "login failed: An invalid token was provided." });
  await sleep(0);
  h.children[0].emit("exit", FATAL_EXIT_CODE, null);
  await sleep(30);
  assert.equal(h.forks.length, 1, "no restart");
  assert.equal(h.source.isListening, false);
  assert.equal(h.emitted.at(-1).name, "error.occurred");
  assert.match(h.logs.at(-1).text, /Fix DISCORD_USER_TOKEN/);
});

test("ready lists channels the account cannot see, by name", async () => {
  const src = fakeSource(CH_CLASSIC);
  const h = harness({ sources: [src] });
  await h.source.connect();
  await h.source.startListening();
  h.children[0].emit("message", { type: "status", state: "ready", detail: { user: "reader", guilds: 3, missing: [CH_CLASSIC] } });
  await sleep(0);
  assert.ok(h.logs.some((l) => l.level === "warning" && l.text.includes(`${src.channel_name} (${CH_CLASSIC})`)));
  await h.source.stopListening().catch(() => {});
});

test("stop: asks the child to shut down and does not restart it", async () => {
  const h = harness({ sources: [fakeSource(CH_CLASSIC)] });
  await h.source.connect();
  await h.source.startListening();
  const child = h.children[0];
  const stopping = h.source.stopListening();
  assert.deepEqual(child.sent.at(-1), { type: "shutdown" });
  child.emit("exit", 0, null);
  await stopping;
  await sleep(30);
  assert.equal(h.forks.length, 1);
  assert.equal(child.killed, 0);
});
