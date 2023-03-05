const chalk = require("chalk")

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
    localeDate,
    _dateDifference,
    _error
}