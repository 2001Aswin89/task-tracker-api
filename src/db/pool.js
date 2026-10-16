const { Pool, types } = require('pg');
const config = require('../config');

// BIGINT (oid 20) comes back as a string by default. Ids and counts here are far below 2^53,
// so parse them to numbers; otherwise ownership checks like `row.user_id === req.user.id` fail.
types.setTypeParser(20, Number);

const pool = new Pool({ connectionString: config.databaseUrl });

module.exports = { pool, query: (text, params) => pool.query(text, params) };
