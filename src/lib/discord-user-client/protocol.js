/**
 * Протокол gateway Discord для user-акаунта — чисте ядро (без сокета,
 * таймерів і мережі). Оболонка — GatewayClient.js.
 *
 * Значення взяті з discord.py-self (MIT), бібліотеки, що активно
 * підтримується і першою підхоплює зміни протоколу user-клієнта: беремо
 * знання, не код. Звіряти тут, коли Discord щось змінить:
 *   discord/gateway.py   — опкоди, IDENTIFY, RESUME, heartbeat, READY
 *   discord/flags.py     — Capabilities.default()
 *   discord/state.py     — GuildSubscriptions (сервери від 75k учасників)
 */

export const API_VERSION = 9;
export const DEFAULT_GATEWAY = "wss://gateway.discord.gg";

export const OP = Object.freeze({
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  VOICE_STATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
  BULK_GUILD_SUBSCRIBE: 37,
  // Веб-клієнт б'ється op 40 (QoS), а не op 1; op 1 лишається для відповіді
  // на запит серверу.
  QOS_HEARTBEAT: 40,
  UPDATE_TIME_SPENT: 41,
});

/** Версія QoS-heartbeat (KeepAliveHandler.HEARTBEAT_VERSION). */
export const QOS_VERSION = 27;
/** Як часто клієнт звітує час сесії (op 41). */
export const TIME_SPENT_INTERVAL_MS = 30 * 60_000;
/**
 * На сервери з меншою кількістю учасників клієнт підписаний автоматично;
 * на більші — ні, і MESSAGE_CREATE з них не приходить, доки не підписатися
 * (op 37). Ймовірна причина частини `matched=0` у CloakCord.
 */
export const AUTO_SUBSCRIBE_MAX_MEMBERS = 75_000;

/**
 * Capabilities веб-клієнта (Capabilities.default()) БЕЗ auth_token_refresh
 * (1 << 8): з ним сервер може видати новий токен у READY, а записати його
 * назад у .env нікому — після перезапуску старий токен міг би вже не діяти.
 */
const CAPABILITY_BITS = [
  0, // lazy_user_notes
  2, // versioned_read_states
  3, // versioned_user_guild_settings
  4, // dedupe_user_objects
  5, // prioritized_ready_payload
  6, // multiple_guild_experiment_populations
  7, // non_channel_read_states
  9, // user_settings_proto
  10, // client_state_v2
  12, // auto_call_connect
  14, // passive_guild_update_v2
];
export const CAPABILITIES = CAPABILITY_BITS.reduce((v, bit) => v | (1 << bit), 0);

/** Адреса gateway з параметрами: JSON, стиснення zlib-stream (як у браузера). */
export function gatewayUrl(base = DEFAULT_GATEWAY) {
  return `${String(base).replace(/\/+$/, "")}/?v=${API_VERSION}&encoding=json&compress=zlib-stream`;
}

// ── Закриття ───────────────────────────────────────────────────────────

const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
// Сесію не відновити — лише новий IDENTIFY.
const NO_RESUME_CLOSE = new Set([4007, 4009]);

/**
 * Що робити після закриття сокета.
 *   fatal    — 4004 (токен), 4010–4014: повтор не допоможе;
 *   identify — 4007 (невірний seq), 4009 (сесія застаріла);
 *   stop     — закрили ми самі;
 *   resume   — решта: обрив, 1000/1001 від сервера, 4000 (зомбі-з'єднання).
 */
export function closeAction(code, { intentional = false } = {}) {
  if (intentional) return "stop";
  const c = Number(code);
  if (FATAL_CLOSE.has(c)) return "fatal";
  if (NO_RESUME_CLOSE.has(c)) return "identify";
  return "resume";
}

/** Пауза перед n-м перепідключенням поспіль: base·2^(n-1), не більше cap. */
export function reconnectDelayMs(attempt, { baseMs, capMs }) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  return Math.min(baseMs * 2 ** (n - 1), capMs);
}

// ── Пакети ─────────────────────────────────────────────────────────────

export function identifyPacket({ token, properties, capabilities = CAPABILITIES }) {
  return {
    op: OP.IDENTIFY,
    d: {
      token,
      capabilities,
      properties,
      presence: { status: "unknown", since: 0, activities: [], afk: false },
      // Стиснення вже є на транспорті (zlib-stream); подвійне не потрібне.
      compress: false,
      client_state: { guild_versions: {} },
    },
  };
}

export function resumePacket({ token, sessionId, seq }) {
  return { op: OP.RESUME, d: { token, session_id: sessionId, seq } };
}

export function heartbeatPacket(seq) {
  return { op: OP.QOS_HEARTBEAT, d: { seq, qos: { ver: QOS_VERSION, active: true, reasons: ["foregrounded"] } } };
}

/** Відповідь на op 1 від сервера — класичний heartbeat. */
export function plainHeartbeatPacket(seq) {
  return { op: OP.HEARTBEAT, d: seq };
}

export function timeSpentPacket({ initializedAt, heartbeatSessionId, launchId }) {
  return {
    op: OP.UPDATE_TIME_SPENT,
    d: { initialization_timestamp: initializedAt, session_id: heartbeatSessionId, client_launch_id: launchId },
  };
}

