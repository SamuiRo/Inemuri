const { load_sheet_by_title, load_rows } = require("../../bot/spreadsheet")
const Routine = require("../sqlite/models/Routine")
const Telegram_Channel = require("../sqlite/models/Telegram_Channel")

async function sync_with_spredsheets() {
    try {
        await load_routine_from_spreadsheets()
        await load_telegram_channels_from_spreadsheets()
    } catch (error) {
        console.log(error)
    }
}

async function load_routine_from_spreadsheets() {
    try {
        const routine_list = await load_sheet_by_title("Routine Import")

        const rows = await load_rows(routine_list)

        for (let row of rows) {
            await Routine.upsert({
                project: row.project.trim(),
                rate: row.rate === 'D' ? 'Daily' : row.rate === 'W' ? 'Weekly' : row.rate === 'M' ? 'Monthly' : row.rate,
                tier: +row.tier,
                status: row.status.trim(),
                name: row.name,
                url: row.url,
                description: typeof row.description === "string" ? row.description : "",
                category: row.category.trim(),
                last_synced_at: new Date()
            })
        }

        console.log("load complete")

    } catch (error) {
        console.log(error)
    }
}

async function load_telegram_channels_from_spreadsheets() {
    try {
        const channels_list = await load_sheet_by_title("Telegram whitelist")

        const rows = await load_rows(channels_list)

        for (let row of rows) {
            await Telegram_Channel.upsert({
                channel_id: +row.channelId.trim(),
                channel_name: row.channelName.trim(),
                sub_tittle: row.sub_tittle.trim(),
                channel_category: row.channel_category.trim(),
                discord_group: row.discord_group.split(","),
                telegram_group: row.discord_group.split(","),
                translate: row.translate === "TRUE" ? true : false,
                forwarding: row.forwarding === "TRUE" ? true : false,
            })
        }

        console.log("load complete")
    } catch (error) {
        console.log(error)
    }
}

module.exports = {
    sync_with_spredsheets,
    load_routine_from_spreadsheets,
    load_telegram_channels_from_spreadsheets,
}