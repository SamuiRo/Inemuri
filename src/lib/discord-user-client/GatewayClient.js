import { EventEmitter } from "node:events";
import WebSocket from "ws";

import {
  DEFAULT_GATEWAY, CAPABILITIES, TIME_SPENT_INTERVAL_MS,
  gatewayUrl, closeAction, reconnectDelayMs, decide,
  heartbeatPacket, timeSpentPacket, voiceStatePacket, subscribePacket,
} from "./protocol.js";
import { ZlibStream } from "./ZlibStream.js";

/**
 * Gateway-клієнт user-акаунта без кешу: зі всього потоку тримає лише стан
 * сесії (id, seq, адреса для resume), решту віддає подіями й забуває.
 * Рішення — у protocol.js (decide), тут лише сокет і таймери.
 *
 * Події:
 *   ready      { sessionId, user, guilds: [{ id, name, memberCount, channelIds }] }
 *   guild      { id, name, memberCount, channelIds }   (GUILD_CREATE)
 *   message    сирий об'єкт MESSAGE_CREATE
 *   resumed
 *   reconnecting { code, resume, delayMs }
 *   fatal      { code, reason }   — далі не підключається
 *   closed                          — після close()
 */
export class GatewayClient extends EventEmitter {
  /**
   * @param {{
   *   token: string,
   *   identity: { gatewayProperties: object, userAgent: string, initializedAt: number,
   *               superProperties: { client_heartbeat_session_id: string, client_launch_id: string } },
   *   capabilities?: number,
   *   gateway?: string,
   *   reconnect?: { baseMs: number, capMs: number },
   *   WebSocketImpl?: typeof WebSocket,
   *   random?: () => number,
   *   log?: (text: string, level?: string) => void,
   * }} opts
   */
  constructor({
    token, identity, capabilities = CAPABILITIES, gateway = DEFAULT_GATEWAY,
    reconnect = { baseMs: 1_000, capMs: 60_000 }, WebSocketImpl = WebSocket, random = Math.random,
    log = () => {},
  }) {
    super();
    this.token = token;
    this.identity = identity;
    this.capabilities = capabilities;
    this.gateway = gateway;
    this.reconnectPolicy = reconnect;
    this.WebSocketImpl = WebSocketImpl;
    this.random = random;
    this.log = log;

    this.state = { mode: "identify", sessionId: null, resumeUrl: null, seq: null };
    this.ws = null;
    this._inflater = null;
    this._heartbeatTimer = null;
    this._timeSpentTimer = null;
    this._reconnectTimer = null;
    this._awaitingAck = false;
    this._attempt = 0;
    this._closing = false;
    this._subscribed = new Set();
  }

  connect() {
    this._closing = false;
    this._open();
  }

  /** Закрити назавжди (зупинка процесу). */
  close() {
    this._closing = true;
    this._stopTimers();
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (this.ws) this.ws.close(1000);
    else this.emit("closed");
  }

  /**
   * Підписатися на сервери (op 37). Запам'ятовується: після нового IDENTIFY
   * підписки треба повторити — це робить after-ready.
   */
  subscribe(guildIds) {
    const fresh = guildIds.map(String).filter((id) => !this._subscribed.has(id));
    for (const id of fresh) this._subscribed.add(id);
    if (fresh.length) this._send(subscribePacket(fresh));
    return fresh;
  }

  // ── Сокет ──────────────────────────────────────────────────────────

  _open() {
    const base = this.state.mode === "resume" && this.state.resumeUrl ? this.state.resumeUrl : this.gateway;
    const ws = new this.WebSocketImpl(gatewayUrl(base), {
      // Без Origin: з `Origin: https://discord.com` Cloudflare відповідає на
      // рукостискання 403 (перевірено 2026-10-09) — схоже, звіряє його з
      // TLS-відбитком, а відбиток Node не браузерний.
      headers: { "user-agent": this.identity.userAgent },
      perMessageDeflate: false,
    });
    this.ws = ws;
    this._inflater?.close();
    const inflater = new ZlibStream();
    this._inflater = inflater;

    ws.on("message", (data, isBinary) => {
      const text = isBinary ? inflater.push(data) : Promise.resolve(String(data));
      text.then((t) => t && this._handle(JSON.parse(t))).catch((error) => {
        this.log(`gateway: bad frame (${error.message}) — reconnecting`, "warning");
        ws.close(4000);
      });
    });
    ws.on("close", (code) => this._onClose(ws, code));
    ws.on("error", (error) => this.log(`gateway: socket error: ${error.message}`, "warning"));
  }

