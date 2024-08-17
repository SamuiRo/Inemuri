const sequelize = require('../sqlite_db');
const { DataTypes } = require('sequelize')

const Routine = sequelize.define("Routine", {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    project: {
        type: DataTypes.STRING,
        allowNull: false,
        // defaultValue: []
    },
    rate: {
        type: DataTypes.STRING,
        allowNull: false
    },
    tier: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    status: {
        type: DataTypes.STRING,
        allowNull: false
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    url: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: false,
        unique: false
    },
    tags: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: []
    },
    details: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: {}
    },
    category: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    last_synced_at: {
        type: DataTypes.DATE,
    }
});

module.exports = Routine