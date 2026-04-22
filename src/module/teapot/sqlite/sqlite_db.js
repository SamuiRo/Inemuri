import { Sequelize } from "sequelize";
import path from "path";

import { print } from "../../../shared/utils.js";
import { NODE_ENV } from "../../../config/app.config.js";

export class Database {
  sequelize;
  #isConnected = false; // приватне поле

  constructor() {
    this.sequelize = new Sequelize({
      dialect: "sqlite",
      storage: path.resolve(process.cwd() + "/database", "./pot.sqlite"), // абсолютний шлях
      logging: false,
      pool: {
        max: 5,
        min: 0,
        acquire: 30000,
        idle: 10000,
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
      console.error("Unable to connect to the database:", error);
      throw error;
    }
  }

  async sync(options = {}) {
    if (!this.#isConnected) {
      throw new Error("Database must be connected before syncing");
    }

    try {
      // Налаштування для різних середовищ
      // const syncOptions =
      //   NODE_ENV === "development"
      //     ? { force: true, ...options }
      //     : { alter: true, ...options };

          const syncOptions =
        NODE_ENV === "development"
          ? { force: true, ...options }
          : {  ...options };

          

      await this.sequelize.sync(syncOptions);
      print("Database synchronized successfully", "success");
    } catch (error) {
      print("Database sync error: " + error.message, "error");
      console.error("Database sync error:", error);
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
