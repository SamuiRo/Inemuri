/**
 * Словники значень, які зберігаються в базі: статуси, ролі, вердикти.
 *
 * Окремо від моделей навмисно. Модель тягне Sequelize і з'єднання з базою;
 * чистий модуль (валідація обміну знаннями, рендер, звіти), якому потрібен
 * лише список дозволених значень, не повинен відкривати SQLite заради масиву
 * рядків. Моделі імпортують ці списки звідси і ре-експортують їх.
 *
 * STRING-колонки, не ENUM: розширити список — правка тут і, якщо треба,
 * міграція з даними; ENUM на SQLite вимагав би перебудови таблиці.
 */

/** posts.status — життєвий цикл поста (docs/theflow/DATA_MODEL.md, «Statuses»). */
export const POST_STATUSES = Object.freeze([
  "pending",            // щойно записаний ingest-ом, чекає на enrich
  "enriched",           // отримав вердикт від LLMGateway
  "routed",             // доставлений у призначення
  "suppressed",         // дублікат, що нічого не додає
  "unsorted",           // низька впевненість або невідома категорія → #unsorted
  "skipped_blacklist",  // відсіяний regex-стадією: blacklist джерела
  "skipped_empty",      // порожній або коротший за поріг після replacements
  "skipped_noise",      // тільки емодзі / тільки посилання / службовий текст
  "skipped_shouty",     // короткий пост капсом (ритуальні/службові), опційно на джерело
  "skipped_short",      // коротший за filters.min_length джерела (без посилань), опційно
  "skipped_repost",     // точний хеш-збіг у вікні останніх N годин, те саме джерело (§6.1)
  "failed",             // спроби вичерпані; рядок лишається для розбору
]);

/** posts.link_role — роль поста всередині кластера (події). */
export const POST_LINK_ROLES = Object.freeze(["canonical", "linked", "duplicate", "correction"]);

/** post_feedback.verdict і knowledge_examples.verdict — один словник. */
export const FEEDBACK_VERDICTS = Object.freeze(["good", "noise", "wrong_topic", "missed"]);

/** knowledge_examples.level: цілий пост · лише заголовок (вхід triage) · повний текст статті. */
export const KNOWLEDGE_LEVELS = Object.freeze(["post", "headline", "article"]);

/** knowledge_examples.origin — звідки мітка; зберігається при імпорті. */
export const KNOWLEDGE_ORIGINS = Object.freeze(["review", "sampled_reject", "manual"]);

export const KNOWLEDGE_VERDICTS = FEEDBACK_VERDICTS;

/** discovered_items.status — кандидати triage (NEWS_INTAKE.md §2.2). */
export const TRIAGE_STATUSES = Object.freeze(["pending", "passed", "rejected", "failed"]);
