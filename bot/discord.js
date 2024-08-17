const { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder, MessageAttachment, MessageEmbed } = require("discord.js")
const { CronJob } = require("cron")

const { runCompletion } = require("./chat-gpt")
const { check_starknet_address, check_layerzero_address, cmc_global_metrics, cmc_find_token, get_fear_and_greed_index, get_altseason_index } = require("./crypto-api")
const { load_routine_from_spreadsheets, load_telegram_channels_from_spreadsheets } = require("../module/synchro/spreadsheet.synchro")

const { print, localeDate, alarm } = require("./../shared/utility")

const { DISCORD_BOT_TOKEN, EMBED_RED, EMBED_GREEN, EMBED_PRIMARY, INEMURI_CHANNEL, FORUM_LIST, GUILD_ID, AIRDROP_INFO_CHANNEL, GOVERMENT_INFO_CHANNEL } = require("./../config/discord-config")
const { ALLOWED_SPECIAL_USERS } = require("../config/app-config")

const allowed_users = ALLOWED_SPECIAL_USERS

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
        if (typeof options.message !== "string" || options.message === "") options.message = "Attachment"
        const discord_message = {}

        const embed = new EmbedBuilder()
            .setColor(EMBED_PRIMARY)
            .setAuthor({ name: `┍━━━━━ ${options.sub_tittle}` })
            .setTitle(`〓 ${options.channel_name}`)
            .setDescription(options.message)
            .setFooter({ text: `${localeDate()}` })

        if (options.pictures.length > 0) {
            discord_message.files = []
            for (let i = 0; i < options.pictures.length; i++) {
                discord_message.files.push(new AttachmentBuilder(options.pictures[i], { name: "image" + i + ".jpg" }))
            }
            embed.setImage("attachment://image0.jpg")
        }
        discord_message.embeds = [embed]

        const messageObj = await channel.send(discord_message)
        print(`Sended ${messageObj}`)
    } catch (error) {
        console.log(error)
        alarm(`ERROR | sendToChannel | ${error.message}`)
        // alarm(`message: ${options.message.className}\nchannelName: ${options.channelName}\nmessageLength: ${options.message.message.length}`)
    }
}

async function batch_send_to_channel(channelID, message_list) {
    try {
        const channel = client.channels.cache.get(channelID)

        if (!channel) {
            print(`Could not find channel with ID ${channelID}`)
            return
        }

        for (message of message_list) {
            const discord_message = {}

            if (message.embed) {
                // console.log()
                const embed = new EmbedBuilder()
                    .setColor(message.embed.color)

                if (message.embed.author) embed.setAuthor({ name: message.embed.author });
                if (message.embed.title) embed.setTitle(message.embed.title);
                if (message.embed.description) embed.setDescription(message.embed.description);
                // if (message.embed.description) embed.setFooter({ text: `${localeDate()}` });
                // .setAuthor({ name: message.embed.author })
                // .setTitle(message.embed.title)
                // .setDescription(message.embed.description)
                // .setFooter({ text: `${localeDate()}` })

                discord_message.embeds = [embed]
            }
            if (message.text) {
                discord_message.content = message.text;
            }
            console.log(discord_message)
            const response = await channel.send(discord_message)

            console.log(`Sended ${response}`)
        }

        console.log("All Sendet")

    } catch (error) {
        console.log(error)
    }

}

async function launch() {
    await client.login(DISCORD_BOT_TOKEN)
    await client_ready()
    await interaction()
    await check_for_new_discussions()
    const job = new CronJob(
        '5 0 * * *', // cronTime
        notification, // onTick
        null, // onComplete
        true, // start
        'Europe/Kiev' // timeZone
    );
}

async function client_ready() {
    try {
        await client.application.commands.set([]);

        const slashCommandBuilders = [
            {
                name: 'repeat-daily-notification',
                description: 'Generate new daily notification',
                type: 1,
            },
            {
                name: 'update-routine-list',
                description: 'Update routine list from spreadsheets',
                type: 1,
            },
            {
                name: 'update-telegram-whitelist',
                description: 'Update telegram channels whitelist and config from spreadsheets',
                type: 1,
            },
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
        alarm(`ERROR | CLIENT_READY | ${error.message}`)
    }
}

async function interaction() {
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isCommand()) return;

        const { commandName, options } = interaction;
        try {

            if (commandName === 'repeat-daily-notification') {
                if (!allowed_users.includes(interaction.user.id)) {
                    await interaction.reply({ content: 'У вас немає доступу до цієї команди.', ephemeral: true });
                    return;
                }
                await interaction.deferReply({ ephemeral: true });
                await notification()
                await interaction.editReply({ content: 'Згенеровано новий пост', ephemeral: true });
            }
            if (commandName === 'update-routine-list') {
                if (!allowed_users.includes(interaction.user.id)) {
                    await interaction.reply({ content: 'У вас немає доступу до цієї команди.', ephemeral: true });
                    return;
                }
                await interaction.deferReply({ ephemeral: true });
                await load_routine_from_spreadsheets()
                await interaction.editReply({ content: 'Routine Updated', ephemeral: true });
            }
            if (commandName === 'update-telegram-whitelist') {
                if (!allowed_users.includes(interaction.user.id)) {
                    await interaction.reply({ content: 'У вас немає доступу до цієї команди.', ephemeral: true });
                    return;
                }
                await interaction.deferReply({ ephemeral: true });
                await load_telegram_channels_from_spreadsheets()
                await interaction.editReply({ content: 'Telegram Whitelist updated', ephemeral: true });
            }
            if (commandName === 'gpt') {
                interaction.reply({ content: "closed", ephemeral: true });
            }
            if (commandName === 'starknet-stats') {
                const addresses = options.getString('addresses');
                const response = await check_starknet_address(addresses.split(" "));
                interaction.reply({ content: response, ephemeral: true });
            }
            if (commandName === 'layerzero-stats') {
                const address = await options.getString("address");
                const response = await check_layerzero_address(address);
                interaction.reply({ content: response, ephemeral: true });
            }
        } catch (error) {
            console.error(`Error while processing '${commandName}' command:`, error);
            interaction.reply('An error occurred while processing your request.');
            alarm(`ERROR | INTERACTION | ${error.message}`)
        }
    });
}

