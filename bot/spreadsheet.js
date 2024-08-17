const { GoogleSpreadsheet } = require("google-spreadsheet");

const creds = require('../credentials/google-spreadsheet.creds.json'); // Шлях до файлу сертифікату облікового запису
const { GOOGLE_SPREADSHEET_TABLE_ID } = require("../config/app-config")
const { print, success, _error } = require("../shared/utility")

const spreadsheet_id = GOOGLE_SPREADSHEET_TABLE_ID


let sheets = {}

async function ss_connect(spreadsheet_id) {
    try {
        print("SpreadSheets Connect...")

        sheets[spreadsheet_id] = new GoogleSpreadsheet(spreadsheet_id);

        await sheets[spreadsheet_id].useServiceAccountAuth(creds);

        await sheets[spreadsheet_id].loadInfo()

        success("SS Connect Ready")
    } catch (error) {
        _error("SS Connect " + error)
        console.log(error)
    }
}

async function load_sheet_by_id(sheet_id) {
    try {
        const sheet = sheets[spreadsheet_id].sheetsByIndex[sheet_id]

        return sheet
    } catch (error) {
        _error(error)
    }
}

async function load_sheet_by_title(title) {
    try {
        const sheet = sheets[spreadsheet_id].sheetsByTitle[title]

        return sheet
    } catch (error) {
        _error(error)
    }
}

async function load_rows(sheet) {
    try {
        const rows = await sheet.getRows()

        return rows

    } catch (error) {
        _error(error)
    }
}

async function update_row(row, key, value) {
    row[key] = value

    await row.save()
}

async function ss_init() {
    try {
        print("Init Spreadsheet ...")
        
        await ss_connect(spreadsheet_id)

        success("SS Init Ready")
    } catch (error) {
        _error("SS Init" + error)
    }
}

module.exports = {
    ss_connect,
    load_sheet_by_id,
    load_sheet_by_title,
    ss_init,
    load_rows,
    update_row
}