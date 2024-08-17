const Discord = require("./bot/discord")
const Telegram = require("./bot/telegram")
const Translator = require("./bot/translator")
const Spreadsheet = require("./bot/spreadsheet")
const Gmail = require("./module/gmail/gmail")
const { intro } = require("./awesome/message")
const { _error, alarm } = require("./shared/utility")
const { GOOGLE_SPREADSHEET_TABLE_ID } = require("./config/spreadsheet-config")
const sequelize = require("./module/sqlite/sqlite_db")

const { launch } = require("./module/syncwave/routine.sync")
const { load_telegram_channels_from_spreadsheets } = require("./module/synchro/spreadsheet.synchro")

async function START() {
    try {
        intro()
        await _connectDB()
        await Spreadsheet.ss_connect(GOOGLE_SPREADSHEET_TABLE_ID)
        await load_telegram_channels_from_spreadsheets()
        // await Translator.launch()
        await Discord.launch()
        await Telegram.launch()
        // await Gmail.launch()
        // await launch()
    } catch (error) {
        _error(error.message)
        alarm(`ERROR | MAIN_LAUNCH | ${error.message}`)
    }
}

async function _connectDB() {
    try {
        await sequelize.authenticate()
        await sequelize.sync()

        console.log("DB connected")
    } catch (error) {
        console.log(error)
    }
}

START()