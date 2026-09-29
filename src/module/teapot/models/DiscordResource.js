import { DataTypes } from "sequelize";
import database from "../sqlite/sqlite_db.js";

/**
 * Стан провіжну discordapp (docs/DISCORDAPP.md, «State»): який ресурс
 * Discord відповідає якому `key` з конфігу сервера.
 *
 * Без цього зв'язку оновлення вгадувало б ресурс за назвою, і
 * перейменування в конфігу створювало б новий канал замість редагування.
 * `archived_at` / `archived_from` — канал, прибраний з конфігу і
 * переміщений в архів; повернення в конфіг з тим самим ключем відновлює його.
 */
export const DiscordResource = database.sequelize.define("DiscordResource", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  guild_id: { type: DataTypes.STRING, allowNull: false },
  kind: { type: DataTypes.STRING(16), allowNull: false, comment: "role | category | channel" },
  key: { type: DataTypes.STRING, allowNull: false, comment: "key з конфігу сервера" },
  discord_id: { type: DataTypes.STRING, allowNull: false },
  content_hash: { type: DataTypes.STRING, allowNull: true, comment: "для повідомлень (крок 5)" },
  archived_at: { type: DataTypes.DATE, allowNull: true },
  archived_from: { type: DataTypes.STRING, allowNull: true, comment: "key категорії, з якої архівовано" },
}, {
  tableName: "discord_resources",
  timestamps: true,
  indexes: [{ unique: true, fields: ["guild_id", "kind", "key"], name: "discord_resources_identity" }],
});

/** Усі записи сервера як прості об'єкти — вхід planner.js. */
DiscordResource.forGuild = async function (guildId) {
  return this.findAll({ where: { guild_id: guildId }, raw: true });
};

/** Запам'ятати (або перезаписати) зв'язок key → discord_id. */
DiscordResource.remember = async function (guildId, kind, key, discordId, extra = {}) {
  const [row] = await this.findOrBuild({ where: { guild_id: guildId, kind, key } });
  row.set({ discord_id: discordId, archived_at: null, archived_from: null, ...extra });
  await row.save();
  return row;
};

DiscordResource.markArchived = async function (guildId, key, fromKey) {
  await this.update(
    { archived_at: new Date(), archived_from: fromKey ?? null },
    { where: { guild_id: guildId, kind: "channel", key } },
  );
};

DiscordResource.forget = async function (guildId, kind, key) {
  await this.destroy({ where: { guild_id: guildId, kind, key } });
};

export default DiscordResource;
