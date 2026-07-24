const fs = require('fs');
const path = require('path');
const db = require('./index');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// schema.sql uses CREATE TABLE IF NOT EXISTS, so it can create a table but
// never alter one. Columns added after a database already exists need to be
// applied separately — hence this list. Adding a column here is safe to re-run.
const ADDED_COLUMNS = [
  { table: 'jobs', name: 'tags', definition: 'TEXT' },
];

for (const col of ADDED_COLUMNS) {
  const existing = db.prepare(`PRAGMA table_info(${col.table})`).all();
  if (existing.some((c) => c.name === col.name)) continue;
  db.exec(`ALTER TABLE ${col.table} ADD COLUMN ${col.name} ${col.definition}`);
  console.log(`Added column ${col.table}.${col.name}`);
}

console.log(`Schema applied to ${process.env.DB_PATH || './data/jobs.sqlite'}`);