async function check_for_new_discussions() {
    const guild = client.guilds.cache.get(GUILD_ID); // Замініть на ID свого сервера
    const today = new Date();
    today.setDate(today.getDate() - 1);  // Вчора
    if (!guild) throw new Error("Guild was not found")
    let new_threads = []
    try {
        for (let forum_id of FORUM_LIST) {
            const channel = guild.channels.resolve(forum_id)

            const actual_threads = channel.threads.cache
            const archived_threads = await channel.threads.fetchArchived({ fetchAll: true, limit: 100 });

            const threads_list = actual_threads.concat(archived_threads.threads)
            const new_treads_in_single_forum = threads_list.filter((thread) => thread.createdTimestamp > today.getTime());

            new_threads = [...new_threads, ...new_treads_in_single_forum.values()]
        }
    } catch (error) {
        console.log(error)
        alarm(`ERROR | NEW_DISCUS_CHECK | ${error.message}`)
    } finally {
        return new_threads
    }
}

async function notification() {
    const discord_message = {}
    try {
        const channel = client.channels.cache.get(INEMURI_CHANNEL)
        if (!channel) {
            print(`Could not find channel with ID ${INEMURI_CHANNEL}`)
            return
        }

        const embed = new EmbedBuilder()
            .setAuthor({ name: `┍━━━━━ Daily ` })
            .setTitle(`〓 Inemuri`)
            .setFooter({ text: `${localeDate()}` })

        const global_metrics = await cmc_global_metrics()
        const btc_stat = await cmc_find_token("BTC")
        const new_discussions = await check_for_new_discussions()
        const fear_and_greed = await get_fear_and_greed_index()
        const altcoin_season = await get_altseason_index()

        if (btc_stat.quote.USD.percent_change_24h > 0) { embed.setColor(EMBED_GREEN) }
        if (btc_stat.quote.USD.percent_change_24h < 0) { embed.setColor(EMBED_RED) }

        let message = "**Crypto Метрики**" + "\n" +
            "```java\nBTC | " + "Price " + btc_stat.quote.USD.price.toFixed(1) + " | 24h change: " + btc_stat.quote.USD.percent_change_24h.toFixed(1) + "%" + "\n" +
            "BTC.D: " + global_metrics.btc_dominance.toFixed(1) + "%" + " | BTC.D.Y: " + global_metrics.btc_dominance_yesterday.toFixed(1) + "%" + "\n" +
            "DEFI 24h change: " + global_metrics.defi_24h_percentage_change.toFixed(1) + "%" + "\n" +
            "Derivatives 24h change: " + global_metrics.derivatives_24h_percentage_change.toFixed(1) + "%" + "\n" +
            "Alt Index: " + altcoin_season.index + "/100" + "\n" +
            "Alt Status: " + altcoin_season.status + "\n" +
            fear_and_greed.value_classification + ": " + fear_and_greed.value + "```"

        if (new_discussions.length > 0) {
            message += "\n" + "**Нові Активності**" + "\n"
            new_discussions.forEach(element => {
                message += `<#${element.id}>` + "\n"
            })
        }

        message += `\n<#${AIRDROP_INFO_CHANNEL}>` +
            `\n<#${GOVERMENT_INFO_CHANNEL}>`

        embed.setDescription(message)
        discord_message.embeds = [embed]
        await channel.send(discord_message)
    } catch (error) {
        console.log(error)
        alarm(`ERROR | NOTIF | ${error.message}`)
    }
}

async function clear_channel(channelID) {
    try {
        const channel = await client.channels.fetch(channelID)

        const messages = await channel.messages.fetch({ limit: 100 });
        const deletePromises = messages.map(message => message.delete());
        await Promise.all(deletePromises);

        console.log('Channel cleared!');

    } catch (error) {
        console.log(error)
    }
}

module.exports = {
    launch,
    sendToChannel,
    clear_channel,
    batch_send_to_channel
}