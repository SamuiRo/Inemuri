require("dotenv").config()

module.exports = {
    HEADLESS: process.env.HEADLESS == "true" ? true : false,
    WIEVPORT_WIDTH: +process.env.WIEVPORT_WIDTH,
    WIEVPORT_HEIGHT: +process.env.WIEVPORT_HEIGHT,
    GOOGLE_SPREADSHEET_TABLE_ID: process.env.GOOGLE_SPREADSHEET_TABLE_ID,
    ALLOWED_SPECIAL_USERS: process.env.ALLOWED_SPECIAL_USERS.split(","),
    ROUTINE_CHANNEL_ID: process.env.ROUTINE_CHANNEL_ID
}