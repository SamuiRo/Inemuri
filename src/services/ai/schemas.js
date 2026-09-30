/**
 * TheFlow — enrich() response schema and validation (ROADMAP §3.3).
 *
 * Two layers, both applied to every model response before it is written to
 * `posts`:
 *
 *   1. Structural — required fields, correct types, and `topic` / `signal_type`
 *      are members of the CLOSED enums from categories.json. A value outside
 *      the enum is a failure, never a new category.
 *   2. Verbatim — every field that claims to quote the source (promo codes,
 *      tickers, links) must appear in `raw_text`. Failures are discarded, not
 *      corrected — the model confirms regex candidates, it never writes a code
 *      itself.
 *
 * Hand-rolled, no `ajv`: the schema is small and fixed, the interesting checks
 * (enum membership against a runtime file, verbatim presence) are custom
 * anyway, and it stays trivially testable.
 *
 * An invalid response is a failure, not data: the post stays `pending`,
 * `attempts` increments, `last_error` records why (LLM_GATEWAY.md).
 */

// Field order is load-bearing: text_en first. The model normalizes to English
// and every later field describes that canonical representation (ROADMAP §3.4).
export const ENRICH_FIELDS = [
  "text_en",
  "lang",
  "summary_uk",
  "topic",
  "signal_type",
  "confidence",
  "entities",
  "extracted",
  "why_interesting",
  "is_ad",
];

// Роль посилання в пості (фаза 4): claim — де забрати / взяти участь,
// source — першоджерело новини, signup — реєстрація, docs — інструкція.
export const LINK_ROLES = ["claim", "source", "signup", "docs", "other"];

// ISO-дата або дата-час, який модель повертає як нормалізоване значення.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** ISO-рядок, що справді є датою, або null. */
export function isoOrNull(v) {
  if (typeof v !== "string" || !ISO_DATE.test(v.trim())) return null;
  const t = Date.parse(v.trim().length === 10 ? `${v.trim()}T00:00:00Z` : v.trim());
  return Number.isFinite(t) ? v.trim() : null;
}

/**
 * A JSON-Schema object for provider structured output (Gemini `responseSchema`
 * / OpenAI `response_format: json_schema`). Enums are filled from the taxonomy
 * so the model cannot return a category that is not in categories.json.
 *
 * @param {{topics: object, signals: object}} taxonomy
 */
export function enrichResponseSchema(taxonomy) {
  const topics = Object.keys(taxonomy?.topics ?? {});
  const signals = Object.keys(taxonomy?.signals ?? {});

  return {
    type: "object",
    // Order here is the order the model is asked to produce.
    properties: {
      text_en: { type: "string" },
      lang: { type: "string" },
      summary_uk: { type: ["string", "null"] },
      topic: { type: "string", enum: topics },
      signal_type: { type: "string", enum: signals },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      entities: {
        type: "object",
        properties: {
          project: { type: ["string", "null"] },
          tickers: { type: "array", items: { type: "string" } },
        },
      },
      // Фаза 4 (ROADMAP §8): гібридне витягування. Кожне нормалізоване
      // значення має дослівний якір у тексті (`*_text`), і перевіряється саме
      // якір — нормалізовану дату дослівно не звіриш.
      extracted: {
        type: "object",
        properties: {
          promo_codes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                code: { type: "string" },
                reward: { type: ["string", "null"] },
                expires_at: { type: ["string", "null"] },
                expires_text: { type: ["string", "null"] },
              },
              required: ["code"],
            },
          },
          links: {
            type: "array",
            items: {
              type: "object",
              properties: {
                url: { type: "string" },
                role: { type: "string", enum: LINK_ROLES },
              },
              required: ["url", "role"],
            },
          },
          amounts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                value: { type: ["number", "null"] },
                unit: { type: ["string", "null"] },
                what: { type: ["string", "null"] },
              },
              required: ["text"],
            },
          },
          event: {
            type: ["object", "null"],
            properties: {
              name: { type: "string" },
              starts_at: { type: ["string", "null"] },
              ends_at: { type: ["string", "null"] },
              date_text: { type: ["string", "null"] },
            },
            required: ["name"],
          },
        },
      },
      why_interesting: { type: "string" },
      is_ad: { type: "boolean" },
    },
    required: ["text_en", "lang", "topic", "signal_type", "confidence"],
  };
}

