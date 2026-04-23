import { DataTypes } from "sequelize";
import database from "../sqlite/sqlite_db.js";

/**
 * Зберігає стан обробки для кожного джерела.
 * Використовується polling режимом для відстеження
 * останнього обробленого message ID.
 */
export const SourceState = database.sequelize.define("SourceState", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  source_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    unique: true,
    comment: "FK до Source.id",
    references: {
      model: "sources",
      key: "id",
    },
    onDelete: "CASCADE",
  },
  last_message_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment:
      "ID останнього обробленого повідомлення. " +
      "null = baseline ще не встановлено (перший запуск).",
  },
  baseline_set_at: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
    comment: "Коли був встановлений початковий baseline",
  },
}, {
  tableName: "source_states",
  timestamps: true,
  indexes: [
    { fields: ["source_id"], unique: true },
  ],
});

// ==================== STATIC МЕТОДИ ====================

/**
 * Отримати стан для джерела або створити новий запис з null
 */
SourceState.getOrCreate = async function (sourceId) {
  const [state] = await this.findOrCreate({
    where: { source_id: sourceId },
    defaults: {
      source_id: sourceId,
      last_message_id: null,
      baseline_set_at: null,
    },
  });
  return state;
};

/**
 * Чи встановлено baseline для джерела
 */
SourceState.hasBaseline = async function (sourceId) {
  const state = await this.findOne({ where: { source_id: sourceId } });
  return state !== null && state.last_message_id !== null;
};

// ==================== INSTANCE МЕТОДИ ====================

/**
 * Встановити baseline — викликається при першому запуску
 * щоб не парсити весь канал з початку.
 */
SourceState.prototype.setBaseline = async function (messageId) {
  this.last_message_id = messageId;
  this.baseline_set_at = new Date();
  await this.save();
};

/**
 * Оновити last_message_id якщо новий ID більший
 */
SourceState.prototype.advance = async function (messageId) {
  if (messageId > (this.last_message_id ?? 0)) {
    this.last_message_id = messageId;
    await this.save();
  }
};

export default SourceState;