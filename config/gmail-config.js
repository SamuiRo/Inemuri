require("dotenv").config()

module.exports = {
    GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET,
    GMAIL_REDIRECT_URI: process.env.GMAIL_REDIRECT_URI.split(","),
    GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN,
    ALL_MAILS_CHAT_ID: process.env.ALL_MAILS_CHAT_ID,
    IMPORTANT_MAILS_CHAT_ID: process.env.IMPORTANT_MAILS_CHAT_ID
}