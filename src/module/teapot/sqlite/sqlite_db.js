import { Sequelize } from "sequelize";

import { print, printStack } from "../../../shared/utils.js";
import { NODE_ENV, SQLITE_STORAGE, DB_POOL } from "../../../config/app.config.js";

export class Database {
  sequelize;
  #isConnected = false; // приватне поле

  constructor() {
    this.sequelize = new Sequelize({
      dialect: "sqlite",
      storage: SQLITE_STORAGE, // абсолютний шлях
      logging: false,
      // IMMEDIATE, а не DEFERRED за замовчуванням. Sequelize відкриває кожну
      // транзакцію на окремому з'єднанні SQLite, а findOrCreate (ingest
      // TheFlow) — це транзакція SELECT → INSERT. Дві DEFERRED-транзакції
      // спершу обидві беруть SHARED, потім обидві хочуть писати — SQLite
      // віддає одній SQLITE_BUSY одразу, без busy_timeout (дедлок). Під
      // listener + polling + воркером так падала третина вставок. IMMEDIATE
      // бере блокування запису на BEGIN, і конкуренти просто чекають.
      transactionType: "IMMEDIATE",
      pool: {
        max: DB_POOL.max,
        min: DB_POOL.min,
        acquire: DB_POOL.acquireMs,
        idle: DB_POOL.idleMs,
      },
      define: {
        freezeTableName: true,
        underscored: false,
      },
    });
  }

  async connect() {
    if (this.#isConnected) {
      print("Database already connected", "warning");
      return;
    }

    try {
      await this.sequelize.authenticate();
      print("Database connection established successfully");
      this.#isConnected = true;
    } catch (error) {
      print("Unable to connect to the database: " + error.message, "error");
      printStack(error);
      throw error;
    }
  }

  async sync(options = {}) {
    if (!this.#isConnected) {
      throw new Error("Database must be connected before syncing");
    }

    try {
      // development перестворює таблиці (force) — див. CLAUDE.md, Operational
      // cautions. Ніколи не alter: на SQLite це перебудова всієї таблиці.
      const syncOptions = NODE_ENV === "development" ? { force: true, ...options } : { ...options };
      await this.sequelize.sync(syncOptions);
      print("Database synchronized successfully", "success");
    } catch (error) {
      print("Database sync error: " + error.message, "error");
      printStack(error);
      throw error;
    }
  }

  async disconnect() {
    if (this.#isConnected) {
      await this.sequelize.close();
      this.#isConnected = false;
      print("Database connection closed");
    }
  }

  get isConnected() {
    return this.#isConnected;
  }
}

// Singleton pattern
const database = new Database();
export default database;
