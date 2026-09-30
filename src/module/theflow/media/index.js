import mediaResolver from "./MediaResolver.js";
import TelegramMediaResolver from "./TelegramMediaResolver.js";
import UrlMediaResolver from "./UrlMediaResolver.js";

// Wire the resolvers that ship today. Registration only stores the instance;
// the GramJS client is resolved lazily on the first resolve() call, well
// after Telegram has connected. `url` serves Reddit and RSS posts (phase 3.5).
mediaResolver.register("telegram", new TelegramMediaResolver());
mediaResolver.register("url", new UrlMediaResolver());

export { MediaResolver } from "./MediaResolver.js";
export { TelegramMediaResolver, UrlMediaResolver };
export default mediaResolver;
