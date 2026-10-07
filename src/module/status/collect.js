import { Source, SourceState } from "../teapot/models/index.js";
import { copyDestinations } from "../../shared/destinations.js";

/**
 * Збір знімка для статус-борду. Окремо від StatusBoard, щоб той лишався без
 * бази й мережі: тут — читання джерел і опитування адаптерів.
 */

/** Активні джерела з часом останньої публікації (source_states.last_seen_at). */
export async function collectSources({ SourceModel = Source, StateModel = SourceState } = {}) {
  const sources = await SourceModel.findAll({ where: { is_active: true } });
  const states = await StateModel.findAll({ attributes: ["source_id", "last_seen_at"] });
  const seen = new Map(states.map((s) => [s.source_id, s.last_seen_at]));
  return sources.map((s) => ({
    id: s.id,
    name: s.channel_name ?? s.channel_id,
    platform: s.platform ?? "telegram",
    lastSeenAt: seen.get(s.id) ? new Date(seen.get(s.id)) : null,
  }));
}

/**
 * Канали, куди Inemuri доставляє: призначення активних джерел (класичний
 * форвардинг) і з routing.json (unsorted, правила, дайджест). Без
 * status_destinations — у статус-каналі нових повідомлень не буває, лише
 * правка, тож він завжди виглядав би «мовчазним» — і без health_destinations:
 * алерти там рідкісні за задумом.
 *
 * @returns {Array<{ platform: string, id: string }>}
 */
export function deliveryChannels({ sources = [], routing = {} }) {
  const out = new Map();
  const add = (destinations) => {
    for (const [platform, ids] of Object.entries(copyDestinations(destinations))) {
      for (const id of ids) out.set(`${platform}:${id}`, { platform, id });
    }
  };
  for (const s of sources) add(s.destinations);
  add(routing.unsorted_destinations);
  add(routing.digest_destinations);
  for (const rule of Array.isArray(routing.routing) ? routing.routing : []) add(rule?.destinations);

  const skip = new Set();
  for (const field of ["status_destinations", "health_destinations"]) {
    for (const [platform, ids] of Object.entries(copyDestinations(routing[field]))) {
      for (const id of ids) skip.add(`${platform}:${id}`);
    }
  }
  return [...out.entries()].filter(([key]) => !skip.has(key)).map(([, ch]) => ch);
}

/**
 * Опитати канали через адаптери. Невдача одного каналу (немає доступу,
 * видалений) — рядок з `error`, а не зупинка всього борду.
 *
 * @param {Array<{ platform: string, id: string }>} channels
 * @param {(platform: string) => { describeChannel?: Function }|undefined} adapterFor
 */
export async function collectChannels(channels, adapterFor) {
  const out = [];
  for (const ch of channels) {
    const adapter = adapterFor(ch.platform);
    if (typeof adapter?.describeChannel !== "function") continue;
    try {
      const { name, lastActivityAt } = await adapter.describeChannel(ch.id);
      out.push({ ...ch, name, lastActivityAt });
    } catch (error) {
      out.push({ ...ch, name: null, lastActivityAt: null, error: String(error.message).slice(0, 120) });
    }
  }
  return out;
}

/** Повний знімок для StatusBoard. */
export async function collectStatus({ routing, adapterFor, SourceModel = Source, StateModel = SourceState }) {
  const sources = await collectSources({ SourceModel, StateModel });
  const active = await SourceModel.findAll({ where: { is_active: true }, attributes: ["id", "destinations"] });
  const channels = await collectChannels(deliveryChannels({ sources: active, routing }), adapterFor);
  return { sources, channels };
}
