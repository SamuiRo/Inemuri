const puppeteer = require("puppeteer")

const { HEADLESS, WIEVPORT_WIDTH, WIEVPORT_HEIGHT } = require("./../config/app-config")
const { print, _error, sleep, alarm } = require("./../shared/utility")

const translator_link = "https://www.deepl.com/translator"

let browser
let context
let page

async function launch() {
    try {
        print("Launch procces")
        browser = await puppeteer.launch({ headless: HEADLESS })
        context = await browser.createIncognitoBrowserContext()
        print("Browser Created. Headless: " + HEADLESS)

        page = await context.newPage()
        await page.setViewport({ width: WIEVPORT_WIDTH, height: WIEVPORT_HEIGHT })
        print("Page Created. Set viewport: " + WIEVPORT_WIDTH + "x" + WIEVPORT_HEIGHT)

        await page.goto(translator_link)
        await page.waitForSelector("#dl_translator")

    } catch (error) {
        console.log(error)
        await alarm(error.message)
    }
}

async function translate(text) {
    try {
        if (text == "" || typeof text != "string") return
        print("Try to translate")
        await clear_input()
        // await sleep(1000)
        // await page.type("[dl-test=translator-source-input]", `${text}`)
        await page.type("[data-testid=translator-source-input]", `${text}`)


        print("Waiting to translate")
        await page.waitForFunction(() => {
            // const pElement = document.querySelector('[dl-test=translator-target-input]')
            const pElement = document.querySelector("[data-testid=translator-target-input]")
            if (pElement) return pElement.textContent !== "" // очікуваний новий контент
            return false
        })
        await sleep(1000)
        // const content = await page.$("[dl-test=translator-target-input]")
        const content = await page.$("[data-testid=translator-target-input]")
        const result = await (await content.getProperty("textContent")).jsonValue()
        print("Translated")

        await clear_input()
        return result
    } catch (error) {
        await clear_input()
        _error(error.message)
        await alarm(error.message)
    }
}

async function clear_input() {
    try {
        // await page.focus("[dl-test=translator-source-input]")
        await page.focus("[data-testid=translator-source-input]")
        await page.keyboard.down("Control")
        await page.keyboard.press("A")
        await page.keyboard.up("Control")
        await page.keyboard.press("Backspace")

        return "Input is clear"
    } catch (error) {
        _error(error.message)
        await alarm(error.message)
    }

}

module.exports = {
    launch,
    translate
}