require("dotenv").config()

module.exports = {
    API_ID: +process.env.API_ID,
    API_HASH: process.env.API_HASH,
    SESSION: process.env.SESSION,
    SECRETARY_TELEGRAM_BOT_TOKEN: process.env.SECRETARY_TELEGRAM_BOT_TOKEN,
    SECRETARY_TELEGRAM_CHAT_ID: +process.env.SECRETARY_TELEGRAM_CHAT_ID,
    TELEGRAM_LOG_BOT_TOKEN: process.env.TELEGRAM_LOG_BOT_TOKEN,
    TELEGRAM_LOG_CHAT_ID: +process.env.TELEGRAM_LOG_CHAT_ID,
}