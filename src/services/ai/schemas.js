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
              },
              required: ["code"],
            },
          },
          event: { type: ["object", "null"] },
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
export function validateVerbatim(obj, rawText) {
  const haystack = String(rawText ?? "").toLowerCase();
  const present = (s) => typeof s === "string" && s.trim() !== "" &&
    haystack.includes(s.toLowerCase());

  // Work on a shallow-ish copy so the caller's object is untouched.
  const value = {
    ...obj,
    entities: obj.entities ? { ...obj.entities } : obj.entities,
    extracted: obj.extracted ? { ...obj.extracted } : obj.extracted,
  };
  const discarded = [];

  if (value.entities && Array.isArray(value.entities.tickers)) {
    value.entities.tickers = value.entities.tickers.filter((t) => {
      if (present(t)) return true;
      discarded.push({ path: "entities.tickers", value: t });
      return false;
    });
  }

  if (value.extracted && Array.isArray(value.extracted.promo_codes)) {
    value.extracted.promo_codes = value.extracted.promo_codes.filter((c) => {
      if (present(c?.code)) return true;
      discarded.push({ path: "extracted.promo_codes[].code", value: c?.code });
      return false;
    });
  }

  return { value, discarded };
}

/**
 * Convenience: structural then verbatim.
 * @returns {{ ok: boolean, errors: string[], value: object|null, discarded: Array }}
 */
export function validateEnrichResponse(obj, { taxonomy, rawText }) {
  const structural = validateStructural(obj, taxonomy);
  if (!structural.ok) {
    return { ok: false, errors: structural.errors, value: null, discarded: [] };
  }
  const { value, discarded } = validateVerbatim(obj, rawText);
  return { ok: true, errors: [], value, discarded };
}
