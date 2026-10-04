/**
 * TheFlow — стадія resolve (ROADMAP §5.2, TAXONOMY.md «How resolve works»).
 *
 * Вердикт моделі (topic, signal_type, confidence) → куди доставляти.
 * Чиста функція без I/O: правила й призначення приходять аргументом, тож
 * її перевіряють як функцію, а не через БД чи адаптери.
 *
 * Правила зі специфікації:
 *   1. правила `routing` оцінюються за спаданням `priority`;
 *   2. перше правило, чий `when` збігся, дає призначення;
 *   3. нічого не збіглось → `unsorted_destinations`;
 *   4. `confidence` нижче `flow.min_confidence` джерела → unsorted
 *      незалежно від того, що збіглося;
 *   5. одне значення в `when` еквівалентне масиву з одного елемента.
 *
 * І з розділу «#unsorted is mandatory» — туди потрапляє все, де модель
 * впала після всіх спроб, впевненість нижче порогу, тема `other`, або жодне
 * правило не збіглось. **Ніщо не зникає безшумно.**
 *
 * Реклама (`analysis.is_ad`) — теж unsorted, з причиною `ad`: прихована
 * реклама в тематичному каналі коштує довіри до каналу, а в #unsorted її видно
 * і за нею можна дописати blacklist джерела.
 *
 * Одну діру специфікація лишає: що з постом, чия тема не входить у
 * `flow.topics` джерела. Рішення тут — теж unsorted, з окремою причиною. Не
 * відкидати: інакше джерело з обмеженими топіками стало б місцем, де пости
 * зникають, а причину не видно ні в каналі, ні в статистиці.
 *
 * Результат завжди містить `reason` — саме він робить `#unsorted` корисним:
 * за ним видно, який опис у таксономії чи яке правило треба виправити.
 *
 * Розширення поза специфікацією:
 *   - `when.source` — джерело поста: `channel_id` (Telegram chat id, URL
 *     стрічки, сабреддит) або назва джерела. Канал, присвячений одній темі
 *     (одній грі), маршрутизується за ним точніше, ніж за топіком;
 *   - `"also": true` — правило, що ДОДАЄ призначення і не зупиняє пошук.
 *     Діє щоразу, коли збіглося, незалежно від пріоритету; серед звичайних
 *     правил, як і раніше, виграє перше за пріоритетом. Так пост іде і у
 *     свій канал, і в збірний (усі промокоди — ще й в один канал).
 */

/** Ключі, які розуміє `when`. Решта — помилка конфігурації, див. validateRouting. */
const WHEN_KEYS = new Set(["topic", "signal_type", "source"]);

/** Статуси, які resolve приймає. Решта — помилка виклику. */
const RESOLVABLE = new Set(["enriched", "failed"]);

export const RESOLVE_REASONS = Object.freeze({
  MATCHED_RULE: "matched_rule",
  MODEL_FAILED: "model_failed",
  AD: "ad",
  LOW_CONFIDENCE: "low_confidence",
  TOPIC_OTHER: "topic_other",
  TOPIC_NOT_IN_SOURCE: "topic_not_in_source",
  NO_RULE: "no_rule",
});

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** Копія призначень: викликач не має отримати посилання всередину конфігу. */
export function copyDestinations(d) {
  const out = {};
  for (const [platform, ids] of Object.entries(d ?? {})) {
    const list = asArray(ids).map(String).filter((id) => id.trim() !== "");
    if (list.length) out[platform] = list;
  }
  return out;
}

/**
 * Правила, упорядковані за спаданням priority. Сортування стабільне: при
 * рівному пріоритеті виграє те, що стоїть раніше в конфігу — інакше порядок
 * між рівними залежав би від реалізації sort.
 */
