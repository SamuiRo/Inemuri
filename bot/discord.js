const { Client, Events, GatewayIntentBits, AttachmentBuilder, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require("discord.js")

const { runCompletion } = require("./chat-gpt")
const { check_starknet_address, check_layerzero_address } = require("./crypto-api")

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
    await interaction()
}

async function client_ready() {
    return new Promise((resolve, reject) => {
        try {
            client.once("ready", async () => {
                try {
                    client.application.commands.set([])
                    await client.application.commands.create(
                        new SlashCommandBuilder().setName('gpt').setDescription('Make a GPT request').addStringOption(option =>
                            option.setName('prompt')
                                .setDescription('Prompt to ChatGPT'))
                    );
                    await client.application.commands.create(
                        new SlashCommandBuilder().setName('starknet-stats').setDescription('Check your starknet address stats').addStringOption(option =>
                            option.setName('addresses')
                                .setDescription('Your addresses separate with space'))
                    );
                    await client.application.commands.create(
                        new SlashCommandBuilder().setName('layerzero-stats').setDescription('Check your layerzero address stats').addStringOption(option =>
                            option.setName('address')
                                .setDescription('Only ONE address per request'))
                    );

                    // await client.application.commands.create(
                    //     new SlashCommandBuilder().setName('gptda').setDescription('Make a GPT request')
                    // );
                    print('Slash commands registered.');
                } catch (error) {
                    console.error('Error while registering slash command:', error);
                }
                print("Inemuri is online!")
                resolve(client)
            })
        } catch (error) {
            print(error.message)
            reject(error)
        }
    })
}

async function interaction() {
    return new Promise((resolve, reject) => {
        try {
            client.on('interactionCreate', async (interaction) => {
                if (!interaction.isCommand()) reject;

                const { commandName, options } = interaction;
                console.log(interaction)
                if (commandName === 'gpt') {
                    try {
                        const resp = await runCompletion()
                        // const response = await axios.get(`http://localhost:${serverPort}`);
                        interaction.reply("Dasd");
                    } catch (error) {
                        console.error('Error while making the GPT request:', error);
                        interaction.reply('An error occurred while processing your request.');
                    }
                } else if (commandName === 'starknet-stats') {
                    try {
                        const addresses = options.getString('addresses')
                        const response = await check_starknet_address(addresses.split(" "))

                        interaction.reply(response)
                    } catch (error) {
                        console.error('Error while making the starknet request:', error);
                        interaction.reply('An error occurred while processing your request.');
                    }
                } else if (commandName === 'layerzero-stats') {
                    try {
                        const address = await options.getString("address")
                        const response = await check_layerzero_address(address)
                        interaction.reply(response);
                    } catch (error) {
                        console.error('Error while making the layerzero request:', error);
                        interaction.reply('An error occurred while processing your request.');
                    }
                }
            });
        } catch (error) {

        }
    })
}

module.exports = {
    sendMessageToChannel,
    sendMessageWithPictureToChannel,
    launch,
    sendToChannel
}