/** Початковий op 4 після READY — так робить клієнт (не в голосовому каналі). */
export function voiceStatePacket() {
  return { op: OP.VOICE_STATE, d: { guild_id: null, channel_id: null, self_mute: false, self_deaf: false, self_video: false } };
}

/** Підписка на сервери (op 37): `typing: true` — «підписаний на сервер». */
export function subscribePacket(guildIds) {
  const subscriptions = {};
  for (const id of guildIds) {
    subscriptions[String(id)] = {
      typing: true, threads: false, activities: false, member_updates: false,
      members: [], thread_member_lists: [], channels: {},
    };
  }
  return { op: OP.BULK_GUILD_SUBSCRIBE, d: { subscriptions } };
}

// ── READY і сервери ────────────────────────────────────────────────────

/**
 * Сервер із READY або GUILD_CREATE → лише те, що потрібно: id, назва,
 * кількість учасників, id каналів і тредів. Решту (ролі, учасники, емодзі)
 * не тримаємо — тому пам'ять клієнта не росте з розміром акаунта.
 * З client_state_v2 назва й інше лежать у `properties`.
 */
export function guildSummary(g) {
  const props = g?.properties ?? g ?? {};
  return {
    id: String(g.id),
    name: props.name ?? null,
    memberCount: Number(g.member_count ?? props.member_count ?? 0) || 0,
    unavailable: g.unavailable === true,
    channelIds: [...(g.channels ?? []), ...(g.threads ?? [])].map((c) => String(c.id)),
  };
}

export function readySummary(d) {
  return {
    sessionId: d.session_id,
    resumeUrl: d.resume_gateway_url ?? null,
    user: { id: String(d.user?.id ?? ""), username: d.user?.username ?? null },
    guilds: (d.guilds ?? []).map(guildSummary),
  };
}

/** Сервери з відстежуваними каналами, на які клієнт сам не підписаний. */
export function guildsToSubscribe(guilds, watchedChannelIds, maxAuto = AUTO_SUBSCRIBE_MAX_MEMBERS) {
  const watched = new Set([...watchedChannelIds].map(String));
  return guilds
    .filter((g) => g.memberCount >= maxAuto && g.channelIds.some((id) => watched.has(id)))
    .map((g) => g.id);
}

// ── Рішення на пакет ───────────────────────────────────────────────────

/**
 * Пакет від gateway → новий стан і дії для оболонки.
 *
 * Стан: { mode: "identify"|"resume", sessionId, resumeUrl, seq }.
 * Дії: { type: "send", packet } · { type: "heartbeat", intervalMs } ·
 *   { type: "ack" } · { type: "reconnect", resume, delayMs } ·
 *   { type: "ready", ready } · { type: "resumed" } · { type: "guild", guild } ·
 *   { type: "message", message } · { type: "after-ready" }.
 *
 * @param {object} state
 * @param {{ op: number, d?: any, s?: number|null, t?: string|null }} packet
 * @param {{ token: string, properties: object, capabilities?: number, random?: () => number }} ctx
 */
export function decide(state, packet, ctx) {
  const next = { ...state };
  if (packet.s != null) next.seq = packet.s;
  const actions = [];

  switch (packet.op) {
    case OP.HELLO:
      actions.push({ type: "heartbeat", intervalMs: packet.d?.heartbeat_interval });
      actions.push({ type: "send", packet: heartbeatPacket(next.seq ?? null) });
      actions.push({
        type: "send",
        packet: next.mode === "resume" && next.sessionId
          ? resumePacket({ token: ctx.token, sessionId: next.sessionId, seq: next.seq })
          : identifyPacket(ctx),
      });
      break;
    case OP.HEARTBEAT_ACK:
      actions.push({ type: "ack" });
      break;
    case OP.HEARTBEAT:
      actions.push({ type: "send", packet: plainHeartbeatPacket(next.seq ?? null) });
      break;
    case OP.RECONNECT:
      actions.push({ type: "reconnect", resume: true, delayMs: 0 });
      break;
    case OP.INVALID_SESSION:
      if (packet.d === true) {
        actions.push({ type: "reconnect", resume: true, delayMs: 0 });
      } else {
        // Нова сесія через випадкові 1–5 с, як радить документація Discord.
        next.sessionId = null;
        next.seq = null;
        next.resumeUrl = null;
        const random = ctx.random ?? Math.random;
        actions.push({ type: "reconnect", resume: false, delayMs: 1000 + Math.floor(random() * 4000) });
      }
      break;
    case OP.DISPATCH:
      actions.push(...dispatchActions(next, packet));
      break;
    default:
      break;
  }
  return { state: next, actions };
}

function dispatchActions(next, packet) {
  switch (packet.t) {
    case "READY": {
      const ready = readySummary(packet.d ?? {});
      next.sessionId = ready.sessionId;
      next.resumeUrl = ready.resumeUrl;
      next.mode = "resume";
      return [{ type: "ready", ready }, { type: "after-ready" }];
    }
    case "RESUMED":
      return [{ type: "resumed" }];
    case "GUILD_CREATE":
      return [{ type: "guild", guild: guildSummary(packet.d ?? {}) }];
    case "MESSAGE_CREATE":
      return [{ type: "message", message: packet.d }];
    default:
      // Решта подій (присутність, typing, учасники…) — не потрібна, і далі
      // за назву її не розбираємо.
      return [];
  }
}
