const { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder } = require("discord.js")

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
            .setAuthor({ name: `┍━━━━━ ${options.sub_tittle}` })
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

        // await alarm(JSON.stringify(options))
    }
}

async function launch() {
    await client.login(DISCORD_BOT_TOKEN)
    await client_ready()
    await interaction()
}

async function client_ready() {
    try {
        client.application.commands.set([]);

        const slashCommandBuilders = [
            {
                name: 'gpt',
                description: 'Make a GPT request',
                type: 1, // 1 відповідає CHAT_INPUT
                options: [
                    {
                        name: 'prompt',
                        description: 'Prompt to ChatGPT',
                        type: 3, // 3 відповідає STRING
                        required: true,
                    },
                ],
            },
            {
                name: 'starknet-stats',
                description: 'Check your starknet address stats',
                type: 1, // 1 відповідає CHAT_INPUT
                options: [
                    {
                        name: 'addresses',
                        description: 'Your addresses separated by space',
                        type: 3, // 3 відповідає STRING
                        required: true,
                    },
                ],
            },
            {
                name: 'layerzero-stats',
                description: 'Check your layerzero address stats',
                type: 1, // 1 відповідає CHAT_INPUT
                options: [
                    {
                        name: 'address',
                        description: 'Only ONE address per request',
                        type: 3, // 3 відповідає STRING
                        required: true,
                    },
                ],
            },
        ];

        const commands = await Promise.all(
            slashCommandBuilders.map(builder =>
                client.application.commands.create(builder)
            )
        );

        print('Slash commands registered.');
        print("Inemuri is online!");

        return client;
    } catch (error) {
        console.error('Error while setting up the bot:', error);
        throw error;
    }
}

// async function client_ready() {
//     return new Promise((resolve, reject) => {
//         try {
//             client.once("ready", async () => {
//                 try {
//                     client.application.commands.set([])
//                     await client.application.commands.create(
//                         new SlashCommandBuilder().setName('gpt').setDescription('Make a GPT request').addStringOption(option =>
//                             option.setName('prompt')
//                                 .setDescription('Prompt to ChatGPT'))
//                     );
//                     await client.application.commands.create(
//                         new SlashCommandBuilder().setName('starknet-stats').setDescription('Check your starknet address stats').addStringOption(option =>
//                             option.setName('addresses')
//                                 .setDescription('Your addresses separate with space'))
//                     );
//                     await client.application.commands.create(
//                         new SlashCommandBuilder().setName('layerzero-stats').setDescription('Check your layerzero address stats').addStringOption(option =>
//                             option.setName('address')
//                                 .setDescription('Only ONE address per request'))
//                     );

//                     // await client.application.commands.create(
//                     //     new SlashCommandBuilder().setName('gptda').setDescription('Make a GPT request')
//                     // );
//                     print('Slash commands registered.');
//                 } catch (error) {
//                     console.error('Error while registering slash command:', error);
//                 }
//                 print("Inemuri is online!")
//                 resolve(client)
//             })
//         } catch (error) {
//             print(error.message)
//             reject(error)
//         }
//     })
// }

async function interaction() {
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isCommand()) return;

        const { commandName, options } = interaction;
        try {
            if (commandName === 'gpt') {
                const resp = await runCompletion();
                interaction.reply("tmprl closed");
            }
            if (commandName === 'starknet-stats') {
                const addresses = options.getString('addresses');
                const response = await check_starknet_address(addresses.split(" "));
                console.log(response)
                interaction.reply(response);
            }
            if (commandName === 'layerzero-stats') {
                const address = await options.getString("address");
                const response = await check_layerzero_address(address);
                console.log(response)
                interaction.reply(response);
            }
        } catch (error) {
            console.error(`Error while processing '${commandName}' command:`, error);
            interaction.reply('An error occurred while processing your request.');
        }
    });
}
// async function interaction() {
//     client.on('interactionCreate', async (interaction) => {
//         if (!interaction.isCommand()) reject;

//         const { commandName, options } = interaction;
//         if (commandName === 'gpt') {
//             try {
//                 const resp = await runCompletion()
//                 // const response = await axios.get(`http://localhost:${serverPort}`);
//                 interaction.reply("tmprl closed");
//             } catch (error) {
//                 console.error('Error while making the GPT request:', error);
//                 interaction.reply('An error occurred while processing your request.');
//             }
//         } else if (commandName === 'starknet-stats') {
//             try {
//                 const addresses = options.getString('addresses')
//                 const response = await check_starknet_address(addresses.split(" "))

//                 interaction.reply(response)
//             } catch (error) {
//                 interaction.reply('An error occurred while processing your request.');
//                 console.error(error);
//             }
//         } else if (commandName === 'layerzero-stats') {
//             try {
//                 const address = await options.getString("address")
//                 let response = await check_layerzero_address(address)

//                 interaction.reply(response);
//             } catch (error) {
//                 console.error('Error while making the layerzero request:', error);
//                 interaction.reply('An error occurred while processing your request.');
//             }
//         }
//     });
// }

module.exports = {
    // sendMessageToChannel,
    // sendMessageWithPictureToChannel,
    launch,
    sendToChannel
}