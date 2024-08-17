const os = require("os")
const input = require("input") // npm i input
const { TelegramClient } = require("telegram")
const { StringSession } = require("telegram/sessions")

const pkg = require("./../package.json")
const { load_sheet, load_rows } = require("./spreadsheet")
const { SESSION, API_ID, API_HASH } = require("./../config/telegram-config")
const Discord = require("./discord")
const Translator = require("./../bot/translator")
const { print, _error, alarm, telegram_log } = require("./../shared/utility")
const Telegram_Channel = require("../module/sqlite/models/Telegram_Channel")

const stringSession = new StringSession(SESSION) // fill this later with the value from session.save()
const client_options = {
    deviceModel: `${pkg.name}@${os.hostname()}`,
    systemVersion: os.version() || "Unknown node",
    appVersion: pkg.version,
    useWSS: true, // not sure if it works in node at all
    testServers: false,// this one should be the default for node env, but who knows for sure :)
    connectionRetries: 5
}
const client = new TelegramClient(stringSession, API_ID, API_HASH, client_options)
const message_groups = {}
let rows

async function launch() {
    try {
        print("Launch Telegram client")
        await client.start({
            phoneNumber: async () => await input.text("number ?"),
            password: async () => await input.text("password ?"),
            phoneCode: async () => await input.text("code ?"),
            onError: (err) => console.log(err),
        })

        // const sheet = await load_sheet(1)
        // rows = await load_rows(sheet)

        print("Add Event Handler")
        client.addEventHandler(handle_update)
        print("You should now be connected")
        // console.log("------------------")
        // console.log(client.session.save()) // Save this string to avoid logging in again
        // console.log("------------------")
        // await client.sendMessage("me", { message: client.session.save() })
    } catch (error) {
        console.log(error)
    }
}

async function handle_update(update) {
    try {
        if (!update.message) return
        if (!update.message.senderId) return
        if (update.className !== "UpdateNewChannelMessage") return
        // const options = rows.find(element => { return +element.channelId == update.message.senderId.value })
        const options = await Telegram_Channel.findOne({ where: { channel_id: update.message.senderId.value } })
        console.log(options)
        if (!options) return
        await telegram_log(`${update.message.senderId} ${options.channel_name}`)
        print("Update")

        if (typeof options.discord_group == "string") {
            options.discord_group.split(" ")
        }

        if (update.message.groupedId) {
            if (!message_groups[update.message.groupedId]) {
                message_groups[update.message.groupedId] = [];
            }
            message_groups[update.message.groupedId].push(update.message);

            // Встановіть таймер для опрацювання групи повідомлень після 5 секунд
            clearTimeout(message_groups[update.message.groupedId].timer);
            message_groups[update.message.groupedId].timer = setTimeout(() => {
                process_message_group(options, update.message.groupedId);
            }, 5000);
            return
        }

        options.messages = [update.message]
        await forward_to_discord(options)
    } catch (error) {
        _error(error.message)
    }
}

async function forward_to_discord(options) {
    let discord_message = {
        pictures: []
    }
    try {
        for (let message of options.messages) {
            if (message?.media?.className === "MessageMediaPhoto") {
                const downloaded_media = await client.downloadMedia(message.media, {})
                discord_message.pictures.push(downloaded_media)
            }
        }

        if (options.translate == "TRUE") {
            return
            // const text = await Translator.translate(options.message.message)
            // options.message.message = text
        }

        if (typeof options.discord_group === "string") {
            discord_message.discord_group = options.discord_group.split(" ")
        }

        discord_message.message = options.messages[0].message
        discord_message.channelName = options.channelName
        discord_message.sub_tittle = options.sub_tittle

        for (let channel of options.discord_group) {
            await Discord.sendToChannel(channel, discord_message)
        }
    } catch (error) {
        _error(error)
        alarm(`ERROR | FRWRD_TO_DSCRD | ${error.message}`)
        // alarm(`message: \nchannelName: ${options.channelName}\nmessageLength: ${options.message.message.length}`)
    }
}

async function process_message_group(options, group_id) {
    try {
        options.messages = message_groups[group_id];
        await forward_to_discord(options);
        delete message_groups[group_id];
    } catch (error) {
        console.log(error)
    }
}

module.exports = {
    launch
}