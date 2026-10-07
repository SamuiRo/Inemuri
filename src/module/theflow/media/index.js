import mediaResolver from "./MediaResolver.js";

// Реєстр без реєстрацій. Резолвери живуть у своїх платформах
// (src/sources/telegram/TelegramMediaResolver.js, src/sources/feeds/UrlMediaResolver.js)
// і реєструються в корені композиції (src/inemuri.js): TheFlow не імпортує
// ні Telegram, ні HTTP-клієнт стрічок — лише контракт resolve(post).
export { MediaResolver } from "./MediaResolver.js";
export default mediaResolver;
