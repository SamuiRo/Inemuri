const { Client, Events, GatewayIntentBits, AttachmentBuilder, EmbedBuilder } = require("discord.js")

const { print, localeDate } = require("./../shared/utility")
const { DISCORD_BOT_TOKEN } = require("./../config/discord-config")

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
})

async function sendMessageToChannel(channelID, options) {
    const channel = client.channels.cache.get(channelID)
    if (channel) {
        const embed = new EmbedBuilder()
            .setColor(0xe98ca1)
            .setAuthor({ name: `┍━━━━━ Rate ${options.sub_tittle}/5` })
            .setTitle(`〓 ${options.channelName}`)
            .setDescription(options.message)
            .setFooter({ text: `${localeDate()}` })

        const messageObj = await channel.send({
            embeds: [embed],
        })
        print(`Sended ${messageObj}`)
    } else {
        print(`Could not find channel with ID ${channelID}`)
    }
}

async function sendMessageWithPictureToChannel(channelID, options, picture) {
    const channel = client.channels.cache.get(channelID)
    if (channel) {
        try {
            if (options.message === "") options.message = "Picture"

            const imageAttachment = new AttachmentBuilder(picture, { name: "image.jpg" })
            const embed = new EmbedBuilder()
                .setColor(0xe98ca1)
                .setAuthor({ name: `┍━━━━━ Rate ${options.sub_tittle}/5` })
                .setTitle(`〓 ${options.channelName}`)
                .setDescription(options.message)
                .setImage("attachment://image.jpg")
                .setFooter({ text: `${localeDate()}` })

            const messageObj = await channel.send({
                embeds: [embed],
                files: [imageAttachment]
            })

            print(`Sended ${messageObj}`)
        } catch (error) {
            print(error.message)
        }
    } else {
        print(`Could not find channel with ID ${channelID}`)
    }
}

async function launch() {
    await client.login(DISCORD_BOT_TOKEN)
    await client_ready()
}

async function client_ready() {
    return new Promise((resolve, reject) => {
        try {
            client.once("ready", () => {
                print("Inemuri is online!")
                resolve(client)
            })
        } catch (error) {
            print(error.message)
            reject(error)
        }
    })
}

module.exports = {
    sendMessageToChannel,
    sendMessageWithPictureToChannel,
    launch
}