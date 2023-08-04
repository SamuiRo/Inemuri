const os = require("os")
const input = require("input") // npm i input
const { TelegramClient } = require("telegram")
const { StringSession } = require("telegram/sessions")

const pkg = require("./../package.json")
const { white_list, test_wl } = require("./../config/config.json")
const { load_sheet, load_rows } = require("./spreadsheet")
const { SESSION, API_ID, API_HASH } = require("./../config/telegram-config")
const Discord = require("./discord")
const Translator = require("./../bot/translator")
const { print, _error, alarm } = require("./../shared/utility")

const stringSession = new StringSession(SESSION) // fill this later with the value from session.save()
const client_options = {
    deviceModel: `${pkg.name}@${os.hostname()}`,
    systemVersion: os.version() || "Unknown node",
    appVersion: pkg.version,
    useWSS: true, // not sure if it works in node at all
    testServers: false,// this one should be the default for node env, but who knows for sure :)
    connectionRetries: 5
}
let client

async function launch() {
    print("Launch Telegram client")
    client = new TelegramClient(stringSession, API_ID, API_HASH, client_options)
    await client.start({
        phoneNumber: async () => await input.text("number ?"),
        password: async () => await input.text("password ?"),
        phoneCode: async () => await input.text("code ?"),
        onError: (err) => console.log(err),
    })

    const sheet = await load_sheet(1)
    const rows = await load_rows(sheet)

    print("Add Event Handler")
    client.addEventHandler(async (update) => {
        try {
            if (!update.message) return
            if (!update.message.senderId) return
            if (update.className !== "UpdateNewChannelMessage") return
            const options = rows.find(element => { return +element.channelId == update.message.senderId.value })

            if (options) {
                print("Update")
                options.message = update.message
                await forward_to_discord(options)
            }
        } catch (error) {
            _error(error.message)
        }
    })
    print("You should now be connected")
    // console.log("------------------")
    // console.log(client.session.save()) // Save this string to avoid logging in again
    // console.log("------------------")
    // await client.sendMessage("me", { message: client.session.save() })
}

async function forward_to_discord(options) {
    try {

        if (options.message.media && options.message.media.className == "MessageMediaPhoto") {
            const downloadedMedia = await client.downloadMedia(options.message.media, {})
            options.picture = downloadedMedia
        }

        if (options.translate == "TRUE") {
            return
            // const text = await Translator.translate(options.message.message)
            // options.message.message = text
        }
        options.discord_group = options.discord_group.split(' ')
        for (let channel of options.discord_group) {
            try {
                await Discord.sendToChannel(channel, { ...options })
            } catch (error) {
                _error(error.message)
                await alarm(error.message)
            }
        }
        delete options.picture

    } catch (error) {
        _error(error.message)
        await alarm(error.message)
    }
}

module.exports = {
    launch
}