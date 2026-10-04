import { DataTypes } from "sequelize";
import database from "../sqlite/sqlite_db.js";

/**
 * Повідомлення статус-борду (міграція 018): одне на призначення, яке
 * StatusBoard редагує на місці, а не надсилає щоразу нове.
 */
export const StatusMessage = database.sequelize.define("StatusMessage", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  platform: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "telegram | discord",
  },
  channel_id: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "Призначення з status_destinations",
  },
  message_id: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "Надіслане повідомлення, яке редагується",
  },
}, {
  tableName: "status_messages",
  timestamps: true,
  indexes: [
    { fields: ["platform", "channel_id"], unique: true, name: "status_messages_platform_channel" },
  ],
});

/** Збережене повідомлення для призначення, або null. */
StatusMessage.find = async function (platform, channelId) {
  return await this.findOne({ where: { platform, channel_id: String(channelId) } });
};

/** Запам'ятати (або замінити) повідомлення призначення. */
StatusMessage.remember = async function (platform, channelId, messageId) {
  const [row] = await this.findOrBuild({ where: { platform, channel_id: String(channelId) } });
  row.set({ message_id: String(messageId) });
  await row.save();
  return row;
};

export default StatusMessage;
