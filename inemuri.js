const Discord = require("./bot/discord")
const Telegram = require("./bot/telegram")
const Translator = require("./bot/translator")
const { intro } = require("./awesome/message")
const { _error } = require("./shared/utility")

async function START() {
    try {
        intro()
        await Translator.launch()

        // console.log(typeof "222")
        // if (typeof "222" == "string"){console.log(2)}
        // await Discord.launch()
        // await Telegram.launch()
    } catch (error) {
        _error(error.message)
    }
}

START()