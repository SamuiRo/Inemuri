import selfbot from "discord.js-selfbot-v13";

import { normalizeMessage } from "../discordMessage.js";
import { FATAL_EXIT_CODE, isFatalCloseCode } from "../supervisor.js";

/**
 * Дочірній процес джерела Discord (docs/DISCORD_SOURCE.md): user-акаунт через
 * discord.js-selfbot-v13. Запускає його DiscordSelfSource через fork().
 *
 * Свідомо нічого не імпортує з ядра (конфіг, база, логер): процес має бути
 * легким, а все потрібне приходить від батька через IPC.
 *
 *   батько → дитина  { type: "watch", channelIds }
 *                    { type: "login", token, statsMs, readyTimeoutMs }
 *                    { type: "shutdown" }
 *   дитина → батько  { type: "message", message }        normalizeMessage()
 *                    { type: "status", state, detail }   ready | reconnecting | resumed | fatal
 *                    { type: "stats", stats }
 *                    { type: "log", level, text }
 *
 * Бібліотека заархівована й deprecated (CloakCord ISSUES O1); інтерфейс вище
 * вузький, щоб власний клієнт замінив лише цей файл.
 */

const { Client, Options } = selfbot;

// Для user-акаунта бібліотека ігнорує intents (Intents.ALL), тож Discord шле
// події з УСІХ серверів акаунта. Кожен учасник, що засвітився в будь-якій
// події, осідав у кеші назавжди — це і був витік CloakCord (docs/MEMORY.md
// там). Тепер ці кеші не наповнюються. Себе лишаємо — для guild.members.me.
// GuildManager / ChannelManager / RoleManager бібліотека обмежувати не дає:
// це базовий об'єм, він залежить від кількості серверів акаунта.
const isSelf = (entity) => entity.id === entity.client.user?.id;

const CLIENT_OPTIONS = {
  checkUpdate: false,
  makeCache: Options.cacheWithLimits({
    ...Options.defaultMakeCacheSettings, // архівні треди чистяться раз на годину
    MessageManager: 0,
    // maxSize 1, а не 0: при 0 LimitedCollection ігнорує keepOverLimit.
    GuildMemberManager: { maxSize: 1, keepOverLimit: isSelf },
    UserManager: { maxSize: 1, keepOverLimit: isSelf },
    PresenceManager: 0,
    VoiceStateManager: 0,
    ReactionManager: 0,
    ReactionUserManager: 0,
    ThreadMemberManager: 0,
    GuildBanManager: 0,
    GuildInviteManager: 0,
    StageInstanceManager: 0,
  }),
};

const MB = 1024 * 1024;

let client = null;
let watched = new Set();
let statsTimer = null;
let exiting = false;
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
  try {
    client?.destroy();
  } catch {
    // уже зруйнований — байдуже, процес однаково виходить
  }
  // Дати IPC дописати останнє повідомлення.
  setTimeout(() => process.exit(code), 100);
}

function collectStats() {
  const mem = process.memoryUsage();
  let members = 0;
  for (const guild of client.guilds.cache.values()) members += guild.members.cache.size;
  return {
    uptimeMin: (Date.now() - startedAt) / 60_000,
    rssMb: mem.rss / MB,
    heapMb: mem.heapUsed / MB,
    guilds: client.guilds.cache.size,
    channels: client.channels.cache.size,
    users: client.users.cache.size,
    members,
    events: counters.events,
    watched: watched.size,
    visible: [...watched].filter((id) => client.channels.cache.has(id)).length,
    seen: counters.seen,
  };
}

function onMessage(message) {
  counters.events++;
  if (!watched.has(message.channelId)) return; // найчастіший випадок — без логів
  counters.seen++;
  send({ type: "message", message: normalizeMessage(message) });
}

async function login({ token, statsMs, readyTimeoutMs }) {
  if (client) return;
  client = new Client(CLIENT_OPTIONS);

  client.on("messageCreate", (message) => {
    try {
      onMessage(message);
    } catch (error) {
      log(`message ${message?.id} dropped: ${error.message}`, "warning");
    }
  });
  // EventEmitter без слухача "error" валить процес.
  client.on("error", (error) => log(`client error: ${error.message}`, "warning"));
  // shardDisconnect бібліотека шле, лише коли сама вже не перепідключатиметься
  // (WebSocketManager: 4004, 4010–4014) або коли клієнт знищено; звичайний
  // обрив — це shardReconnecting. Отже, тут клієнт мертвий: вийти.
  client.on("shardDisconnect", (event) => {
    if (exiting) return;
    const fatal = isFatalCloseCode(event?.code);
    send({
      type: "status",
      state: fatal ? "fatal" : "reconnecting",
      detail: fatal ? `gateway closed with ${event.code} — the token is no longer accepted` : `gateway closed (${event?.code ?? "?"})`,
    });
    exit(fatal ? FATAL_EXIT_CODE : 1);
  });
  client.on("shardReconnecting", () => send({ type: "status", state: "reconnecting", detail: null }));
  client.on("shardResume", () => send({ type: "status", state: "resumed", detail: null }));

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no READY within ${Math.round(readyTimeoutMs / 1000)}s`)), readyTimeoutMs);
    client.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  try {
    await client.login(token);
  } catch (error) {
    // Невалідний токен — повтор не допоможе; мережа — допоможе, але з
    // login() їх не розрізнити надійно, крім коду бібліотеки.
    const fatal = error?.code === "TOKEN_INVALID" || /token/i.test(String(error?.message));
    send({ type: "status", state: fatal ? "fatal" : "reconnecting", detail: `login failed: ${error.message}` });
    exit(fatal ? FATAL_EXIT_CODE : 1);
    return;
  }

  try {
    await ready;
  } catch (error) {
    log(error.message, "warning");
    exit(1);
    return;
  }

  send({
    type: "status",
    state: "ready",
    detail: {
      user: client.user?.username ?? null,
      guilds: client.guilds.cache.size,
      missing: [...watched].filter((id) => !client.channels.cache.has(id)),
    },
  });
  statsTimer = setInterval(() => send({ type: "stats", stats: collectStats() }), statsMs);
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

// Батько помер чи закрив канал — не лишатися сиротою з відкритою сесією.
process.on("disconnect", () => exit(0));

// Падіння тут — лише цього процесу: батько перезапустить.
process.on("uncaughtException", (error) => {
  log(`uncaught: ${error.stack ?? error.message}`, "error");
  exit(1);
});
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${reason?.stack ?? reason}`, "error");
  exit(1);
});