  _send(packet) {
    if (this.ws?.readyState === this.WebSocketImpl.OPEN) this.ws.send(JSON.stringify(packet));
  }

  _handle(packet) {
    const { state, actions } = decide(this.state, packet, {
      token: this.token, properties: this.identity.gatewayProperties,
      capabilities: this.capabilities, random: this.random,
    });
    this.state = state;
    for (const action of actions) this._run(action);
  }

  _run(action) {
    switch (action.type) {
      case "send":
        if (action.packet.op === heartbeatPacket(null).op) this._awaitingAck = true;
        this._send(action.packet);
        break;
      case "heartbeat":
        this._startHeartbeat(action.intervalMs);
        break;
      case "ack":
        this._awaitingAck = false;
        break;
      case "reconnect":
        this._reconnect({ resume: action.resume, delayMs: action.delayMs, code: null });
        break;
      case "ready":
        this._attempt = 0;
        this._subscribed.clear(); // нова сесія — підписки з нуля
        this.emit("ready", action.ready);
        break;
      case "after-ready":
        this._afterReady();
        break;
      case "resumed":
        this._attempt = 0;
        this.emit("resumed");
        break;
      case "guild":
        this.emit("guild", action.guild);
        break;
      case "message":
        this.emit("message", action.message);
        break;
      default:
        break;
    }
  }

  /** Після READY клієнт одразу шле час сесії, heartbeat і op 4. */
  _afterReady() {
    const timeSpent = () => this._send(timeSpentPacket({
      initializedAt: this.identity.initializedAt,
      heartbeatSessionId: this.identity.superProperties.client_heartbeat_session_id,
      launchId: this.identity.superProperties.client_launch_id,
    }));
    timeSpent();
    this._run({ type: "send", packet: heartbeatPacket(this.state.seq) });
    this._send(voiceStatePacket());
    if (this._timeSpentTimer) clearInterval(this._timeSpentTimer);
    this._timeSpentTimer = setInterval(timeSpent, TIME_SPENT_INTERVAL_MS);
    this._timeSpentTimer.unref?.();
  }

  _startHeartbeat(intervalMs) {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      if (this._awaitingAck) {
        // Зомбі-з'єднання: сервер не підтвердив попередній heartbeat.
        this.log("gateway: heartbeat not acknowledged — reconnecting", "warning");
        this.ws?.close(4000);
        return;
      }
      this._run({ type: "send", packet: heartbeatPacket(this.state.seq) });
    }, intervalMs);
    this._heartbeatTimer.unref?.();
  }

  _stopTimers() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    if (this._timeSpentTimer) clearInterval(this._timeSpentTimer);
    this._heartbeatTimer = null;
    this._timeSpentTimer = null;
    this._awaitingAck = false;
  }

  _onClose(ws, code) {
    if (ws !== this.ws) return; // старий сокет, уже замінений
    this.ws = null;
    this._stopTimers();
    const action = closeAction(code, { intentional: this._closing });
    if (action === "stop") {
      this.emit("closed");
      return;
    }
    if (action === "fatal") {
      this.emit("fatal", { code, reason: code === 4004 ? "authentication failed — the token is not accepted" : `gateway closed with ${code}` });
      return;
    }
    if (action === "identify") {
      this.state = { ...this.state, sessionId: null, resumeUrl: null, seq: null };
    }
    this._attempt++;
    this._reconnect({ resume: action === "resume", delayMs: reconnectDelayMs(this._attempt, this.reconnectPolicy), code });
  }

  _reconnect({ resume, delayMs, code }) {
    if (this._closing) return;
    this.state = { ...this.state, mode: resume && this.state.sessionId ? "resume" : "identify" };
    this.emit("reconnecting", { code, resume: this.state.mode === "resume", delayMs });
    if (this.ws) {
      // Сервер просить перепідключитися (op 7/9): закрити поточний сокет без
      // повторного рішення в _onClose — далі веде цей виклик.
      const old = this.ws;
      this.ws = null;
      this._stopTimers();
      old.close(4000);
    }
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closing) this._open();
    }, delayMs);
    // Без unref: поки сокета немає, процес тримає саме цей таймер.
  }
}
