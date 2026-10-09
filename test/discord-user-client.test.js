import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { EventEmitter } from "node:events";

import {
  OP, CAPABILITIES, gatewayUrl, closeAction, reconnectDelayMs, decide,
  identifyPacket, guildSummary, readySummary, guildsToSubscribe, subscribePacket,
} from "../src/lib/discord-user-client/protocol.js";
import {
  parseBuildNumber, parseChromeMajor, chromeUserAgent, launchSignature,
  superProperties, gatewayProperties, encodeSuperProperties,
} from "../src/lib/discord-user-client/properties.js";
import { messagesPath, requestHeaders, parseRateLimit } from "../src/lib/discord-user-client/rest.js";
import { ZlibStream } from "../src/lib/discord-user-client/ZlibStream.js";
import { RestClient } from "../src/lib/discord-user-client/RestClient.js";
import { GatewayClient } from "../src/lib/discord-user-client/GatewayClient.js";

const LIB_DIR = new URL("../src/lib/discord-user-client/", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Межа модуля ──────────────────────────────────────────────────────

// Модуль має виноситися в окремий пакет без змін: лише свої файли, node: і ws.
test("discord-user-client imports only its own files, node: built-ins and ws", () => {
  const offenders = [];
  for (const name of fs.readdirSync(LIB_DIR).filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(new URL(name, LIB_DIR), "utf8");
    for (const [, spec] of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) {
      const ok = spec.startsWith("node:") || spec === "ws" || (spec.startsWith("./") && !spec.includes(".."));
      if (!ok) offenders.push(`${name}: ${spec}`);
    }
    if (/process\.env\b/.test(text)) offenders.push(`${name}: reads the environment`);
  }
  assert.deepEqual(offenders, []);
});

// ── Протокол ─────────────────────────────────────────────────────────

const ctx = { token: "tok", properties: { os: "Windows" }, random: () => 0.5 };

test("capabilities are the web client's minus auth_token_refresh", () => {
  assert.equal(CAPABILITIES, 22269);
  assert.equal(CAPABILITIES & (1 << 8), 0);
  assert.equal(gatewayUrl("wss://gateway.discord.gg/"), "wss://gateway.discord.gg/?v=9&encoding=json&compress=zlib-stream");
});

test("closeAction: fatal, identify, resume, stop", () => {
  assert.equal(closeAction(4004), "fatal");
  assert.equal(closeAction(4014), "fatal");
  assert.equal(closeAction(4007), "identify");
  assert.equal(closeAction(4009), "identify");
  for (const code of [1000, 1001, 1006, 4000, 4008]) assert.equal(closeAction(code), "resume", String(code));
  assert.equal(closeAction(4004, { intentional: true }), "stop");
  assert.deepEqual([1, 2, 3, 9].map((n) => reconnectDelayMs(n, { baseMs: 1000, capMs: 5000 })), [1000, 2000, 4000, 5000]);
});

test("decide HELLO: heartbeat timer, a QoS heartbeat, then IDENTIFY — or RESUME with a session", () => {
  const fresh = decide({ mode: "identify", sessionId: null, seq: null }, { op: OP.HELLO, d: { heartbeat_interval: 41250 } }, ctx);
  assert.deepEqual(fresh.actions.map((a) => a.type), ["heartbeat", "send", "send"]);
  assert.equal(fresh.actions[0].intervalMs, 41250);
  assert.equal(fresh.actions[1].packet.op, OP.QOS_HEARTBEAT);
  assert.deepEqual(fresh.actions[1].packet.d.qos, { ver: 27, active: true, reasons: ["foregrounded"] });
  assert.deepEqual(fresh.actions[2].packet, identifyPacket(ctx));
  assert.equal(fresh.actions[2].packet.d.compress, false);
  assert.deepEqual(fresh.actions[2].packet.d.client_state, { guild_versions: {} });

  const resumed = decide({ mode: "resume", sessionId: "s1", seq: 42 }, { op: OP.HELLO, d: { heartbeat_interval: 1 } }, ctx);
  assert.deepEqual(resumed.actions[2].packet, { op: OP.RESUME, d: { token: "tok", session_id: "s1", seq: 42 } });
});

test("decide: READY keeps the session, INVALID_SESSION false drops it, RECONNECT resumes, seq follows", () => {
  const ready = decide({ mode: "identify", seq: null }, {
    op: 0, t: "READY", s: 1,
    d: { session_id: "s1", resume_gateway_url: "wss://r.example", user: { id: "1", username: "u" }, guilds: [] },
  }, ctx);
  assert.deepEqual(ready.state, { mode: "resume", seq: 1, sessionId: "s1", resumeUrl: "wss://r.example" });
  assert.deepEqual(ready.actions.map((a) => a.type), ["ready", "after-ready"]);

  const invalid = decide(ready.state, { op: OP.INVALID_SESSION, d: false }, ctx);
  assert.equal(invalid.state.sessionId, null);
  assert.deepEqual(invalid.actions, [{ type: "reconnect", resume: false, delayMs: 3000 }]);
  assert.deepEqual(decide(ready.state, { op: OP.INVALID_SESSION, d: true }, ctx).actions, [{ type: "reconnect", resume: true, delayMs: 0 }]);
  assert.deepEqual(decide(ready.state, { op: OP.RECONNECT }, ctx).actions, [{ type: "reconnect", resume: true, delayMs: 0 }]);
  assert.deepEqual(decide({ seq: 5 }, { op: OP.HEARTBEAT }, ctx).actions[0].packet, { op: OP.HEARTBEAT, d: 5 });

  const msg = decide(ready.state, { op: 0, t: "MESSAGE_CREATE", s: 7, d: { id: "m" } }, ctx);
  assert.equal(msg.state.seq, 7);
  assert.deepEqual(msg.actions, [{ type: "message", message: { id: "m" } }]);
  assert.deepEqual(decide(ready.state, { op: 0, t: "TYPING_START", s: 8, d: {} }, ctx).actions, []);
});

test("guilds: summary from READY (properties) and GUILD_CREATE; only large guilds with watched channels are subscribed", () => {
  const big = { id: 1, properties: { name: "Big" }, member_count: 120_000, channels: [{ id: 11 }], threads: [{ id: 12 }] };
  const small = { id: 2, name: "Small", member_count: 300, channels: [{ id: 21 }] };
  const other = { id: 3, name: "Other", member_count: 90_000, channels: [{ id: 31 }] };
  const r = readySummary({ session_id: "s", user: { id: 9, username: "me" }, guilds: [big, small, other] });
  assert.deepEqual(r.guilds[0], { id: "1", name: "Big", memberCount: 120_000, unavailable: false, channelIds: ["11", "12"] });
  assert.equal(guildSummary({ id: 4, unavailable: true }).unavailable, true);
  assert.deepEqual(guildsToSubscribe(r.guilds, ["11", "21"]), ["1"]);
  assert.deepEqual(Object.keys(subscribePacket(["1"]).d.subscriptions), ["1"]);
  assert.equal(subscribePacket(["1"]).d.subscriptions["1"].typing, true);
});

// ── Властивості клієнта ──────────────────────────────────────────────

test("properties: build number, Chrome version, user agent, launch signature, encoding", () => {
  assert.equal(parseBuildNumber('...window.GLOBAL_ENV={"BUILD_NUMBER": "456789",...'), 456789);
  assert.equal(parseBuildNumber("<html></html>"), null);
  assert.equal(parseChromeMajor({ versions: [{ version: "141.0.7390.55" }] }), 141);
  assert.equal(parseChromeMajor({}), null);
  assert.equal(chromeUserAgent(141), "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36");

  const sig = launchSignature(new Uint8Array(16).fill(0xff));
  assert.match(sig, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(sig, "ffffffff-ffff-ffff-ffff-ffffffffffff", "masked bits are zero");
  assert.equal(launchSignature(new Uint8Array(16)), "00000000-0000-0000-0000-000000000000");

  const props = superProperties({ buildNumber: 456789, chromeMajor: 141, launchId: "L", heartbeatSessionId: "H", signature: sig });
  assert.equal(props.client_build_number, 456789);
  assert.equal(props.browser_version, "141.0.0.0");
  assert.deepEqual(JSON.parse(Buffer.from(encodeSuperProperties(props), "base64").toString()), props);
  assert.equal(gatewayProperties(props).gateway_connect_reasons, "AppSkeleton");
});

// ── zlib-stream ──────────────────────────────────────────────────────

test("ZlibStream: one context across messages, partial frames wait for the sync-flush suffix", async () => {
  const deflate = zlib.createDeflate();
  const chunks = [];
  deflate.on("data", (c) => chunks.push(c));
  const wire = async (text) => {
    chunks.length = 0;
    await new Promise((r) => { deflate.write(text); deflate.flush(zlib.constants.Z_SYNC_FLUSH, r); });
    return Buffer.concat(chunks);
  };
  const inflater = new ZlibStream();
  const big = JSON.stringify({ t: "READY", d: { pad: "x".repeat(100_000) } });
  const f1 = await wire('{"op":10}');
  const f2 = await wire(big);
  assert.equal(await inflater.push(f1), '{"op":10}');
  const half = Math.floor(f2.length / 2);
  assert.equal(await inflater.push(f2.subarray(0, half)), null);
  assert.equal(await inflater.push(f2.subarray(half)), big);
  inflater.close();
});

// ── REST ─────────────────────────────────────────────────────────────

test("rest: messages path, headers, rate limits", () => {
  assert.equal(messagesPath("123", { before: "99", limit: 500 }), "/channels/123/messages?before=99&limit=100");
  assert.equal(messagesPath("123"), "/channels/123/messages?limit=50");
  const h = requestHeaders({ token: "tok", identity: { userAgent: "UA", encodedSuperProperties: "e30=", locale: "en-US" }, timeZone: "Europe/Kyiv" });
  assert.equal(h.authorization, "tok");
  assert.equal(h["x-super-properties"], "e30=");
  assert.equal(h["x-discord-timezone"], "Europe/Kyiv");

  const none = () => null;
  assert.deepEqual(parseRateLimit(429, none, { retry_after: 1.5, global: false }), { limited: true, retryAfterMs: 1500, global: false, remaining: 0, resetAfterMs: null });
  assert.equal(parseRateLimit(429, (n) => (n === "retry-after" ? "3" : null), null).retryAfterMs, 3000);
  const ok = parseRateLimit(200, (n) => ({ "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "2.2" })[n] ?? null);
  assert.deepEqual(ok, { limited: false, retryAfterMs: 0, global: false, remaining: 0, resetAfterMs: 2200 });
});

const identity = { userAgent: "UA", encodedSuperProperties: "e30=", locale: "en-US" };
const response = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  json: async () => body,
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
});

test("RestClient: one request at a time, waits out 429, keeps a gap between requests", async () => {
  let t = 0;
  const slept = [];
  const calls = [];
  const replies = [response(429, { retry_after: 2 }), response(200, [{ id: "1" }]), response(200, { id: "c", name: "news" })];
  const rest = new RestClient({
    token: "tok", identity, minGapMs: 1000, timeZone: "UTC",
    now: () => t,
    sleep: async (ms) => { slept.push(ms); t += ms; },
    fetch: async (url, opts) => { calls.push({ url, auth: opts.headers.authorization }); return replies.shift(); },
  });
  const [messages, channel] = await Promise.all([rest.messages("c", { limit: 10 }), rest.channel("c")]);
  assert.deepEqual(messages, [{ id: "1" }]);
  assert.equal(channel.name, "news");
  assert.deepEqual(calls.map((c) => c.url), [
    "https://discord.com/api/v9/channels/c/messages?limit=10",
    "https://discord.com/api/v9/channels/c/messages?limit=10",
    "https://discord.com/api/v9/channels/c",
  ]);
  assert.equal(calls[0].auth, "tok");
  assert.deepEqual(slept, [2000, 1000]);
});

test("RestClient: an error status throws with the API message", async () => {
  const rest = new RestClient({ token: "t", identity, minGapMs: 0, fetch: async () => response(403, { message: "Missing Access", code: 50001 }) });
  await assert.rejects(rest.messages("c"), (e) => e.status === 403 && e.code === 50001 && /Missing Access/.test(e.message));
});

// ── Gateway з фальшивим сокетом ──────────────────────────────────────

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 1;
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  close(code) {
    this.readyState = 3;
    this.emit("close", code);
  }
  receive(packet) { this.emit("message", Buffer.from(JSON.stringify(packet)), false); }
}

function gateway() {
  FakeSocket.instances = [];
  const events = [];
  const client = new GatewayClient({
    token: "tok",
    identity: {
      userAgent: "UA", initializedAt: 123, gatewayProperties: { os: "Windows" },
      superProperties: { client_heartbeat_session_id: "H", client_launch_id: "L" },
    },
    reconnect: { baseMs: 5, capMs: 20 },
    WebSocketImpl: FakeSocket,
    random: () => 0,
  });
  for (const name of ["ready", "guild", "message", "resumed", "reconnecting", "fatal", "closed"]) {
    client.on(name, (data) => events.push({ name, data }));
  }
  return { client, events };
}

test("GatewayClient: identify, READY → time spent, heartbeat, op 4; messages; subscribe once", async () => {
  const { client, events } = gateway();
  client.connect();
  const ws = FakeSocket.instances[0];
  assert.match(ws.url, /^wss:\/\/gateway\.discord\.gg\/\?v=9&encoding=json&compress=zlib-stream$/);
  assert.equal(ws.opts.headers["user-agent"], "UA");

  ws.receive({ op: OP.HELLO, d: { heartbeat_interval: 60_000 } });
  await sleep(0);
  assert.deepEqual(ws.sent.map((p) => p.op), [OP.QOS_HEARTBEAT, OP.IDENTIFY]);
  assert.equal(ws.sent[1].d.token, "tok");

  ws.receive({ op: OP.HEARTBEAT_ACK });
  ws.receive({ op: 0, t: "READY", s: 1, d: { session_id: "s1", resume_gateway_url: "wss://resume.example", user: { id: "9", username: "me" }, guilds: [{ id: "1", name: "G", member_count: 100_000, channels: [{ id: "11" }] }] } });
  await sleep(0);
  assert.deepEqual(ws.sent.slice(2).map((p) => p.op), [OP.UPDATE_TIME_SPENT, OP.QOS_HEARTBEAT, OP.VOICE_STATE]);
  assert.deepEqual(ws.sent[2].d, { initialization_timestamp: 123, session_id: "H", client_launch_id: "L" });
  assert.equal(events[0].name, "ready");
  assert.deepEqual(events[0].data.guilds[0].channelIds, ["11"]);

  ws.receive({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "m1", channel_id: "11" } });
  await sleep(0);
  assert.deepEqual(events.at(-1), { name: "message", data: { id: "m1", channel_id: "11" } });

  assert.deepEqual(client.subscribe(["1"]), ["1"]);
  assert.deepEqual(client.subscribe(["1"]), []);
  assert.equal(ws.sent.at(-1).op, OP.BULK_GUILD_SUBSCRIBE);

  client.close();
  await sleep(0);
  assert.equal(events.at(-1).name, "closed");
});

test("GatewayClient: a dropped connection resumes on resume_gateway_url; 4004 is fatal", async () => {
  const { client, events } = gateway();
  client.connect();
  const ws = FakeSocket.instances[0];
  ws.receive({ op: OP.HELLO, d: { heartbeat_interval: 60_000 } });
  ws.receive({ op: 0, t: "READY", s: 5, d: { session_id: "s1", resume_gateway_url: "wss://resume.example", user: { id: "9" }, guilds: [] } });
  await sleep(0);

  ws.close(1006);
  assert.deepEqual(events.at(-1), { name: "reconnecting", data: { code: 1006, resume: true, delayMs: 5 } });
  await sleep(15);
  const ws2 = FakeSocket.instances[1];
  assert.match(ws2.url, /^wss:\/\/resume\.example\/\?v=9/);
  ws2.receive({ op: OP.HELLO, d: { heartbeat_interval: 60_000 } });
  await sleep(0);
  assert.deepEqual(ws2.sent[1], { op: OP.RESUME, d: { token: "tok", session_id: "s1", seq: 5 } });

  ws2.close(4004);
  assert.equal(events.at(-1).name, "fatal");
  await sleep(30);
  assert.equal(FakeSocket.instances.length, 2, "no reconnect after a fatal close");
});

test("GatewayClient: a missed heartbeat ACK closes the zombie connection and resumes", async () => {
  const { client, events } = gateway();
  client.connect();
  const ws = FakeSocket.instances[0];
  ws.receive({ op: OP.HELLO, d: { heartbeat_interval: 10 } });
  ws.receive({ op: 0, t: "READY", s: 1, d: { session_id: "s1", resume_gateway_url: null, user: { id: "9" }, guilds: [] } });
  await sleep(25); // жодного ACK
  assert.equal(ws.readyState, 3);
  assert.equal(events.find((e) => e.name === "reconnecting").data.code, 4000);
  client.close();
});
