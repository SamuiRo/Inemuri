require("dotenv").config()

module.exports = {
    ENDPOINT: process.env.ENDPOINT,
    KEY: process.env.KEY,
    COSMOS_DB_ID: process.env.COSMOS_DB_ID,
}