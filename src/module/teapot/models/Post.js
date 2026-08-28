import { DataTypes } from "sequelize";
import database from "../sqlite/sqlite_db.js";

/**
 * Центральна таблиця TheFlow. Один рядок на кожне вхідне повідомлення
 * з джерела, у якого flow.enabled === true.
 *
 * Конвеєр розв'язаний саме через цю таблицю: ingest пише сюди синхронно
 * (status: 'pending') і на цьому завершується, а все, що далі —
 * enrich та flow — читає з БД у власному темпі. Якщо AI-провайдер лежить,
 * рядки просто накопичуються як 'pending' і нічого не втрачається.
 *
 * Специфікація полів: docs/theflow/DATA_MODEL.md
 */

// Статуси життєвого циклу поста. STRING, а не ENUM: набір статусів TheFlow
// ще уточнюватиметься, а міграцій у проєкті немає — розширювати список
// рядкового поля дешевше, ніж ENUM.
export const POST_STATUSES = [
  "pending",            // щойно записаний ingest-ом, чекає на enrich
  "enriched",           // отримав вердикт від LLMGateway
  "routed",             // доставлений у призначення
  "suppressed",         // дублікат, що нічого не додає
  "unsorted",           // низька впевненість або невідома категорія → #unsorted
  "skipped_blacklist",  // відсіяний regex-стадією: blacklist джерела
  "skipped_empty",      // порожній або коротший за поріг після replacements
  "skipped_noise",      // тільки емодзі / тільки посилання / службовий текст
  "skipped_repost",     // точний хеш-збіг у вікні останніх N годин
  "failed",             // спроби вичерпані; рядок лишається для розбору
];

// Роль поста всередині кластера (події).
export const POST_LINK_ROLES = ["canonical", "linked", "duplicate", "correction"];

export const Post = database.sequelize.define("Post", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },

  // ── Прив'язка до джерела ────────────────────────────────────────────
  source_id: {
    type: DataTypes.INTEGER,
    allowNull: true, // SET NULL при видаленні джерела — історію постів зберігаємо
    comment: "FK до sources.id",
    references: { model: "sources", key: "id" },
    onDelete: "SET NULL",
  },
  channel_id: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "Дубльований channel_id для швидких вибірок без join",
  },
  message_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: "Telegram message ID. Унікальний у парі з channel_id",
  },
  grouped_id: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "ID альбому, якщо пост — частина групи",
  },
  posted_at: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: "Час публікації у джерелі, НЕ час ingest-у",
  },

  // ── Текст ──────────────────────────────────────────────────────────
  raw_text: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: "Оригінал мовою джерела. Ніколи не перезаписується — потрібен для re-run нових промптів по історії",
  },
  text_md: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: "Markdown-рендер з entities, щоб доставити пост як є",
  },
  text_hash: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Хеш нормалізованого тексту — дешева дедуплікація до embeddings",
  },

  // ── Медіа (не завантажується на цій стадії, лише позначається) ──────
  has_media: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: "Чи має пост медіа. Завантаження — на стадії 3 (доставка)",
  },
  image_hash: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Перцептивний хеш першого зображення. Пишемо з фази 0, використовує vision-кеш (VISION.md)",
  },
  text_ocr: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: "Текст, транскрибований із зображень. Зливається з raw_text як вхід enrich()",
  },
  vision_used: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: "Чи був реально зроблений vision-виклик — для атрибуції квоти",
  },

  // ── Вердикт enrich() ───────────────────────────────────────────────
  text_en: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: "Канонічне представлення. Усі стадії нижче працюють саме з ним",
  },
  lang: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Визначена мова джерела (ISO 639-1)",
  },
  topic: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Вісь 1 таксономії. Закритий enum із categories.json",
  },
  signal_type: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Вісь 2 таксономії. Закритий enum",
  },
  confidence: {
    type: DataTypes.FLOAT,
    allowNull: true,
    comment: "0..1. Нижче порогу джерела — маршрут у #unsorted",
  },
  analysis: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: "Entities, витягнуті коди, summary, чому це цікаво",
  },
  candidates: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: "Що знайшла regex-стадія. Зберігається для аудиту й re-run",
  },
  embedding: {
    type: DataTypes.BLOB,
    allowNull: true,
    comment: "Float32Array, збережений як BLOB. Вектор для дедуплікації",
  },

  // ── Кластеризація (дедуплікація) ───────────────────────────────────
  cluster_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: "NULL = ще не віднесений до події. FK до clusters.id",
  },
  link_role: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "canonical | linked | duplicate | correction",
    validate: { isIn: [POST_LINK_ROLES] },
  },
  adds: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: "Що цей пост додає над канонічним (DEDUPLICATION.md)",
  },

  // ── Службові ───────────────────────────────────────────────────────
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "pending",
    comment: "Статус життєвого циклу — див. POST_STATUSES",
    validate: { isIn: [POST_STATUSES] },
  },
  model_used: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Яка модель дала вердикт. Обов'язкове після enrich — без цього fallback робить історію невідтворюваною",
  },
  taxonomy_version: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: "Версія categories.json на момент вердикту — відділити регресію моделі від зміненого опису категорії",
  },
  attempts: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: "Лічильник спроб enrich",
  },
  last_error: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: "Остання помилка — діагностика без копання в логах",
  },
}, {
  tableName: "posts",
  timestamps: true,
  indexes: [
    // Ідемпотентний ingest: захист від подвійної вставки в режимі "both"
    { fields: ["channel_id", "message_id"], unique: true },
    // Головний запит воркера enrich
    { fields: ["status", "createdAt"] },
    // Дешева дедуплікація
    { fields: ["text_hash"] },
    // Збір членів кластера
    { fields: ["cluster_id"] },
    // Дайджести та пошук по історії
    { fields: ["topic", "signal_type", "posted_at"] },
  ],
});

// ==================== STATIC МЕТОДИ ====================

/**
 * Ідемпотентна вставка ingest-стадії.
 * Повертає [post, created]. created === false означає, що пост із цією
 * парою (channel_id, message_id) вже був — режим "both" або повторний polling.
 */
Post.ingest = async function (fields) {
  return await this.findOrCreate({
    where: {
      channel_id: String(fields.channel_id),
      message_id: fields.message_id,
    },
    defaults: fields,
  });
};

/**
 * Партія для воркера enrich: найстаріші pending-пости першими.
 */
Post.takePending = async function (limit) {
  return await this.findAll({
    where: { status: "pending" },
    order: [["createdAt", "ASC"]],
    limit,
  });
};

export default Post;
