require("dotenv").config()

module.exports = {
    HEADLESS: process.env.HEADLESS == "true" ? true : false,
    WIEVPORT_WIDTH: +process.env.WIEVPORT_WIDTH,
    WIEVPORT_HEIGHT: +process.env.WIEVPORT_HEIGHT,
    GOOGLE_SPREADSHEET_TABLE_ID: process.env.GOOGLE_SPREADSHEET_TABLE_ID
}