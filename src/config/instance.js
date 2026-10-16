import path from "path";
import { fileURLToPath } from "url";

/**
 * Тека розгортання `instance/` (docs/DEPLOYMENT.md): усе, що змінюється
 * з розгортанням і з роботою, — в одному місці, а не в src/ і database/.
 *
 *   instance/config/      sources, routing, triage, cron — те, що редагують
 *   instance/provision/   один сервер Discord — одна тека: server.json і тексти
 *   instance/knowledge/   мітки (JSONL)
 *   instance/database/    pot.sqlite і backups/
 *   instance/exports/     вивантаження /export-chats
 *
 * Тут лише будова; шлях до самої теки (INEMURI_INSTANCE_DIR) читає
 * app.config.js — змінні середовища живуть тільки там.
 */

/** Корінь репозиторію. */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Тека за замовчуванням. */
export const DEFAULT_INSTANCE_DIR = path.join(REPO_ROOT, "instance");

/** @param {string} dir корінь instance/ */
export function instanceLayout(dir) {
  return {
    root: dir,
    config: path.join(dir, "config"),
    provision: path.join(dir, "provision"),
    knowledge: path.join(dir, "knowledge"),
    database: path.join(dir, "database"),
    exports: path.join(dir, "exports"),
  };
}

/**
 * Де це лежало до v4.67.0. Читається ще одну версію, з попередженням, —
 * щоб сервер, на який прийшов код, але ще не `npm run instance:init`, не
 * стартував на семплах. Потім — видалити.
 */
export const LEGACY = Object.freeze({
  config: path.join(REPO_ROOT, "src", "config"),
  servers: path.join(REPO_ROOT, "src", "config", "discordapp", "servers"),
  messages: path.join(REPO_ROOT, "src", "config", "discordapp", "messages"),
  database: path.join(REPO_ROOT, "database"),
  exports: path.join(REPO_ROOT, "exports"),
});

/** Ім'я файлу конфігу в instance/config → ім'я, яке воно мало в src/config. */
export const LEGACY_CONFIG_NAMES = Object.freeze({ cron: "cronjob.config" });
