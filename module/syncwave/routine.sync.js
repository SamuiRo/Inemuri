const Discord = require("../../bot/discord")
const Routine = require("../sqlite/models//Routine")
const { load_routine_from_spreadsheets } = require("../synchro/spreadsheet.synchro")

const { ROUTINE_CHANNEL_ID } = require("../../config/app-config")

async function launch() {
    let routine_channe_id = ROUTINE_CHANNEL_ID
    try {
        await load_routine_from_spreadsheets()
        await clear_discord_channel(routine_channe_id)

        const list = await get_routine_list()

        await import_list_to_discord_channel(routine_channe_id, list)
    } catch (error) {
        console.log(error)
    }
}

async function clear_discord_channel(channel_id) {
    try {
        await Discord.clear_channel(channel_id)
    } catch (error) {
        console.log(error)
    }
}

async function get_routine_list() {
    const list = [];
    const routineQueries = [
        { rate: "Daily", tier: 1 },
        { rate: "Daily", tier: 2 },
        { rate: "Daily", tier: 3 },
        { rate: "Daily", tier: 4 },
        { rate: "Weekly", tier: 1 },
        { rate: "Weekly", tier: 2 },
        { rate: "Weekly", tier: 3 },
        { rate: "Weekly", tier: 4 }
    ];

    try {
        for (const query of routineQueries) {
            const routineList = await Routine.findAll({ where: { ...query, status: "Active" } });
            const color = await get_color_by_tier(query.tier);
            const embed = {
                color: color,
                author: query.rate,
                title: null,
                description: routineList.map(element => `[${element.name}](${element.url})`).join("\n"),
                footer: null
            };
            list.push({ text: null, embed: embed });
        }

        return list;
    } catch (error) {
        console.log(error);
    }
}

async function import_list_to_discord_channel(channelID, list) {
    let message_list = []
    try {

        const init_message = {
            text: "Список завдань для виконання на регулярній основі\n\n" +
                "Пріоритет завдань",
            embed: null,
        }

        const tiers = [
            { text: null, embed: { color: 0xccb1ef, author: "High", title: null, description: null, footer: null } },
            { text: null, embed: { color: 0xf2d59e, author: "Moderate", title: null, description: null, footer: null } },
            { text: null, embed: { color: 0x588ee9, author: "Optional", title: null, description: null, footer: null } },
            { text: null, embed: { color: 0xc8c8c8, author: "Minor", title: null, description: null, footer: null } },
        ]

        message_list.push(init_message)
        message_list = message_list.concat(tiers)
        message_list = message_list.concat(list)
        console.log(message_list)

        await Discord.batch_send_to_channel(channelID, message_list)

    } catch (error) {
        console.log(error)
    }
}

async function get_color_by_tier(tier) {
    switch (tier) {
        case 1: return 0xccb1ef;
        case 2: return 0xf2d59e;
        case 3: return 0x588ee9;
        case 4: return 0xc8c8c8;
    }
};

module.exports = {
    launch
}