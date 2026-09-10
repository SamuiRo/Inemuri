import mediaResolver from "./MediaResolver.js";
import TelegramMediaResolver from "./TelegramMediaResolver.js";

// Wire the resolvers that ship today. Registration only stores the instance;
// the GramJS client is resolved lazily on the first resolve() call, well
// after Telegram has connected. `UrlMediaResolver` is added here in phase 3.5.
mediaResolver.register("telegram", new TelegramMediaResolver());

export { MediaResolver } from "./MediaResolver.js";
export { TelegramMediaResolver };
export default mediaResolver;
