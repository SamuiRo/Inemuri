const { GoogleSpreadsheet } = require("google-spreadsheet");

const creds = require('../credentials/google-spreadsheet.creds.json'); // Шлях до файлу сертифікату облікового запису
const { GOOGLE_SPREADSHEET_TABLE_ID } = require("../config/app-config")
const { print } = require("../shared/utility")

let doc

async function ss_connect() {
    try {
        print("Spreadsheets Launch...")

        doc = new GoogleSpreadsheet(GOOGLE_SPREADSHEET_TABLE_ID); // Замініть на власний ідентифікатор таблиці
        await doc.useServiceAccountAuth(creds)
        await doc.loadInfo()

        print("Spreadsheets Ready")
    } catch (error) {
        console.log(error)
    }
}

async function load_sheet(sheet_id) {
    try {
        const sheet = doc.sheetsByIndex[sheet_id]

        return sheet
    } catch (error) {
        console.log(error)
    }
}
// Завантажте файл Google Sheets за його ідентифікатором
async function load_rows(sheet) {
    try {
        const rows = await sheet.getRows()

        return rows

    } catch (error) {
        console.log(error)
    }
}

async function update_row(row, key, value) {
    row[key] = value

    await row.save()
}

module.exports = {
    ss_connect,
    load_sheet,
    load_rows,
    update_row
}