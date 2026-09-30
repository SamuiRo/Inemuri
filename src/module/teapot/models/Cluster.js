import { DataTypes } from "sequelize";
import database from "../sqlite/sqlite_db.js";

/**
 * Одна подія, про яку написав один або більше каналів.
 * Створюється дедуплікацією (стадія 3): перший пост про подію стає
 * канонічним, наступні або приєднуються (linked), або пригнічуються.
 *
 * Специфікація: docs/theflow/DATA_MODEL.md, механізм linked — DEDUPLICATION.md
 *
 * Не має міграцій, тож таблиця створюється звичайним sync() (її ще немає).
 */
export const Cluster = database.sequelize.define("Cluster", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  canonical_post_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment:
      "Перший опублікований пост про подію. Без DB-level FK: posts і clusters " +
      "посилаються одне на одне, декларований constraint ускладнив би порядок sync()",
  },
  topic: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Скопійовано з канонічного поста — для запитів без join",
  },
  signal_type: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Скопійовано з канонічного поста",
  },
  centroid: {
    type: DataTypes.BLOB,
    allowNull: true,
    comment: "Канонічний (або усереднений) вектор для порівняння. Float32Array як BLOB",
  },
  embedding_model: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: "Модель, якій належить centroid. Вектори різних моделей не порівнюються (§13.2). Міграція 011",
  },
  embedding_dim: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: "Розмірність centroid. Міграція 011",
  },
  members_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    comment: '"Також повідомили ще N каналів"',
  },
  richness: {
    type: DataTypes.FLOAT,
    allowNull: true,
    comment: "Інформативність поточної канонічної версії (DEDUPLICATION.md)",
  },
  delivered: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: [],
    comment:
      "[{platform, channel_id, message_id, sent_at}] — масив, бо один пост " +
      "міг піти в кілька призначень, і кожне треба редагувати при append",
  },
  appends_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: "Скільки доповнень дописано. Кап тримає повідомлення читабельним",
  },
  first_seen_at: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: "Початок активного вікна події",
  },
  last_seen_at: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: "Кінець активного вікна події",
  },
  closed: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: "Вікно закрите — нові пости не приєднуються",
  },
}, {
  tableName: "clusters",
  timestamps: true,
  indexes: [
    // Пошук відкритого кластера по осях таксономії у вікні дедуплікації
    { fields: ["topic", "signal_type", "closed"] },
    // Відкриті кластери, активні у вікні (tier 1 і tier 2). Міграція 011
    { fields: ["closed", "last_seen_at"], name: "clusters_closed_last_seen_at" },
  ],
});

export default Cluster;
