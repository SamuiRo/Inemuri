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
  "skipped_shouty",     // короткий пост капсом (ритуальні/службові), опційно на джерело
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
  platform: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "telegram",
    comment: "Платформа джерела: telegram | reddit | rss | ... (міграція 002)",
  },
  external_id: {
    type: DataTypes.STRING,
    allowNull: true,
    comment:
      "Універсальна ідентичність елемента: Telegram message id як текст, " +
      "Reddit fullname (t3_...), для статті — її URL. Унікальний у парі з source_id",
  },
  external_url: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Канонічне посилання. Для Reddit і новин — ще й tier-1 ключ дедуплікації",
  },
  channel_id: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "Денормалізований швидкий ключ пошуку для Telegram (не частина ідентичності)",
  },
  message_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment:
      "Legacy Telegram message id. Ідентичність тепер (source_id, external_id); " +
      "цю колонку більше ніхто не читає — окрема міграція її прибере",
  },
  grouped_id: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "ID альбому, якщо пост — частина групи",
  },
  title: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: "Заголовок, окремо від тіла. Для новин і Reddit несе всю подію; у Telegram немає",
  },
  author: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Автор Reddit-поста, підпис статті",
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
  entities: {
    type: DataTypes.JSON,
    allowNull: true,
    comment:
      "Оригінальні MTProto entities як plain-масив {className, offset, length, url?, language?}. " +
      "Доставка компонує текст із offset-ів, не з Markdown. Offset-и індексують текст " +
      "ДО text_replacements (міграція 002, див. DELIVERY.md)",
  },

  // ── Медіа (не завантажується на цій стадії, лише позначається) ──────
  has_media: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: "Чи має пост медіа. Завантаження — на стадії 3 (доставка)",
  },
  media_ref: {
    type: DataTypes.JSON,
    allowNull: true,
    comment:
      "Що стадії 3 треба, щоб дістати медіа пізніше, per-platform. " +
      "{ kind: 'telegram', channel_id, message_id, grouped_id } | { kind: 'url', urls: [...] }",
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
    comment:
      "Float32Array як BLOB, нормалізований до одиничної довжини при записі " +
      "(cosine = звичайний dot product). Little-endian; buffer.length === embedding_dim * 4",
  },
  embedding_model: {
    type: DataTypes.STRING,
    allowNull: true,
    comment:
      "Яка модель дала вектор, напр. gemini:text-embedding-004. НЕ model_used " +
      "(той — модель збагачення). Tier 2 порівнює лише вектори однієї моделі",
  },
  embedding_dim: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: "Розмірність вектора. Різна per-provider і per-configured output size",
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
    // Ідемпотентний ingest: ідентичність = (джерело, id елемента), platform-neutral.
    // Замінює (channel_id, message_id) з міграцією 002.
    { fields: ["source_id", "external_id"], unique: true, name: "posts_source_id_external_id" },
    // Денормалізований швидкий ключ пошуку для Telegram
    { fields: ["channel_id"], name: "posts_channel_id" },
    // Головний запит воркера enrich
    { fields: ["status", "createdAt"] },
    // Дешева дедуплікація
    { fields: ["text_hash"] },
    // Збір членів кластера
    { fields: ["cluster_id"] },
    // Дайджести та пошук по історії
    { fields: ["topic", "signal_type", "posted_at"] },
    // Tier 2 порівнює лише вектори, зроблені однією моделлю
    { fields: ["embedding_model"] },
  ],
});

// ==================== STATIC МЕТОДИ ====================

/**
 * Ідемпотентна вставка ingest-стадії.
 * Повертає [post, created]. created === false означає, що пост із цією
 * парою (source_id, external_id) вже був — режим "both" або повторний polling.
 */
Post.ingest = async function (fields) {
  return await this.findOrCreate({
    where: {
      source_id: fields.source_id,
      external_id: String(fields.external_id),
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

/**
 * Заявка партії для воркера enrich (ROADMAP §13.1). Бере найстаріші pending,
 * інкрементує `attempts` ОДНИМ statement-ом ще ДО виклику gateway — краш
 * посеред виклику тоді рахується в кап, а не ретраїться вічно (а якщо саме
 * цей рядок і вбив процес — вічно означає restart-loop). Немає статусу
 * `enriching`: після краху рядки просто беруться знову.
 *
 * Виклик обгорнутий так, щоб lease пізніше замінив цю логіку без зміни
 * call-site.
 */
Post.claimPending = async function (limit) {
  const heads = await this.findAll({
    where: { status: "pending" },
    order: [["createdAt", "ASC"]],
    limit,
    attributes: ["id"],
  });
  if (heads.length === 0) return [];

  const ids = heads.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  await database.sequelize.query(
    `UPDATE \`posts\` SET \`attempts\` = \`attempts\` + 1, \`updatedAt\` = ? ` +
      `WHERE \`id\` IN (${placeholders}) AND \`status\` = 'pending'`,
    { replacements: [new Date().toISOString(), ...ids] },
  );

  return await this.findAll({ where: { id: ids }, order: [["createdAt", "ASC"]] });
};

export default Post;
