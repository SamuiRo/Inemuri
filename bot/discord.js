const { Client, Events, GatewayIntentBits, AttachmentBuilder, EmbedBuilder } = require("discord.js")

const { print, localeDate, alarm } = require("./../shared/utility")
const { DISCORD_BOT_TOKEN } = require("./../config/discord-config")

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
})

async function sendToChannel(channelID, options) {
    try {

        const channel = client.channels.cache.get(channelID)

        if (!channel) {
            print(`Could not find channel with ID ${channelID}`)
            return
        }
        if (options.message.message === "" || options.message.message === undefined) options.message.message = "Picture"
        const discord_message = {}

        const embed = new EmbedBuilder()
            .setColor(0xe98ca1)
            .setAuthor({ name: `┍━━━━━ Rate ${options.sub_tittle}/5` })
            .setTitle(`〓 ${options.channelName}`)
            .setDescription(options.message.message)
            .setFooter({ text: `${localeDate()}` })

        if (options.picture) {
            const imageAttachment = new AttachmentBuilder(options.picture, { name: "image.jpg" })
            embed.setImage("attachment://image.jpg")
            discord_message.files = [imageAttachment]
        }
        discord_message.embeds = [embed]

        const messageObj = await channel.send(discord_message)
        print(`Sended ${messageObj}`)
    } catch (error) {
        console.log(error)
        await alarm(error.message)
        console.log(options)
        console.log(options.message.message)
        // await alarm(JSON.stringify(options))
    }
}

async function sendMessageToChannel(channelID, options) {
    try {
        const channel = client.channels.cache.get(channelID)
        if (channel) {

            const embed = new EmbedBuilder()
                .setColor(0xe98ca1)
                .setAuthor({ name: `┍━━━━━ Rate ${options.sub_tittle}/5` })
                .setTitle(`〓 ${options.channelName}`)
                .setDescription(options.message.message)
                .setFooter({ text: `${localeDate()}` })

            const messageObj = await channel.send({
                embeds: [embed],
            })
            print(`Sended ${messageObj}`)
        } else {
            print(`Could not find channel with ID ${channelID}`)
        }
    } catch (error) {
        console.log(error.message)
        await alarm(error.message)
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
                .setDescription(options.message.message)
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
    launch,
    sendToChannel
}