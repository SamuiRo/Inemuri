const sqlite = require('sqlite');
const sqlite3 = require('sqlite3');

async function openDatabase() {
    const db = await sqlite.open({ filename: './inemuri.db', driver: sqlite3.Database });
    await db.exec('CREATE TABLE IF NOT EXISTS mails (id INTEGER PRIMARY KEY, mail_id TEXT UNIQUE)');
    return db;
}

module.exports = { openDatabase };