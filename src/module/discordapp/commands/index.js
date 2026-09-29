import daily from "./daily.js";
import exportChats from "./export-chats.js";

/**
 * Усі slash-команди discordapp. Нова команда — новий файл у цій теці і рядок
 * тут; контракт описано в CommandRegistry.js.
 */
export const COMMANDS = [daily, exportChats];

/** Обробники компонентів (кнопок, меню), за префіксом customId. */
export const COMPONENTS = [];
