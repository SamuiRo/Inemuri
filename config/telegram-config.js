require("dotenv").config()

module.exports = {
    API_ID: +process.env.API_ID,
    API_HASH: process.env.API_HASH,
    SESSION: process.env.SESSION
}