const chalk = require("chalk")
const axios = require("axios")

const { SECRETARY_TELEGRAM_CHAT_ID, SECRETARY_TELEGRAM_BOT_TOKEN } = require("./../config/telegram-config")

async function sleep(time) {
    return new Promise((resolve, reject) => {
        print("Wait for " + time)
        setTimeout(() => {
            resolve(time)
        }, time)
    })
}

function print(text) {
    const current_date = new Date

    console.log(chalk.red(current_date.toLocaleString()) + " | " + chalk.magenta(text))
}

function _error(text) {
    const current_date = new Date

    console.log(chalk.red(current_date.toLocaleString()) + "| ERROR |", chalk.magenta(text))
}

async function alarm(text) {
    try {
        const config = {
            chat_id: SECRETARY_TELEGRAM_CHAT_ID,
            text: `${text}`
        }

        const url = `https://api.telegram.org/bot${SECRETARY_TELEGRAM_BOT_TOKEN}/sendMessage`
        const response = await axios.post(url, config)

        return response.data
    } catch (error) {
        console.log(error)
    }
}

function localeDate() {
    const current_date = new Date
    return current_date.toLocaleString()
}

function _dateDifference(oldDate, currentDate) {

    const _MS_PER_DAY = 1000 * 60 * 60 * 24
    const _MS_PER_HOUR = 1000 * 60 * 60
    const _MS_PER_MINUTE = 1000 * 60
    // Discard the time and time-zone information.
    const utc1 = Date.UTC(oldDate.getFullYear(), oldDate.getMonth(), oldDate.getDate())
    const utc2 = Date.UTC(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate())

    return {
        minutes: Math.floor((utc2 - utc1) / _MS_PER_MINUTE),
        hours: Math.floor((utc2 - utc1) / _MS_PER_HOUR),
        days: Math.floor((utc2 - utc1) / _MS_PER_DAY)
    }
}

module.exports = {
    sleep,
    print,
    alarm,
    localeDate,
    _dateDifference,
    _error
}