// ── Structural validation ────────────────────────────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} obj              The parsed model response.
 * @param {{topics: object, signals: object}} taxonomy
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateStructural(obj, taxonomy) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { ok: false, errors: ["response is not an object"] };
  }

  const topics = new Set(Object.keys(taxonomy?.topics ?? {}));
  const signals = new Set(Object.keys(taxonomy?.signals ?? {}));

  // Required strings
  if (typeof obj.text_en !== "string" || obj.text_en.trim() === "") {
    errors.push("text_en: missing or empty");
  }
  if (typeof obj.lang !== "string" || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(obj.lang)) {
    errors.push(`lang: not an ISO 639-1 code (${JSON.stringify(obj.lang)})`);
  }

  // Closed enums — outside the list is a failure, never a new category
  if (!topics.has(obj.topic)) {
    errors.push(`topic: ${JSON.stringify(obj.topic)} not in categories.json`);
  }
  if (!signals.has(obj.signal_type)) {
    errors.push(`signal_type: ${JSON.stringify(obj.signal_type)} not in categories.json`);
  }

  // confidence in [0, 1]
  if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence) ||
      obj.confidence < 0 || obj.confidence > 1) {
    errors.push(`confidence: not a number in [0,1] (${JSON.stringify(obj.confidence)})`);
  }

  // Optional-but-typed
  if (obj.summary_uk != null && typeof obj.summary_uk !== "string") {
    errors.push("summary_uk: present but not a string");
  }
  if (obj.why_interesting != null && typeof obj.why_interesting !== "string") {
    errors.push("why_interesting: present but not a string");
  }
  if (obj.is_ad != null && typeof obj.is_ad !== "boolean") {
    errors.push("is_ad: present but not a boolean");
  }

  if (obj.entities != null) {
    if (!isPlainObject(obj.entities)) {
      errors.push("entities: present but not an object");
    } else if (obj.entities.tickers != null &&
      (!Array.isArray(obj.entities.tickers) ||
        !obj.entities.tickers.every((t) => typeof t === "string"))) {
      errors.push("entities.tickers: not an array of strings");
    }
  }

  if (obj.extracted != null) {
    if (!isPlainObject(obj.extracted)) {
      errors.push("extracted: present but not an object");
    } else if (obj.extracted.promo_codes != null) {
      const list = obj.extracted.promo_codes;
      if (!Array.isArray(list) || !list.every((c) => isPlainObject(c) && typeof c.code === "string")) {
        errors.push("extracted.promo_codes: not an array of { code: string, ... }");
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Verbatim validation ─────────────────────────────────────────────────────

/**
 * Strip fields that claim to quote the source but do not appear in `raw_text`.
 * Applied to literal quotes only — promo codes, tickers, links. NOT to
 * `entities.project`: a project name is an identification, and it is
 * legitimately transliterated or translated away from the source spelling;
 * false-rejecting a real project is worse than keeping a wrong one the reader
 * sees in context.
 *
 * @param {object} obj       A structurally valid response (mutated copy returned).
 * @param {string} rawText   The original text those offsets index.
 * @returns {{ value: object, discarded: Array<{path: string, value: string}> }}
 */
/**
 * Verbatim-перевірка з провенансом (VISION.md «Entities from images cannot be
 * verified»).
 *
 * Правило «кожне дослівне поле має бути в тексті» — головний захист від
 * галюцинацій. З vision у нього з'являється діра в обидва боки:
 *
 *   - звіряти лише з raw_text — код зі скріншота там відсутній, тож його
 *     МОВЧКИ ВИКИДАЛИ б, і vision працював би вхолосту;
 *   - просто додати text_ocr до перевірки — OCR-код вважався б перевіреним,
 *     хоча `HY45OLK8QRE2` і `HY45OLK80RE2` з картинки виглядають однаково
 *     переконливо, а неправильний код із впевненістю гірший за жодного.
 *
 * Тому три результати, а не два: знайдено в тексті → лишається, verified;
 * лише в OCR → лишається, але verified: false; ніде → викидається.
 *
 * Збіг із text_ocr підтверджує лише, що модель не вигадала рядок відносно
 * транскрипції. Сама транскрипція може бути помилковою — звідси verified: false.
 *
 * @param {object} obj
 * @param {string} rawText
 * @param {string} [textOcr=""]  Без нього поведінка така сама, як до vision.
 * @returns {{ value: object, discarded: object[], unverified: object[] }}
 */
export function validateVerbatim(obj, rawText, textOcr = "") {
  const inText = String(rawText ?? "").toLowerCase();
  const inOcr = String(textOcr ?? "").toLowerCase();
  const usable = (s) => typeof s === "string" && s.trim() !== "";
  const provenance = (s) => {
    if (!usable(s)) return null;
    const needle = s.toLowerCase();
    if (inText.includes(needle)) return "text";
    if (inOcr && inOcr.includes(needle)) return "ocr";
    return null;
  };

  // Work on a shallow-ish copy so the caller's object is untouched.
  const value = {
    ...obj,
    entities: obj.entities ? { ...obj.entities } : obj.entities,
    extracted: obj.extracted ? { ...obj.extracted } : obj.extracted,
  };
  const discarded = [];
  const unverified = [];

  if (value.entities && Array.isArray(value.entities.tickers)) {
    // Тікери — рядки: провенанс на самому елементі не вмістити, не ламаючи
    // схему, тож OCR-тікери лишаються в масиві і перелічуються в unverified.
    value.entities.tickers = value.entities.tickers.filter((t) => {
      const from = provenance(t);
      if (from === "ocr") unverified.push({ path: "entities.tickers", value: t });
      if (from) return true;
      discarded.push({ path: "entities.tickers", value: t });
      return false;
    });
  }

  if (value.extracted && Array.isArray(value.extracted.promo_codes)) {
    const kept = [];
    for (const c of value.extracted.promo_codes) {
      const from = provenance(c?.code);
      if (!from) {
        discarded.push({ path: "extracted.promo_codes[].code", value: c?.code });
        continue;
      }
      // На об'єкті, бо саме звідси доставка (DELIVERY.md) і tier 1 дедуплікації
      // читатимуть позначку: неперевірений код не може бути авторитетом.
      const code = { ...c, source: from, verified: from === "text" };
      // Дата закінчення — нормалізована; дослівно звіряється її якір.
      const expires = anchoredDate(c?.expires_at, c?.expires_text);
      if (c?.expires_at != null && !expires) {
        discarded.push({ path: "extracted.promo_codes[].expires_at", value: c.expires_at });
      }
      code.expires_at = expires;
      code.expires_text = expires ? c.expires_text : null;
      kept.push(code);
      if (from === "ocr") unverified.push({ path: "extracted.promo_codes[].code", value: c.code });
    }
    value.extracted.promo_codes = kept;
  }

  // ── Фаза 4 (ROADMAP §8). Необов'язкові поля: некоректний елемент
  // відкидається з записом у discarded, а не валить увесь пост — одна
  // зламана сума не варта спроби збагачення.
  if (value.extracted) {
    const ex = value.extracted;

    if (ex.links != null) {
      const kept = [];
      for (const l of Array.isArray(ex.links) ? ex.links : []) {
        const from = isPlainObject(l) ? provenance(l.url) : null;
        if (!from || !/^https?:\/\//i.test(l.url.trim())) {
          discarded.push({ path: "extracted.links[].url", value: l?.url ?? l });
          continue;
        }
        kept.push({
          url: l.url.trim(),
          role: LINK_ROLES.includes(l.role) ? l.role : "other",
          source: from,
          verified: from === "text",
        });
        if (from === "ocr") unverified.push({ path: "extracted.links[].url", value: l.url });
      }
      ex.links = kept;
    }

    if (ex.amounts != null) {
      const kept = [];
      for (const a of Array.isArray(ex.amounts) ? ex.amounts : []) {
        const from = isPlainObject(a) ? provenance(a.text) : null;
        if (!from) {
          discarded.push({ path: "extracted.amounts[].text", value: a?.text ?? a });
          continue;
        }
        kept.push({
          text: a.text.trim(),
          value: typeof a.value === "number" && Number.isFinite(a.value) ? a.value : null,
          unit: usable(a.unit) ? a.unit.trim() : null,
          what: usable(a.what) ? a.what.trim() : null,
          source: from,
          verified: from === "text",
        });
      }
      ex.amounts = kept;
    }

    if (ex.event != null) {
      if (!isPlainObject(ex.event) || !usable(ex.event.name)) {
        discarded.push({ path: "extracted.event", value: ex.event });
        ex.event = null;
      } else {
        // Назву події не звіряємо дослівно — як і project, її легітимно
        // перекладають. Дати — лише з дослівним якорем у тексті.
        const e = ex.event;
        const anchor = usable(e.date_text) ? provenance(e.date_text) : null;
        const starts = anchor ? isoOrNull(e.starts_at) : null;
        const ends = anchor ? isoOrNull(e.ends_at) : null;
        if ((e.starts_at != null && !starts) || (e.ends_at != null && !ends)) {
          discarded.push({ path: "extracted.event.dates", value: { starts_at: e.starts_at, ends_at: e.ends_at, date_text: e.date_text } });
        }
        const hasDate = Boolean(starts || ends);
        ex.event = {
          name: e.name.trim(),
          starts_at: starts,
          ends_at: ends,
          date_text: hasDate ? e.date_text.trim() : null,
          ...(hasDate ? { source: anchor, verified: anchor === "text" } : {}),
        };
        if (hasDate && anchor === "ocr") unverified.push({ path: "extracted.event.date_text", value: e.date_text });
      }
    }
  }

  function anchoredDate(iso, text) {
    const d = isoOrNull(iso);
    return d && usable(text) && provenance(text) ? d : null;
  }

  return { value, discarded, unverified };
}

/**
 * Convenience: structural then verbatim.
 * @returns {{ ok: boolean, errors: string[], value: object|null, discarded: Array }}
 */
export function validateEnrichResponse(obj, { taxonomy, rawText, textOcr = "" }) {
  const structural = validateStructural(obj, taxonomy);
  if (!structural.ok) {
    return { ok: false, errors: structural.errors, value: null, discarded: [], unverified: [] };
  }
  const { value, discarded, unverified } = validateVerbatim(obj, rawText, textOcr);
  return { ok: true, errors: [], value, discarded, unverified };
}
