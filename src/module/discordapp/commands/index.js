import daily from "./daily.js";
import exportChats from "./export-chats.js";
import provision, { confirmComponent as provisionConfirm } from "./provision.js";

/**
 * Усі slash-команди discordapp. Нова команда — новий файл у цій теці і рядок
 * тут; контракт описано в CommandRegistry.js.
 */
export const COMMANDS = [daily, exportChats, provision];

/** Обробники компонентів (кнопок, меню), за префіксом customId. */
export const COMPONENTS = [provisionConfirm];
