import { DataTypes } from "sequelize";
import database from "../sqlite/sqlite_db.js";

export const Source = database.sequelize.define("Source", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  platform: {
    type: DataTypes.ENUM('telegram', 'discord'),
    allowNull: false,
    comment: 'Тип платформи-джерела'
  },
  channel_id: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    comment: 'ID каналу/чату на платформі'
  },
  channel_name: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Назва каналу для зручності'
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    comment: 'Чи активне пересилання з цього джерела'
  },
  // Препроцесинг тексту перед фільтрацією
  text_replacements: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: {
      enabled: false,
      patterns: []  // [{ pattern: "regex or string", replacement: "", flags: "gi" }]
    },
    comment: 'Видалення/заміна тексту перед фільтрацією (футери, шапки, тощо)'
  },
  // Фільтри зберігаємо як JSON - просто і ефективно
  filters: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: {
      enabled: false,
      keywords: [],           // Масив ключових слів для пошуку
      blacklist: [],         // Масив слів для блокування
      case_sensitive: false  // Чи враховувати регістр
    },
    comment: 'Налаштування фільтрації повідомлень'
  },
  // Куди відправляти повідомлення
  destinations: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: {
      telegram: [],  // ['channel_id1', 'channel_id2']
      discord: []    // ['channel_id1', 'channel_id2']
    },
    comment: 'Список отримувачів для кожної платформи'
  }
}, {
  tableName: 'sources',
  timestamps: true,
  indexes: [
    {
      fields: ['platform', 'channel_id']
    },
    {
      fields: ['is_active']
    }
  ]
});

// ==================== STATIC МЕТОДИ ====================

/**
 * Отримати всі активні джерела для платформи
 */
Source.getActiveByPlatform = async function(platform) {
  return await this.findAll({
    where: { 
      platform,
      is_active: true 
    }
  });
};

/**
 * Отримати тільки ID активних каналів
 */
Source.getActiveChannelIds = async function(platform) {
  const sources = await this.getActiveByPlatform(platform);
  return sources.map(source => source.channel_id);
};

/**
 * Перевірити чи канал в білому списку
 */
Source.isChannelWhitelisted = async function(platform, channelId) {
  const source = await this.findOne({
    where: { 
      platform,
      channel_id: String(channelId),
      is_active: true 
    }
  });
  return !!source;
};

/**
 * Отримати джерело з фільтрами
 */
Source.getSourceWithFilters = async function(platform, channelId) {
  return await this.findOne({
    where: { 
      platform,
      channel_id: String(channelId),
      is_active: true 
    }
  });
};

// ==================== INSTANCE МЕТОДИ ====================

/**
 * Препроцесинг тексту - видалення футерів, шапок, тощо
 * Викликається ПЕРЕД фільтрацією
 */
Source.prototype.preprocessText = function(messageText) {
  if (!messageText || typeof messageText !== 'string') {
    return messageText;
  }

  // Якщо препроцесинг не налаштований - повертаємо оригінал
  if (!this.text_replacements || !this.text_replacements.enabled) {
    return messageText;
  }

  let processedText = messageText;

  // Застосовуємо всі патерни послідовно
  if (this.text_replacements.patterns && Array.isArray(this.text_replacements.patterns)) {
    for (const item of this.text_replacements.patterns) {
      if (!item.pattern) continue;

      try {
        // Якщо це regex (має flags або спеціальні символи)
        if (item.is_regex || item.flags) {
          const regex = new RegExp(item.pattern, item.flags || 'gi');
          processedText = processedText.replace(regex, item.replacement || '');
        } else {
          // Проста заміна рядка (швидше для простих випадків)
          processedText = processedText.replaceAll(item.pattern, item.replacement || '');
        }
      } catch (error) {
        console.error(`[Source ${this.id}] Invalid replacement pattern:`, item.pattern, error);
      }
    }
  }

  return processedText.trim();
};

/**
 * Перевірка повідомлення на відповідність фільтрам
 * Повертає true якщо повідомлення проходить фільтрацію
 * 
 * ВАЖЛИВО: Спочатку робиться preprocessText, потім фільтрація
 */
Source.prototype.passesFilter = function(messageText) {
  // Крок 1: Препроцесинг тексту
  const processedText = this.preprocessText(messageText);

  // Крок 2: Фільтрація
  // Якщо фільтри не налаштовані - пропускаємо все
  if (!this.filters || !this.filters.enabled) {
    return true;
  }

  const text = this.filters.case_sensitive 
    ? processedText 
    : processedText.toLowerCase();

  // Перевіряємо blacklist (пріоритет!)
  if (this.filters.blacklist && this.filters.blacklist.length > 0) {
    const blacklist = this.filters.case_sensitive
      ? this.filters.blacklist
      : this.filters.blacklist.map(w => w.toLowerCase());
    
    // Якщо знайшли заборонене слово - блокуємо
    if (blacklist.some(word => text.includes(word))) {
      return false;
    }
  }

  // Якщо є whitelist keywords - перевіряємо їх
  if (this.filters.keywords && this.filters.keywords.length > 0) {
    const keywords = this.filters.case_sensitive
      ? this.filters.keywords
      : this.filters.keywords.map(w => w.toLowerCase());
    
    // Має містити хоча б одне ключове слово
    return keywords.some(word => text.includes(word));
  }

  // Якщо немає ні blacklist, ні keywords - пропускаємо
  return true;
};

/**
 * Отримати список отримувачів для конкретної платформи
 */
Source.prototype.getDestinations = function(platform) {
  if (!this.destinations || !this.destinations[platform]) {
    return [];
  }
  return this.destinations[platform];
};

/**
 * Отримати всі отримувачі
 */
Source.prototype.getAllDestinations = function() {
  return this.destinations || { telegram: [], discord: [] };
};

export default Source;