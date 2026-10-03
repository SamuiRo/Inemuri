import {
  KNOWLEDGE_LEVELS, KNOWLEDGE_ORIGINS, KNOWLEDGE_VERDICTS,
} from "../../teapot/models/KnowledgeExample.js";
import { contentHash } from "./snapshot.js";

/**
 * Формат обміну базою знань між інстансами (NEWS_INTAKE.md §3.5). Чистий.
 *
 * JSONL: перший рядок — заголовок `{ format, version, exported_at, count }`,
 * далі по прикладу на рядок. Локальні id (id, post_id, feedback_id) не
 * експортуються — на іншому інстансі вони нічого не значать. content_hash
 * теж: він похідний і перераховується при імпорті, тож файл не може
 * розійтися з власним змістом.
 */

export const KNOWLEDGE_FORMAT = "inemuri.knowledge";
export const KNOWLEDGE_FORMAT_VERSION = 1;

/** Поля прикладу у файлі, у цьому порядку. */
export const EXCHANGE_FIELDS = [
  "uid", "level", "verdict", "reason",
  "title", "body", "text_en", "url", "source_name", "platform", "published_at",
  "topic", "signal_type", "extracted", "taxonomy_version",
  "origin", "created_at",
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iso = (d) => (d == null ? null : new Date(d).toISOString());

/** Рядок бази → запис файлу. */
export function toRecord(row) {
  const plain = typeof row.get === "function" ? row.get({ plain: true }) : row;
  const record = {};
  for (const f of EXCHANGE_FIELDS) record[f] = plain[f] ?? null;
  record.published_at = iso(record.published_at);
  record.created_at = iso(record.created_at);
  return record;
}

/**
 * @param {object[]} rows
 * @param {{ now?: Date }} [opts]
 * @returns {string} Вміст файлу, із завершальним переводом рядка.
 */
export function serialize(rows, { now = new Date() } = {}) {
  const header = {
    format: KNOWLEDGE_FORMAT, version: KNOWLEDGE_FORMAT_VERSION, exported_at: now.toISOString(), count: rows.length,
  };
  return [header, ...rows.map(toRecord)].map((o) => JSON.stringify(o)).join("\n") + "\n";
}

// ── Перевірка запису ──────────────────────────────────────────────────

const isNullableString = (v) => v == null || typeof v === "string";
const isDate = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** Перша знайдена проблема запису, або null. */
export function validateRecord(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "not an object";
  if (typeof r.uid !== "string" || !UUID.test(r.uid)) return "uid is not a UUID";
  if (!KNOWLEDGE_LEVELS.includes(r.level)) return `unknown level "${r.level}"`;
  if (!KNOWLEDGE_VERDICTS.includes(r.verdict)) return `unknown verdict "${r.verdict}"`;
  if (!KNOWLEDGE_ORIGINS.includes(r.origin)) return `unknown origin "${r.origin}"`;
  if (typeof r.body !== "string" || !r.body.trim()) return "body is empty";
  if (!isDate(r.created_at)) return "created_at is not a date";
  if (r.published_at != null && !isDate(r.published_at)) return "published_at is not a date";
  if (r.taxonomy_version != null && !Number.isInteger(r.taxonomy_version)) return "taxonomy_version is not an integer";
  if (r.extracted != null && (typeof r.extracted !== "object" || Array.isArray(r.extracted))) return "extracted is not an object";
  for (const f of ["reason", "title", "text_en", "url", "source_name", "platform", "topic", "signal_type"]) {
    if (!isNullableString(r[f])) return `${f} is not a string`;
  }
  return null;
}

/** Перевірений запис → значення рядка бази (content_hash перераховано). */
export function fromRecord(r) {
  const row = {};
  for (const f of EXCHANGE_FIELDS) row[f] = r[f] ?? null;
  row.published_at = r.published_at ? new Date(r.published_at) : null;
  row.created_at = new Date(r.created_at);
  row.content_hash = contentHash(row);
  return row;
}

/**
 * Розбір файлу. Хибний заголовок — помилка всього файлу (throw); хибний
 * запис — рядок у `errors` з номером, решта файлу читається далі.
 *
 * @param {string} text
 * @returns {{ header: object, rows: object[], errors: Array<{ line: number, error: string }> }}
 */
export function parse(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    throw new Error("line 1: not a knowledge export header");
  }
  if (header?.format !== KNOWLEDGE_FORMAT) throw new Error(`line 1: format is not "${KNOWLEDGE_FORMAT}"`);
  if (header.version !== KNOWLEDGE_FORMAT_VERSION) {
    throw new Error(`line 1: unsupported version ${header.version} (this build reads ${KNOWLEDGE_FORMAT_VERSION})`);
  }

  const rows = [];
  const errors = [];
  lines.slice(1).forEach((raw, i) => {
    const line = i + 2;
    if (!raw.trim()) return;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      errors.push({ line, error: "not JSON" });
      return;
    }
    const error = validateRecord(record);
    if (error) errors.push({ line, error });
    else rows.push(fromRecord(record));
  });
  return { header, rows, errors };
}
