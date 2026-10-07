import { HOUR } from "../../../shared/time.js";
import { DataTypes, Op } from "sequelize";
import database from "../sqlite/sqlite_db.js";
import { hammingDistance, SAME_IMAGE_MAX_DISTANCE } from "../../../shared/image.js";

/**
 * Кеш транскрипцій vision (ROADMAP §4, VISION.md gate 3).
 *
 * Той самий скріншот у п'яти каналах має коштувати один vision-виклик, а не
 * п'ять. Постійний, а не в пам'яті, з тієї ж причини, що й реєстр квоти:
 * після рестарту кеш у пам'яті порожній, і все, що вже оплачено, оплачувалось
 * би знову.
 *
 * **Пошук — за відстанню Геммінга, не за рівністю хешу.** Виміряно: перепост
 * після перестискання Telegram майже ніколи не має відстані 0 (4–7 біт), тож
 * ключ за точним збігом промахувався б майже на кожному перепості, і
 * найбільша економія зі специфікації не настала б.
 *
 * Відстань у SQL не індексується, тому пошук іде в JS по вікну свіжих
 * записів із жорсткою стелею на скан. Обсяг скріншотів за кілька днів
 * невеликий, тож це дешевше, ніж здається.
 *
 * Кешується і `legible: false`: нечитабельний перепост не має оплачуватись
 * повторно лише тому, що першого разу тексту не знайшлося.
 */
export const VisionCache = database.sequelize.define("VisionCache", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  image_hash: {
    type: DataTypes.STRING(16),
    allowNull: false,
    comment: "dHash зменшеної копії, 16 hex. НЕ унікальний: схожі знімки дають різні хеші",
  },
  text_ocr: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
  description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
  legible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  model: { type: DataTypes.STRING, allowNull: true },
}, {
  tableName: "vision_cache",
  timestamps: true,
  updatedAt: false,
  indexes: [
    { fields: ["createdAt"], name: "vision_cache_created_at" },
    { fields: ["image_hash"], name: "vision_cache_image_hash" },
  ],
});

/** Скільки записів максимум розглядати за один пошук. */
export const VISION_CACHE_SCAN_LIMIT = 5_000;

/**
 * Найближчий збережений запис у межах порогу, або null.
 *
 * Спершу точний збіг — він дешевий і покривається індексом; далі скан
 * свіжого вікна за відстанню.
 *
 * @param {string} hash
 * @param {{ttlHours?: number, maxDistance?: number, now?: Date, scanLimit?: number}} [opts]
 * @returns {Promise<{row: object, distance: number}|null>}
 */
VisionCache.nearest = async function (hash, opts = {}) {
  if (typeof hash !== "string" || !/^[0-9a-f]{16}$/i.test(hash)) return null;
  const {
    ttlHours = 72,
    maxDistance = SAME_IMAGE_MAX_DISTANCE,
    now = new Date(),
    scanLimit = VISION_CACHE_SCAN_LIMIT,
  } = opts;
  const since = new Date(now.getTime() - ttlHours * HOUR);

  const exact = await this.findOne({
    where: { image_hash: hash, createdAt: { [Op.gte]: since } },
    order: [["createdAt", "DESC"]],
  });
  if (exact) return { row: exact, distance: 0 };

  const candidates = await this.findAll({
    where: { createdAt: { [Op.gte]: since } },
    order: [["createdAt", "DESC"]],
    limit: scanLimit,
    attributes: ["id", "image_hash"],
  });

  let best = null;
  for (const c of candidates) {
    const d = hammingDistance(hash, c.image_hash);
    if (d === null || d > maxDistance) continue;
    if (!best || d < best.distance) {
      best = { id: c.id, distance: d };
      if (d === 1) break; // 0 уже перевірено точним пошуком — ближче не буде
    }
  }
  if (!best) return null;
  return { row: await this.findByPk(best.id), distance: best.distance };
};

/** Зберегти результат vision-виклику. */
VisionCache.store = async function (hash, { text_ocr, description, legible, model }) {
  return this.create({
    image_hash: hash,
    text_ocr: text_ocr ?? "",
    description: description ?? "",
    legible: legible !== false,
    model: model ?? null,
  });
};

/** Прибрати записи, старші за TTL. Повертає кількість видалених. */
VisionCache.sweep = async function ({ ttlHours = 72, now = new Date() } = {}) {
  const before = new Date(now.getTime() - ttlHours * HOUR);
  return this.destroy({ where: { createdAt: { [Op.lt]: before } } });
};

export default VisionCache;
