import "dotenv/config";

import pkg from "../../package.json" with { type: "json" };
import SourceConfig from "./sources.json" with { type: "json" };

export const NODE_ENV = process.env.NODE_ENV;
export const PKG = pkg;
export const SOURCE_CONFIG = SourceConfig;
export const TELEGRAM_SESSION =
  process.env.TELEGRAM_SESSION === "" ? null : process.env.TELEGRAM_SESSION;
export const TELEGRAM_API_ID = +process.env.TELEGRAM_API_ID;
export const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
export const CMC_API_KEY = process.env.CMC_API_KEY;
export const DISCORD_COMMAND_WHITELIST = process.env.DISCORD_COMMAND_WHITELIST
  ? process.env.DISCORD_COMMAND_WHITELIST.split(",").map((id) => id.trim())
  : [];
