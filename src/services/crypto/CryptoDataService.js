import axios from "axios";
import * as cheerio from "cheerio";
import { CMC_API_KEY, CRYPTO_API } from "../../config/app.config.js";
import { print, printStack } from "../../shared/utils.js";

/**
 * CryptoDataService - сервіс для отримання даних з крипто API
 * Підтримує CoinMarketCap, Fear & Greed Index, Altseason Index
 */
class CryptoDataService {
  constructor() {
    this.cmcApiKey = CMC_API_KEY;

    if (!this.cmcApiKey) {
      print("[CryptoDataService] CMC API key not provided", "warning");
    }
  }

  /**
   * Отримати глобальні метрики крипторинку від CoinMarketCap
   * @returns {Promise<Object>} Глобальні метрики
   */
  async getGlobalMetrics() {
    try {
      const response = await axios.get(
        CRYPTO_API.globalMetrics,
        {
          headers: {
            "X-CMC_PRO_API_KEY": this.cmcApiKey,
          },
        },
      );

      return response.data.data;
    } catch (error) {
      print(
        `[CryptoDataService] Error in getGlobalMetrics: ${error.message}`,
        "error",
      );
      printStack(error);
      throw error;
    }
  }

  /**
   * Знайти токен за тікером в топ-100 CoinMarketCap
   * @param {string} ticker - Тікер токена (наприклад, 'BTC', 'ETH')
   * @returns {Promise<Object|null>} Дані токена або null якщо не знайдено
   */
  async findToken(ticker) {
    try {
      const response = await axios.get(
        CRYPTO_API.listings,
        {
          headers: {
            "X-CMC_PRO_API_KEY": this.cmcApiKey,
          },
        },
      );

      const token = response.data.data.find(
        (crypto) => crypto.symbol.toLowerCase() === ticker.toLowerCase(),
      );

      return token || null;
    } catch (error) {
      print(
        `[CryptoDataService] Error in findToken: ${error.message}`,
        "error",
      );
      printStack(error);
      throw error;
    }
  }

  /**
   * Отримати Fear and Greed Index
   * @returns {Promise<Object>} { value: number, classification: string }
   */
  async getFearAndGreedIndex() {
    try {
      const response = await axios.get(CRYPTO_API.fearAndGreed);

      return {
        value: response.data.data[0].value,
        classification: response.data.data[0].value_classification,
      };
    } catch (error) {
      print(
        `[CryptoDataService] Error in getFearAndGreedIndex: ${error.message}`,
        "error",
      );
      printStack(error);
      throw error;
    }
  }

  /**
   * Отримати Altseason Index
   * @returns {Promise<Object>} { index: string, status: string }
   */
  async getAltseasonIndex() {
    try {
      const response = await axios.get(
        CRYPTO_API.altcoinSeason,
      );

      const $ = cheerio.load(response.data);

      const index = $(
        "#season > div > div > div:nth-child(3) > div:nth-child(1)",
      ).text();
      const status = $(
        "#season > div > div > div.text-center.m-3 > span",
      ).text();

      return { index, status };
    } catch (error) {
      print(
        `[CryptoDataService] Error in getAltseasonIndex: ${error.message}`,
        "error",
      );
      printStack(error);
      throw error;
    }
  }
}

export default CryptoDataService;
