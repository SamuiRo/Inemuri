const Discord = require("./bot/discord")
const Telegram = require("./bot/telegram")
const Translator = require("./bot/translator")
const Spreadsheet = require("./bot/spreadsheet")
const Gmail = require("./module/gmail/gmail")
const { intro } = require("./awesome/message")
const { _error, alarm } = require("./shared/utility")

async function START() {
    try {
        intro()
        await Spreadsheet.ss_connect()
        // await Translator.launch()
        await Discord.launch()
        await Telegram.launch()
        await Gmail.launch()
    } catch (error) {
        _error(error.message)
        alarm(`ERROR | MAIN_LAUNCH | ${error.message}`)
    }
}

START()