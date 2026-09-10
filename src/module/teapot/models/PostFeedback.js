import { DataTypes } from "sequelize";
import database from "../sqlite/sqlite_db.js";

/**
 * Мітка людини на пост TheFlow.
 *
 * Створюється у фазі 0.5 (ROADMAP §2.6), не у фазі 5: `flow:review` починає
 * писати мітки вже під час shadow mode фази 1, перетворюючи звірку вердиктів,
 * яку однаково доводиться робити, на розмічений датасет. Пізніше ці мітки
 * стають few-shot прикладами для промпту.
 *
 * Специфікація: docs/theflow/DATA_MODEL.md
 */

export const FEEDBACK_VERDICTS = ["good", "noise", "wrong_topic", "missed"];

export const PostFeedback = database.sequelize.define("PostFeedback", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  post_id: {
    type: DataTypes.INTEGER,
    allowNull: true, // SET NULL: 'missed' не має поста, і історію міток зберігаємо
    comment: "FK до posts.id",
    references: { model: "posts", key: "id" },
    onDelete: "SET NULL",
  },
  verdict: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "good | noise | wrong_topic | missed",
    validate: { isIn: [FEEDBACK_VERDICTS] },
  },
  note: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: "Необов'язковий коментар",
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    comment: "Мітки незмінні — лише created_at, без updatedAt",
  },
}, {
  tableName: "post_feedback",
  timestamps: false, // рядок пишеться раз і не оновлюється
  indexes: [
    { fields: ["post_id"] },
    { fields: ["verdict"] },
  ],
});

export default PostFeedback;
