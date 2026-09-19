const { Pool } = require("pg");

// Most hosted Postgres providers (Supabase, Railway, Render) require SSL
// but use a self-signed cert, so we disable strict verification.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

module.exports = pool;
