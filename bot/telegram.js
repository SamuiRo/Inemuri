const os = require("os")
const input = require("input") // npm i input
const { TelegramClient } = require("telegram")
const { StringSession } = require("telegram/sessions")

const pkg = require("./../package.json")
const { white_list } = require("./../config/config.json")
const { SESSION, API_ID, API_HASH } = require("./../config/telegram-config")
const Discord = require("./discord")
const { print, _error } = require("./../shared/utility")

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

    print("Add Event Handler")
    client.addEventHandler(async (update) => {
        // console.log(update)
        try {
            if (update.message && update.message.senderId && update.className !== "UpdateEditChannelMessage" && white_list.find(element => { return element.channelId == update.message.senderId.value })) {
                print("Update")
                const options = white_list.find(element => { return element.channelId == update.message.senderId.value })
                if (options) print(JSON.stringify(options))
                await forward_to_discord(update.message, options)
            }
        } catch (error) {
            print(error.message)
        }
    })
    print("You should now be connected")
    // console.log("------------------")
    // console.log(client.session.save()) // Save this string to avoid logging in again
    // console.log("------------------")
    // await client.sendMessage("me", { message: client.session.save() })
}

async function forward_to_discord(message, options) {
    try {
        if (message.media !== null && message.media.className == "MessageMediaPhoto") {
            print("Media forward from " + options.channelName)
            for (let channel of options.discord_group) {
                try {
                    const downloadedMedia = await client.downloadMedia(message.media, {})
                    await Discord.sendMessageWithPictureToChannel(channel, { message: message.message, ...options }, downloadedMedia)
                } catch (error) {
                    _error(error.message)
                }
            }
            print("Message with media forwarded")
            return
        }
        if (message.media == null && message.message !== "") {
            print("Text forward from " + options.channelName)
            for (let channel of options.discord_group) {
                try {
                    await Discord.sendMessageToChannel(channel, { message: message.message, ...options })
                } catch (error) {
                    _error(error.message)
                }
            }
            print("Message forwarded")
            return
        }
    } catch (error) {
        print(error.message)
    }
}

module.exports = {
    launch
}