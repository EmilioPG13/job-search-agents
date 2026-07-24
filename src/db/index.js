const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require('dotenv').config();

const dbPath = process.env.DB_PATH || './data/jobs.sqlite';
const db = new DatabaseSync(path.resolve(process.cwd(), dbPath));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

module.exports = db;
