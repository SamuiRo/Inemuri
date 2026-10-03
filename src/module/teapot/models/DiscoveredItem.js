import { DataTypes, Op } from "sequelize";
import database from "../sqlite/sqlite_db.js";

/**
 * Кандидати новинних джерел до triage (NEWS_INTAKE.md §2.2, ROADMAP §14.3).
 *
 * Сюди, а не в `posts`, потрапляє кожна нова стаття джерела з
 * `feed.triage: true`. У `posts` переходить лише те, що triage пропустив, —
 * великий сайт дає 200–400 статей на добу, і 90%+ з них корпусу не потрібні.
 * Рядки живуть коротко (FLOW_TRIAGE.retentionDays): це лише заголовки.
 *
 * Статус:
 *   pending   — чекає LLM-triage;
 *   passed    — пропущено; post_id — створений пост (null — ще не створено);
 *   rejected  — відкинуто правилом (decided_by "rule") або моделлю ("llm");
 *   failed    — модель не відповіла за maxAttempts спроб (last_error — чому).
 * `sampled` — відкинутий моделлю, але позначений на перегляд оператором.
 */

export const TRIAGE_STATUSES = ["pending", "passed", "rejected", "failed"];

export const DiscoveredItem = database.sequelize.define("DiscoveredItem", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  source_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: "sources", key: "id" },
    onDelete: "SET NULL",
  },

  // ── Елемент стрічки (parsers.js) ───────────────────────────────────
  external_id: { type: DataTypes.STRING, allowNull: false, comment: "id елемента; ідентичність у парі з source_id" },
  url: { type: DataTypes.STRING, allowNull: true },
  title: { type: DataTypes.TEXT, allowNull: true },
  teaser: { type: DataTypes.TEXT, allowNull: true, comment: "Текст зі стрічки (анонс); у sitemap — порожньо" },
  author: { type: DataTypes.STRING, allowNull: true },
  keywords: { type: DataTypes.JSON, allowNull: true, comment: "news:keywords sitemap-а" },
  image_urls: { type: DataTypes.JSON, allowNull: true },
  section: { type: DataTypes.STRING, allowNull: true, comment: "Розділ сайту з URL: business, health, sports…" },
  published_at: { type: DataTypes.DATE, allowNull: true },

  // ── Рішення triage ─────────────────────────────────────────────────
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "pending",
    validate: { isIn: [TRIAGE_STATUSES] },
  },
  decided_by: { type: DataTypes.STRING, allowNull: true, comment: "rule | llm" },
  area: { type: DataTypes.STRING, allowNull: true, comment: "Напрям профілю (triage.json areas), якщо пропущено" },
  reason: { type: DataTypes.TEXT, allowNull: true, comment: "Правило (section:sports) або коротке пояснення моделі" },
  profile_version: { type: DataTypes.INTEGER, allowNull: true, comment: "Версія triage.json, з якою прийнято рішення" },
  model_used: { type: DataTypes.STRING, allowNull: true },
  sampled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  last_error: { type: DataTypes.TEXT, allowNull: true },
  post_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: "posts", key: "id" },
    onDelete: "SET NULL",
  },
  review_verdict: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Мітка оператора з `flow triage review` (вона ж у базі знань); null — не переглянуто",
  },
}, {
  tableName: "discovered_items",
  timestamps: true,
  indexes: [
    { fields: ["source_id", "external_id"], unique: true, name: "discovered_items_source_external" },
    { fields: ["status", "createdAt"], name: "discovered_items_status_created" },
  ],
});

/**
 * Найстаріші pending. Один воркер, ланцюжок тіків без перекриття
 * (EnrichWorker), тож окремого «захоплення» не треба.
 */
DiscoveredItem.nextPending = function (limit) {
  return DiscoveredItem.findAll({
    where: { status: "pending" },
    order: [["createdAt", "ASC"], ["id", "ASC"]],
    limit,
  });
};

/** Пропущені, для яких пост ще не створено (збій створення минулого тіку). */
DiscoveredItem.unpromoted = function (limit) {
  return DiscoveredItem.findAll({
    where: { status: "passed", post_id: null },
    order: [["id", "ASC"]],
    limit,
  });
};

/** Прибрати старші за retentionDays. @returns {Promise<number>} */
DiscoveredItem.sweep = function ({ retentionDays, now = new Date() }) {
  const before = new Date(now.getTime() - retentionDays * 86_400_000);
  return DiscoveredItem.destroy({ where: { createdAt: { [Op.lt]: before } } });
};

export default DiscoveredItem;
