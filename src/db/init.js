const fs = require('fs');
const path = require('path');
const db = require('./index');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

console.log(`Schema applied to ${process.env.DB_PATH || './data/jobs.sqlite'}`);
