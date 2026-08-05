// db.js — libSQL/Turso 持久化层
//
// 两种模式:
//   - 生产 (Render): 设 TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
//   - 本地/测试: 不设 env, 自动用 file:./data/dev.db (SQLite 本地文件)
//
// 性能: 单实例小流量 (朋友玩) 完全够用, 每次查询都打 DB. 不缓存.

const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

let dbUrl, dbAuthToken;
if (TURSO_URL) {
  // 生产: 走 Turso
  dbUrl = TURSO_URL;
  dbAuthToken = TURSO_TOKEN;
  console.log(`[db] using Turso: ${TURSO_URL.replace(/:[^:@]+@/, ':***@')}`);
} else {
  // 本地/测试: 走本地 SQLite 文件
  const DATA_DIR = path.join(__dirname, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  dbUrl = `file:${path.join(DATA_DIR, 'dev.db')}`;
  console.log(`[db] using local SQLite: ${dbUrl}`);
}

const db = createClient({ url: dbUrl, authToken: dbAuthToken });

async function init() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      userId          TEXT PRIMARY KEY,
      passphrase_hash TEXT NOT NULL,
      salt            TEXT NOT NULL,
      display_name    TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tokens (
      token      TEXT PRIMARY KEY,
      userId     TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS attempts (
      id               TEXT PRIMARY KEY,
      started_at       INTEGER NOT NULL,
      ended_at         INTEGER NOT NULL,
      chapter_id       TEXT NOT NULL,
      chapter_name     TEXT NOT NULL,
      clock_id         TEXT NOT NULL,
      clock_name       TEXT NOT NULL,
      squad            TEXT NOT NULL,   -- JSON array (sorted userIds)
      squad_nicknames  TEXT NOT NULL,   -- JSON array
      result           TEXT NOT NULL,   -- 'won' | 'lost'
      turn_count       INTEGER NOT NULL,
      duration_seconds INTEGER NOT NULL,
      player_count     INTEGER NOT NULL
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_attempts_ended ON attempts(ended_at)`);
  console.log('[db] schema ready');
}

// 清空所有表 (仅测试用)
async function clearAll() {
  await db.execute(`DELETE FROM users`);
  await db.execute(`DELETE FROM tokens`);
  await db.execute(`DELETE FROM attempts`);
}

// ---------------- users ----------------

async function insertUser(u) {
  await db.execute({
    sql: `INSERT INTO users (userId, passphrase_hash, salt, display_name, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [u.userId, u.passphrase_hash, u.salt, u.display_name, u.created_at],
  });
}

async function getAllUsers() {
  const r = await db.execute(`SELECT userId, passphrase_hash, salt, display_name, created_at FROM users`);
  return r.rows;
}

async function findUserById(userId) {
  const r = await db.execute({
    sql: `SELECT userId, passphrase_hash, salt, display_name, created_at FROM users WHERE userId = ?`,
    args: [userId],
  });
  return r.rows[0] || null;
}

// ---------------- tokens ----------------

async function insertToken(token, userId, created_at) {
  await db.execute({
    sql: `INSERT INTO tokens (token, userId, created_at) VALUES (?, ?, ?)`,
    args: [token, userId, created_at],
  });
}

async function findToken(tokenStr) {
  const r = await db.execute({
    sql: `SELECT token, userId, created_at FROM tokens WHERE token = ?`,
    args: [tokenStr],
  });
  return r.rows[0] || null;
}

async function deleteToken(tokenStr) {
  await db.execute({ sql: `DELETE FROM tokens WHERE token = ?`, args: [tokenStr] });
}

// ---------------- attempts ----------------

async function insertAttempt(a) {
  await db.execute({
    sql: `INSERT INTO attempts (id, started_at, ended_at, chapter_id, chapter_name,
                                clock_id, clock_name, squad, squad_nicknames,
                                result, turn_count, duration_seconds, player_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      a.id, a.started_at, a.ended_at, a.chapter_id, a.chapter_name,
      a.clock_id, a.clock_name,
      JSON.stringify(a.squad), JSON.stringify(a.squad_nicknames),
      a.result, a.turn_count, a.duration_seconds, a.player_count,
    ],
  });
}

// 拿到所有 attempt (按时间倒序)
async function getAllAttempts() {
  const r = await db.execute(`SELECT * FROM attempts ORDER BY ended_at DESC`);
  return r.rows.map(rowToAttempt);
}
function rowToAttempt(row) {
  return {
    id: row.id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    chapter_id: row.chapter_id,
    chapter_name: row.chapter_name,
    clock_id: row.clock_id,
    clock_name: row.clock_name,
    squad: JSON.parse(row.squad),
    squad_nicknames: JSON.parse(row.squad_nicknames),
    result: row.result,
    turn_count: row.turn_count,
    duration_seconds: row.duration_seconds,
    player_count: row.player_count,
  };
}

module.exports = {
  db,
  init,
  clearAll,
  insertUser, getAllUsers, findUserById,
  insertToken, findToken, deleteToken,
  insertAttempt, getAllAttempts,
};
