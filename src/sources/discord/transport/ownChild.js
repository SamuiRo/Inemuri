import {
  GatewayClient, resolveClientIdentity, guildsToSubscribe,
} from "../../../lib/discord-user-client/index.js";
import { fromRawMessage } from "../discordMessage.js";
import { FATAL_EXIT_CODE } from "../supervisor.js";

/**
 * Дочірній процес джерела Discord на власному клієнті
 * (src/lib/discord-user-client). Той самий IPC, що й у selfbotChild.js —
 * батько не знає, який транспорт працює (DISCORD_SOURCE_TRANSPORT):
 *
 *   батько → дитина  watch · login · shutdown
 *   дитина → батько  message · status · stats · log
 *
 * Кешу немає: з READY лишаються id серверів і їхніх каналів, з потоку —
 * лише повідомлення з відстежуваних каналів.
 */

const MB = 1024 * 1024;

let client = null;
let watched = new Set();
let statsTimer = null;
let readyTimer = null;
let exiting = false;
const guilds = new Map(); // id → { name, memberCount, channelIds }
const counters = { events: 0, seen: 0 };
const startedAt = Date.now();

function send(msg) {
  if (process.connected) process.send(msg);
}

function log(text, level = "info") {
  send({ type: "log", level, text });
}

function exit(code) {
  if (exiting) return;
  exiting = true;
  if (statsTimer) clearInterval(statsTimer);
  if (readyTimer) clearTimeout(readyTimer);
  try {
    client?.close();
  } catch {
    // уже закритий — процес однаково виходить
  }
  setTimeout(() => process.exit(code), 100);
}

function visibleChannels() {
  const ids = new Set();
  for (const g of guilds.values()) for (const id of g.channelIds) ids.add(id);
  return ids;
}

function collectStats() {
  const mem = process.memoryUsage();
  const visible = visibleChannels();
  return {
    uptimeMin: (Date.now() - startedAt) / 60_000,
    rssMb: mem.rss / MB,
    heapMb: mem.heapUsed / MB,
    guilds: guilds.size,
    channels: visible.size,
    users: 0,
    members: 0,
    events: counters.events,
    watched: watched.size,
    visible: [...watched].filter((id) => visible.has(id)).length,
    seen: counters.seen,
  };
}

function rememberGuild(g) {
  if (g.unavailable) return;
  guilds.set(g.id, { name: g.name, memberCount: g.memberCount, channelIds: g.channelIds });
}

/** Сервери від 75k учасників не шлють MESSAGE_CREATE без підписки (op 37). */
function subscribeLarge() {
  const list = [...guilds].map(([id, g]) => ({ id, ...g }));
  const fresh = client.subscribe(guildsToSubscribe(list, watched));
  if (fresh.length) log(`subscribed to ${fresh.length} large server(s) with watched channels`, "info");
}

async function login({ token, statsMs, readyTimeoutMs }) {
  if (client) return;
  const identity = await resolveClientIdentity({ log });
  log(`client build ${identity.buildNumber}, Chrome ${identity.chromeMajor}`, "debug");

  client = new GatewayClient({ token, identity, log });
  client.on("ready", (ready) => {
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
    guilds.clear();
    for (const g of ready.guilds) rememberGuild(g);
    const visible = visibleChannels();
    send({
      type: "status",
      state: "ready",
      detail: {
        user: ready.user.username,
        guilds: ready.guilds.length,
        missing: [...watched].filter((id) => !visible.has(id)),
      },
    });
    subscribeLarge();
    if (!statsTimer) statsTimer = setInterval(() => send({ type: "stats", stats: collectStats() }), statsMs);
  });
  client.on("guild", (g) => {
    rememberGuild(g);
    subscribeLarge();
  });
  client.on("message", (raw) => {
    counters.events++;
    if (!watched.has(String(raw?.channel_id))) return; // найчастіший випадок — без розбору
    counters.seen++;
    try {
      send({ type: "message", message: fromRawMessage(raw) });
    } catch (error) {
      log(`message ${raw?.id} dropped: ${error.message}`, "warning");
    }
  });
  client.on("resumed", () => send({ type: "status", state: "resumed", detail: null }));
  client.on("reconnecting", ({ code, resume, delayMs }) => send({
    type: "status",
    state: "reconnecting",
    detail: `${code == null ? "requested by the gateway" : `closed ${code}`}, ${resume ? "resume" : "new session"} in ${Math.round(delayMs / 1000)}s`,
  }));
  client.on("fatal", ({ reason }) => {
    send({ type: "status", state: "fatal", detail: reason });
    exit(FATAL_EXIT_CODE);
  });

  readyTimer = setTimeout(() => {
    log(`no READY within ${Math.round(readyTimeoutMs / 1000)}s`, "warning");
    exit(1);
  }, readyTimeoutMs);
  client.connect();
}

process.on("message", (msg) => {
  switch (msg?.type) {
    case "watch":
      watched = new Set((msg.channelIds ?? []).map(String));
      break;
    case "login":
      login(msg).catch((error) => {
        log(`login crashed: ${error.message}`, "error");
        exit(1);
      });
      break;
    case "shutdown":
      exit(0);
      break;
  }
});

process.on("disconnect", () => exit(0));
process.on("uncaughtException", (error) => {
  log(`uncaught: ${error.stack ?? error.message}`, "error");
  exit(1);
});
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${reason?.stack ?? reason}`, "error");
  exit(1);
});
