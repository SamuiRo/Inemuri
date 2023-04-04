const Discord = require("./bot/discord")
const Telegram = require("./bot/telegram")
const Translator = require("./bot/translator")
const { intro } = require("./awesome/message")
const { _error, alarm } = require("./shared/utility")

async function START() {
    try {
        intro()
        await Translator.launch()
        await Discord.launch()
        await Telegram.launch()
    } catch (error) {
        _error(error.message)
        await alarm(error.message)
    }
}

START()