import { DataTypes } from "sequelize";
import database from "../sqlite/sqlite_db.js";

/**
 * Persistent per-provider daily request counter for the LLM gateway.
 *
 * An in-memory RPD counter resets on restart, so after a crash the gateway
 * believes it has a full allowance and drives into the wall it was built to
 * avoid. This table survives restarts and is shared by any process that opens
 * the same database file (LLM_GATEWAY.md — "A module, not a service").
 *
 * The counter is **per provider, not per capability**: enrich, embed and
 * vision draw on one daily allowance.
 */
export const ProviderQuota = database.sequelize.define("ProviderQuota", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  provider: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "Provider key: gemini | openrouter | ...",
  },
  day_utc: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: "UTC calendar day, YYYY-MM-DD — the reset boundary",
  },
  count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: "Requests made against this provider today (all capabilities)",
  },
  exhausted_at: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: "Set when the provider returned a daily-quota error; cleared next day by a new row",
  },
}, {
  tableName: "provider_quota",
  timestamps: false,
  indexes: [
    { fields: ["provider", "day_utc"], unique: true, name: "provider_quota_provider_day" },
  ],
});

// ==================== STATIC МЕТОДИ ====================

/** UTC calendar day as YYYY-MM-DD. */
ProviderQuota.today = function () {
  return new Date().toISOString().slice(0, 10);
};

/**
 * Bump today's counter for a provider and return the new value. The
 * INSERT .. ON CONFLICT DO UPDATE is one atomic statement; the count is then
 * read back (RETURNING is not reliably surfaced by Sequelize v6 on sqlite3).
 */
ProviderQuota.bump = async function (provider, day = ProviderQuota.today()) {
  await database.sequelize.query(
    "INSERT INTO `provider_quota` (`provider`, `day_utc`, `count`) VALUES (?, ?, 1) " +
      "ON CONFLICT(`provider`, `day_utc`) DO UPDATE SET `count` = `count` + 1",
    { replacements: [provider, day] },
  );
  return await ProviderQuota.used(provider, day);
};

/** Current count for a provider today (0 if no row yet). */
ProviderQuota.used = async function (provider, day = ProviderQuota.today()) {
  const row = await this.findOne({ where: { provider, day_utc: day } });
  return row?.count ?? 0;
};

/** Mark today's row exhausted (daily quota hit). Creates the row if needed. */
ProviderQuota.markExhausted = async function (provider, day = ProviderQuota.today()) {
  await this.findOrCreate({ where: { provider, day_utc: day }, defaults: { count: 0 } });
  await this.update({ exhausted_at: new Date() }, { where: { provider, day_utc: day } });
};

/** Is the provider marked exhausted for today? */
ProviderQuota.isExhausted = async function (provider, day = ProviderQuota.today()) {
  const row = await this.findOne({ where: { provider, day_utc: day } });
  return Boolean(row?.exhausted_at);
};

export default ProviderQuota;
