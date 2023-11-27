const { google } = require('googleapis');
const { simpleParser } = require('mailparser');
const { CronJob } = require("cron")

const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI, GMAIL_REFRESH_TOKEN, ALL_MAILS_CHAT_ID } = require("../../config/gmail-config")
const { openDatabase } = require("../sqlite/sqlite_db")
const { send_long_message_via_telegram_bot, alarm } = require("../../shared/utility")

const oauth2Client = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI);
oauth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });

async function get_unreaded_mails(auth) {
    let mails = []
    const gmail = google.gmail({ version: 'v1', auth });
    try {
        const response = await gmail.users.messages.list({
            userId: 'me',
            q: 'is:unread', // You can modify the query to filter the emails as needed
        });

        mails = response.data.messages
    } catch (error) {
        console.log(error)
        alarm(`ERROR | GET_UNREADED_MAILS | ${error.message}`)
    } finally {
        return { unreaded_mails: mails, gmail }
    }
}

async function get_single_mail(id, gmail) {
    try {
        const response = await gmail.users.messages.get({
            userId: 'me',
            id: id,
            format: 'raw',
        });

        return response.data
    } catch (error) {
        console.log(error)
        alarm(`ERROR | _GET_SINGLE_MAIL | ${error.message}`)
    }
}

async function decode_and_parse_mail(message) {
    try {
        const decoded_message = Buffer.from(message.raw, "base64").toString("utf-8")
        const parsed_message = await simpleParser(decoded_message)

        return parsed_message
    } catch (error) {
        console.log(error)
        alarm(`ERROR | DECODE_PARSE | ${error.message}`)
    }
}

// function get_mail_by_id(mail_id) {
//     const sql = `SELECT * FROM mails WHERE mail_id = ?`;
//     db.get(sql, [mail_id], (err, row) => {
//         if (err) {
//             console.error(err.message);
//         }
//         console.log(row);
//     });
// }

async function insert_mail(mail_id) {
    const db = await openDatabase();
    await db.run('INSERT INTO mails (mail_id) VALUES (?)', mail_id);
}

async function get_mail_by_id(mail_id) {
    const db = await openDatabase();
    const row = await db.get('SELECT * FROM mails WHERE mail_id = ?', mail_id);
    return row
}

function build_message(from, to, subject, text, date) {
    let message =
        "◄ " + from + "\n" +
        "► " + to + "\n" +
        "》" + `${date}`.replace("(Eastern European Standard Time)", "") + "\n" +
        "》" + subject + "\n" +
        "➧ Content:" + "\n" +
        text

    return message
}

async function check_for_new_mails() {
    try {
        const { unreaded_mails, gmail } = await get_unreaded_mails(oauth2Client)

        for (const mail of unreaded_mails) {
            const result = await get_mail_by_id(mail.id)

            if (result) continue
            // Тут добавити отримання самого листа
            const raw_mail = await get_single_mail(mail.id, gmail)
            const parsed_mail = await decode_and_parse_mail(raw_mail)

            const message = build_message(parsed_mail.from.text, parsed_mail.to.text, parsed_mail.subject, parsed_mail.text, parsed_mail.date)

            await send_long_message_via_telegram_bot(ALL_MAILS_CHAT_ID, message)

            await insert_mail(mail.id)
        }
    } catch (error) {
        console.log(error)
        alarm(`ERROR | CHECK_FOR_NEW_MAILS | ${error.message}`)
    }
}

async function launch() {
    try {
        const job = new CronJob(
            '*/2 * * * *', // cronTime
            check_for_new_mails, // onTick
            null, // onComplete
            true, // start
            'Europe/Kiev' // timeZone
        );
    } catch (error) {
        console.log(error)
        alarm(`ERROR | GMAIL | ${error.message}`)
    }
}

module.exports = {
    launch
}