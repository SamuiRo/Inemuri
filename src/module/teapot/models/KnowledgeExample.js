import { DataTypes } from "sequelize";
import database from "../sqlite/sqlite_db.js";
import { KNOWLEDGE_LEVELS, KNOWLEDGE_ORIGINS, KNOWLEDGE_VERDICTS } from "../vocabulary.js";

/**
 * База знань TheFlow: самодостатні розмічені приклади (NEWS_INTAKE.md §3).
 *
 * На відміну від post_feedback, рядок несе весь зміст, на який дано мітку, —
 * знімок тексту, класифікацію, версію таксономії. Тож мітки переживають
 * чистку `posts` і переїзд на інший інстанс (`flow knowledge export|import`).
 * post_feedback лишається журналом подій review; ця таблиця — шар, з якого
 * читають few-shot і (далі) triage.
 *
 * Рядки незмінні: лише created_at, без updatedAt. Нова мітка на той самий
 * зміст — новий рядок; читачі беруть найновіший за content_hash.
 */

export { KNOWLEDGE_LEVELS, KNOWLEDGE_ORIGINS, KNOWLEDGE_VERDICTS };

export const KnowledgeExample = database.sequelize.define("KnowledgeExample", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  uid: {
    type: DataTypes.STRING(36),
    allowNull: false,
    unique: true,
    comment: "UUID — ідентичність між інстансами; імпорт — upsert за ним",
  },
  content_hash: {
    type: DataTypes.STRING(64),
    allowNull: false,
    comment: "sha256 нормалізованих level + title + body; найновіша мітка змісту перемагає",
  },
  level: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "post | headline | article",
    validate: { isIn: [KNOWLEDGE_LEVELS] },
  },
  verdict: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "good | noise | wrong_topic | missed",
    validate: { isIn: [KNOWLEDGE_VERDICTS] },
  },
  reason: { type: DataTypes.TEXT, allowNull: true, comment: "Чому цінне або сміття — найкорисніше поле для LLM" },

  // ── Знімок змісту ──────────────────────────────────────────────────
  title: { type: DataTypes.TEXT, allowNull: true },
  body: { type: DataTypes.TEXT, allowNull: false, comment: "Текст джерела (raw_text + text_ocr)" },
  text_en: { type: DataTypes.TEXT, allowNull: true, comment: "Канонічний англійський текст, якщо був" },
  url: { type: DataTypes.STRING, allowNull: true },
  source_name: { type: DataTypes.STRING, allowNull: true, comment: "Назва джерела, не id — id свої в кожного інстансу" },
  platform: { type: DataTypes.STRING, allowNull: true },
  published_at: { type: DataTypes.DATE, allowNull: true },

  // ── Класифікація, до якої відноситься мітка ────────────────────────
  topic: { type: DataTypes.STRING, allowNull: true },
  signal_type: { type: DataTypes.STRING, allowNull: true },
  extracted: { type: DataTypes.JSON, allowNull: true, comment: "Сутності й витягнуті значення, якщо були" },
  taxonomy_version: { type: DataTypes.INTEGER, allowNull: true, comment: "Версія categories.json, до якої відноситься topic" },

  // ── Походження ─────────────────────────────────────────────────────
  origin: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "review | sampled_reject | manual",
    validate: { isIn: [KNOWLEDGE_ORIGINS] },
  },
  post_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: "Локальний зв'язок із постом. Не експортується",
    references: { model: "posts", key: "id" },
    onDelete: "SET NULL",
  },
  feedback_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    unique: true,
    comment: "Рядок post_feedback, з якого взято мітку — робить backfill ідемпотентним. Не експортується",
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    comment: "Коли поставлено мітку. Зберігається при імпорті",
  },
}, {
  tableName: "knowledge_examples",
  timestamps: false,
  indexes: [
    { fields: ["content_hash"], name: "knowledge_examples_content_hash" },
    { fields: ["level", "verdict"], name: "knowledge_examples_level_verdict" },
  ],
});

export default KnowledgeExample;
