// Apply db/schema.sql: npm run migrate
const fs = require("node:fs");
const path = require("node:path");
const { pgPoolConfig } = require("./boot");

(async () => {
  const { Pool } = require("pg");
  const pool = new Pool(pgPoolConfig());
  const schema = process.env.DB_SCHEMA || "dwell";
  await pool.query(`create schema if not exists ${schema}`);
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  await pool.query(sql);
  await pool.end();
  console.log("[dwell] schema applied");
})().catch((err) => {
  console.error("[dwell] migrate failed:", err.message);
  process.exit(1);
});
