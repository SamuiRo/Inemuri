const Discord = require("./bot/discord")
const Telegram = require("./bot/telegram")
const { intro } = require("./awesome/message")

async function START() {
    intro()
    await Discord.launch()
    await Telegram.launch()
}

START()