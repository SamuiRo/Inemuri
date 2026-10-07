import { DataTypes } from "sequelize";
import database from "../sqlite/sqlite_db.js";

export const Source = database.sequelize.define("Source", {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  // reddit / rss — опитування стрічок (ROADMAP §7, src/sources/feeds/).
  // У SQLite ENUM — це TEXT без CHECK, тож нові значення не потребують міграції.
  platform: {
    type: DataTypes.ENUM('telegram', 'discord', 'reddit', 'rss'),
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
  // Режим прослуховування:
  //   listener — тільки MTProto UpdateNewChannelMessage (дефолт, легкий)
  //   polling  — тільки активний polling через getMessages (для великих каналів)
  //   both     — listener + polling (дедуплікація через SourceState)
  mode: {
    type: DataTypes.ENUM('listener', 'polling', 'both'),
    allowNull: false,
    defaultValue: 'listener',
    comment: 'Режим отримання повідомлень'
  },
  // Як часто опитувати це джерело, у хвилинах. NULL = глобальний дефолт
  // (POLLING_INTERVAL_MIN). Дає розвести тихі канали на раз на добу, а
  // активні — на хвилини, не чіпаючи решту. Див. getPollIntervalMin().
  poll_interval_min: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment: 'Інтервал полінгу цього джерела (хв). NULL = глобальний дефолт'
  },
  // Налаштування стрічки для platform "rss" (NEWS_INTAKE.md §2.1):
  // { discovery: "rss" | "sitemap" | "wpjson" }. NULL = звичайна RSS/Atom.
  // Див. src/sources/feeds/discovery.js. Міграція 016.
  feed: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: null,
    comment: 'Як шукати нові статті: { discovery }. NULL = RSS/Atom'
  },
  // Типи медіа, які качати ДОДАТКОВО до глобального DOWNLOADABLE_MEDIA_TYPES.
  // NULL = лише глобальний список. Додавальне, не перевизначення: повний
  // список легко задати без "photo" і тихо втратити всі зображення.
  // Див. getDownloadableMediaTypes() і docs/media.md.
  extra_media_types: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: null,
    comment: 'Додаткові типи медіа для завантаження (напр. ["audio"])'
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
  },
  // ── TheFlow ────────────────────────────────────────────────────────────
  // Налаштування підсистеми TheFlow для цього джерела.
  //   enabled: false — класичний форвардинг (поточна поведінка), дефолт.
  //   enabled: true  — джерело йде через конвеєр TheFlow:
  //                    ingest → posts(pending) → enrich → flow.
  // Наявні джерела не змінюють поведінку, поки їх явно не переключать.
  // Повна специфікація полів — docs/theflow/DATA_MODEL.md.
  flow: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: {
      enabled: false,           // false = класичний форвардинг
      topics: null,             // null = усі топіки; або ["games", "market"]
      min_confidence: 0.6,      // нижче — пост іде в #unsorted, а не в смітник
      dedup_window_hours: null, // null = успадкувати з категорії
      vision: {                 // див. docs/theflow/VISION.md
        enabled: false,         // вмикання TheFlow НЕ вмикає vision
        text_threshold: 200,    // пропускати зображення, якщо тексту вже >= стільки
        max_images_per_post: 2
      }
    },
    comment: 'Налаштування TheFlow для цього джерела'
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
    },
    {
      fields: ['mode']
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

// ==================== INSTANCE МЕТОДИ ====================

/**
 * Отримати всі отримувачі
 */
Source.prototype.getAllDestinations = function() {
  return this.destinations || { telegram: [], discord: [] };
};

// ==================== Полінг ====================

/**
 * Інтервал полінгу цього джерела у хвилинах.
 *
 * NULL у колонці означає «як усі» — глобальний дефолт передається аргументом,
 * щоб модель не тягнула app.config.js (і щоб це було чистою функцією у тесті).
 * Нечисле, нуль і відʼємне трактуються як NULL: краще опитати за дефолтом,
 * ніж вирішити, що інтервал нульовий, і піти в тугий цикл.
 */
Source.prototype.getPollIntervalMin = function(globalDefaultMin) {
  const raw = Number(this.poll_interval_min);
  return Number.isFinite(raw) && raw > 0 ? raw : globalDefaultMin;
};

/**
 * Повний список типів медіа для завантаження з цього джерела.
 *
 * Глобальний список передається аргументом, щоб модель не тягнула
 * app.config.js. Порожній / некоректний `extra_media_types` не ламає базу:
 * повертаємо глобальний список як є.
 */
Source.prototype.getDownloadableMediaTypes = function(globalTypes) {
  const base = Array.isArray(globalTypes) ? globalTypes : [];
  let extra = this.extra_media_types;
  if (typeof extra === "string") {
    try { extra = JSON.parse(extra); } catch { extra = null; }
  }
  if (!Array.isArray(extra) || extra.length === 0) return base;
  return [...new Set([...base, ...extra.filter((t) => typeof t === "string" && t)])];
};

// ==================== TheFlow ====================

const FLOW_DEFAULTS = {
  enabled: false,
  topics: null,
  min_confidence: 0.6,
  dedup_window_hours: null,
  vision: {
    enabled: false,
    text_threshold: 200,
    max_images_per_post: 2,
  },
};

/**
 * Повна конфігурація TheFlow для джерела з підставленими дефолтами.
 * Рядки, засіяні до появи колонки `flow`, мають flow === null —
 * тоді повертаються дефолти (enabled: false), тобто класичний форвардинг.
 */
Source.prototype.getFlowConfig = function() {
  let raw = this.flow;
  // Захист: якщо колонка потрапила в БД як TEXT (не JSON), Sequelize віддає
  // сирий рядок замість об'єкта. Парсимо, а на невдачу — падаємо в дефолти.
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (!raw || typeof raw !== "object") raw = {};
  return {
    ...FLOW_DEFAULTS,
    ...raw,
    vision: { ...FLOW_DEFAULTS.vision, ...(raw.vision || {}) },
  };
};

/**
 * Чи проходить це джерело через конвеєр TheFlow.
 * false → класичний форвардинг (поточна поведінка Inemuri).
 */
Source.prototype.isFlowEnabled = function() {
  return this.getFlowConfig().enabled === true;
};

/**
 * Чи увімкнено vision-стадію (транскрипція скріншотів) для джерела.
 * Вимагає одночасно flow.enabled і flow.vision.enabled.
 */
Source.prototype.isVisionEnabled = function() {
  const flow = this.getFlowConfig();
  return flow.enabled === true && flow.vision.enabled === true;
};

export default Source;
