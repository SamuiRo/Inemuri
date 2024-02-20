require("dotenv").config()

module.exports = {
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    EMBED_RED: 0xff4c4c,
    EMBED_GREEN: 0x2cff8f,
    EMBED_PRIMARY: 0xe98ca1,
    EMBED_SECONDARY: 0x8258ff,
    INEMURI_CHANNEL: process.env.INEMURI_CHANNEL,
    FORUM_LIST: process.env.FORUM_LIST.split(","),
    GUILD_ID: process.env.GUILD_ID,
    GOVERMENT_INFO_CHANNEL: process.env.GOVERMENT_INFO_CHANNEL,
    AIRDROP_INFO_CHANNEL: process.env.AIRDROP_INFO_CHANNEL,
}