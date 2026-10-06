'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL CHECK (kind IN ('source','switch','device')),
      name        TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,  -- source: 是否启用; 其余节点恒为 1
      open_pos    INTEGER NOT NULL DEFAULT 0,  -- switch: 1=断开(off), 0=闭合(on)
      tagged      INTEGER NOT NULL DEFAULT 0,  -- switch: 1=已挂牌锁定
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edges (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      from_node   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      to_node     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(from_node, to_node),
      CHECK (from_node <> to_node)
    );

    CREATE TABLE IF NOT EXISTS permits (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id    INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
      requested_by TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at     TEXT,
      ended_by     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_permits_device ON permits(device_id);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT NOT NULL DEFAULT (datetime('now')),
      actor       TEXT NOT NULL,
      role        TEXT NOT NULL CHECK (role IN ('admin','operator')),
      action      TEXT NOT NULL,
      detail      TEXT,                       -- 操作参数
      rev_before  INTEGER,
      rev_after   INTEGER,
      state_before TEXT,                      -- 操作前网络状态快照
      state_after  TEXT                       -- 操作后网络状态快照
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const row = db.prepare(`SELECT value FROM meta WHERE key='revision'`).get();
  if (!row) {
    db.prepare(`INSERT INTO meta(key, value) VALUES ('revision', '1')`).run();
  }
}

function seedDemo(db) {
  const count = db.prepare(`SELECT COUNT(*) AS c FROM nodes`).get().c;
  if (count > 0) return false;

  const ins = db.prepare(
    `INSERT INTO nodes(kind, name, enabled, open_pos, tagged)
     VALUES (@kind, @name, @enabled, @open_pos, @tagged)`
  );
  const add = (kind, name, extra = {}) =>
    ins.run({
      kind, name,
      enabled: extra.enabled ?? 1,
      open_pos: extra.open_pos ?? 0,
      tagged: 0
    }).lastInsertRowid;

  const S1 = add('source', '1#主电源');
  const S2 = add('source', '2#备用电源');
  const K1 = add('switch', '进线开关K1');
  const K2 = add('switch', '备用开关K2');
  const K3 = add('switch', '联络开关K3');
  const D1 = add('device', '1#循环水泵');
  const D2 = add('device', '2#引风机');

  const edge = db.prepare(`INSERT INTO edges(from_node, to_node) VALUES (?, ?)`);
  // 源/开关下游, 不允许从设备/开关出线到电源
  edge.run(S1, K1);
  edge.run(S2, K2);
  edge.run(K1, K3);
  edge.run(K2, K3);
  edge.run(K3, D1);
  edge.run(K1, D2);
  return true;
}

module.exports = { openDb, initSchema, seedDemo };