export function orderRules(rules) {
  return asArray(rules)
    .map((rule, index) => ({ rule, index, priority: Number(rule?.priority) || 0 }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index);
}

/**
 * Чи збігається `when` з вердиктом. Відсутній ключ — будь-яке значення.
 * `verdict.source` — список ідентифікаторів джерела (channel_id, назва);
 * `when.source` збігається, якщо будь-який з них є в списку.
 */
export function matchesWhen(when, verdict) {
  if (!when || typeof when !== "object") return false;
  for (const key of WHEN_KEYS) {
    if (!(key in when)) continue;
    const allowed = asArray(when[key]);
    if (key === "source") {
      const ids = asArray(verdict.source).map(String);
      if (!allowed.some((value) => ids.includes(String(value)))) return false;
      continue;
    }
    if (!allowed.includes(verdict[key])) return false;
  }
  return true;
}

/** Ідентифікатори джерела для `when.source`: channel_id поста і джерела, назва. */
function sourceIds(post, source) {
  return [...new Set([post.channel_id, source?.channel_id, source?.channel_name]
    .filter((v) => v != null && String(v).trim() !== "")
    .map(String))];
}

/** Об'єднання призначень без повторів, порядок — як прийшли. */
function mergeDestinations(into, more) {
  for (const [platform, ids] of Object.entries(more)) {
    const list = into[platform] ?? (into[platform] = []);
    for (const id of ids) if (!list.includes(id)) list.push(id);
  }
  return into;
}

/**
 * @param {object} args
 * @param {{status: string, topic?: string, signal_type?: string, confidence?: number, analysis?: {is_ad?: boolean}}} args.post
 * @param {{topics?: string[]|null, min_confidence?: number}} args.flow
 *   Результат `source.getFlowConfig()`.
 * @param {{routing?: object[], unsorted_destinations?: object}} args.routing
 *   Вміст routing.json (експорт ROUTING).
 * @param {{channel_id?: string, channel_name?: string}|null} [args.source]
 *   Джерело поста — для `when.source` за назвою (channel_id є і в пості).
 * @returns {{
 *   outcome: "routed"|"unsorted",
 *   reason: string,
 *   destinations: Record<string, string[]>,
 *   rule: {index: number, priority: number}|null,
 *   rules: Array<{index: number, priority: number, also: boolean}>,
 * }}
 */
export function resolve({ post, flow = {}, routing = {}, source = null }) {
  if (!post || !RESOLVABLE.has(post.status)) {
    // Помилка виклику, а не маршрутизації: pending ще не має вердикту, а
    // skipped_* і routed доставляти не можна взагалі. Тихий unsorted тут
    // замаскував би ваду в стадії, що вибирає пости.
    throw new Error(
      `resolve(): post status must be one of ${[...RESOLVABLE].join(", ")}, ` +
        `got ${JSON.stringify(post?.status)}`,
    );
  }

  const unsorted = (reason) => ({
    outcome: "unsorted",
    reason,
    destinations: copyDestinations(routing.unsorted_destinations),
    rule: null,
    rules: [],
  });

  if (post.status === "failed") return unsorted(RESOLVE_REASONS.MODEL_FAILED);

  // Реклама — до будь-якого правила: тема в неї справжня (crypto, tools), і
  // правило маршрутизувало б її в тематичний канал.
  if (post.analysis?.is_ad === true) return unsorted(RESOLVE_REASONS.AD);

  // Крок 4 специфікації — перевіряється першим, бо діє «незалежно від того,
  // що збіглося». Невизначена впевненість трактується як нульова: краще в
  // unsorted, ніж маршрутизувати вердикт, у якому модель не впевнена.
  const minConfidence = Number(flow.min_confidence ?? 0);
  const confidence = Number(post.confidence);
  if (!Number.isFinite(confidence) || confidence < minConfidence) {
    return unsorted(RESOLVE_REASONS.LOW_CONFIDENCE);
  }

  if (post.topic === "other") return unsorted(RESOLVE_REASONS.TOPIC_OTHER);

  const sourceTopics = flow.topics;
  if (Array.isArray(sourceTopics) && sourceTopics.length > 0 && !sourceTopics.includes(post.topic)) {
    return unsorted(RESOLVE_REASONS.TOPIC_NOT_IN_SOURCE);
  }

  const verdict = { topic: post.topic, signal_type: post.signal_type, source: sourceIds(post, source) };
  const destinations = {};
  const matched = [];
  let main = null;
  for (const { rule, index, priority } of orderRules(routing.routing)) {
    const also = rule.also === true;
    // Після першого звичайного правила шукаємо лише `also`.
    if (main && !also) continue;
    if (!matchesWhen(rule.when, verdict)) continue;
    const own = copyDestinations(rule.destinations);
    // Правило, що збіглося, але нікуди не веде, — не підстава загубити пост.
    if (Object.keys(own).length === 0) continue;
    mergeDestinations(destinations, own);
    matched.push({ index, priority, also });
    if (!also) main = { index, priority };
  }

  if (matched.length === 0) return unsorted(RESOLVE_REASONS.NO_RULE);
  return {
    outcome: "routed",
    reason: RESOLVE_REASONS.MATCHED_RULE,
    destinations,
    rule: main ?? { index: matched[0].index, priority: matched[0].priority },
    rules: matched,
  };
}

/**
 * Перевіряє routing.json проти таксономії. Повертає список проблем (порожній —
 * все гаразд), не кидає: викликач вирішує, чи це фатально на старті.
 *
 * Навіщо: помилка в правилі маршрутизації не падає, а тихо змінює поведінку.
 * `"signal": [...]` замість `"signal_type"` зробив би правило таким, що
 * збігається з усім. Топік, якого немає в таксономії, — правилом, що не
 * збігається ніколи. Приклад у TAXONOMY.md використовує `games` і `market`,
 * яких у v1 немає, тож routing.json, скопійований зі специфікації, мовчки не
 * маршрутизував би нічого.
 *
 * @param {object} routing   Вміст routing.json.
 * @param {object} taxonomy  CATEGORIES (topics, signals).
 * @returns {string[]}
 */
export function validateRouting(routing, taxonomy) {
  const problems = [];
  const topics = new Set(Object.keys(taxonomy?.topics ?? {}));
  const signals = new Set(Object.keys(taxonomy?.signals ?? {}));

  const unsorted = copyDestinations(routing?.unsorted_destinations);
  if (Object.keys(unsorted).length === 0) {
    problems.push("unsorted_destinations is empty — #unsorted is mandatory, verdicts would have nowhere to fall through to");
  }
  for (const field of ["unsorted_destinations", "health_destinations", "digest_destinations", "status_destinations"]) {
    problems.push(...destinationIdProblems(routing?.[field], field));
  }

  const rules = routing?.routing;
  if (rules != null && !Array.isArray(rules)) {
    problems.push("routing must be an array of rules");
    return problems;
  }

  asArray(rules).forEach((rule, i) => {
    const at = `routing[${i}]`;
    if (!rule || typeof rule !== "object") {
      problems.push(`${at} is not an object`);
      return;
    }
    if (!rule.when || typeof rule.when !== "object" || Array.isArray(rule.when)) {
      problems.push(`${at}.when must be an object`);
    } else {
      for (const key of Object.keys(rule.when)) {
        if (!WHEN_KEYS.has(key)) {
          problems.push(`${at}.when.${key} is not a known condition (expected ${[...WHEN_KEYS].join(" / ")})`);
        }
      }
      for (const t of asArray(rule.when.topic)) {
        if (!topics.has(t)) problems.push(`${at}.when.topic "${t}" is not in the taxonomy`);
      }
      for (const s of asArray(rule.when.signal_type)) {
        if (!signals.has(s)) problems.push(`${at}.when.signal_type "${s}" is not in the taxonomy`);
      }
      if ("source" in rule.when && asArray(rule.when.source).every((v) => String(v ?? "").trim() === "")) {
        problems.push(`${at}.when.source is empty — the rule would never match`);
      }
    }
    if (rule.also != null && typeof rule.also !== "boolean") {
      problems.push(`${at}.also ${JSON.stringify(rule.also)} must be true or false`);
    }
    if (Object.keys(copyDestinations(rule.destinations)).length === 0) {
      problems.push(`${at}.destinations is empty — the rule can match but deliver nowhere`);
    }
    problems.push(...destinationIdProblems(rule.destinations, `${at}.destinations`));
    if (rule.priority != null && !Number.isFinite(Number(rule.priority))) {
      problems.push(`${at}.priority ${JSON.stringify(rule.priority)} is not a number`);
    }
  });

  return problems;
}

/**
 * Ідентифікатори, які платформа точно не прийме: Discord — лише snowflake,
 * Telegram — числовий chat id або @username. Ловить заглушки на кшталт
 * "TODO:claims", що лишились у routing.json до створення каналу: інакше
 * доставка мовчки не дійшла б нікуди.
 */
export function destinationIdProblems(destinations, at) {
  const problems = [];
  for (const [platform, ids] of Object.entries(copyDestinations(destinations))) {
    for (const id of ids) {
      const ok = platform === "discord" ? /^[0-9]{17,20}$/.test(id)
        : platform === "telegram" ? /^-?[0-9]+$/.test(id) || /^@[A-Za-z0-9_]{4,}$/.test(id)
          : true;
      if (!ok) problems.push(`${at}.${platform} "${id}" is not a valid ${platform} id`);
    }
  }
  return problems;
}

export default { resolve, validateRouting, orderRules, matchesWhen, destinationIdProblems, RESOLVE_REASONS };
