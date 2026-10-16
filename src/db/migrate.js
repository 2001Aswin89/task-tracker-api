const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const config = require('../config');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

/** Create the target database if it does not exist yet (connects via the "postgres" DB). */
async function ensureDatabase() {
  const target = new URL(config.databaseUrl);
  const dbName = target.pathname.slice(1);
  const admin = new URL(config.databaseUrl);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  } finally {
    await client.end();
  }
}

/** Apply every unapplied migrations/*.sql file in name order, each in its own transaction. */
async function migrate() {
  await ensureDatabase();
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
