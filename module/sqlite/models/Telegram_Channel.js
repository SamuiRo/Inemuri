const sequelize = require('../sqlite_db');
const { DataTypes } = require('sequelize')

const Telegram_Channel = sequelize.define("Telegram_Channel", {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    channel_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true
    },
    channel_name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    sub_tittle: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    channel_category: {
        type: DataTypes.STRING,
        allowNull: false
    },
    discord_group: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: []
    },
    telegram_group: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: []
    },
    translate: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        unique: false
    },
    forwarding: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        unique: false
    },
    last_synced_at: {
        type: DataTypes.DATE,
    }
});

module.exports = Telegram_Channel