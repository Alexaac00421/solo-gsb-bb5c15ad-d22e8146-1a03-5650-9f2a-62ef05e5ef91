'use strict';

// 显式建库脚本: 初始化表结构, 并在空库时写入演示网络。
// Compose 启动时会先执行 `npm run init-db`。
const path = require('path');
const { openDb, initSchema, seedDemo } = require('./db');

const dbPath = process.env.LOTO_DB || path.join(__dirname, '..', 'data', 'loto.db');

const db = openDb(dbPath);
initSchema(db);
const seeded = seedDemo(db);
const rev = db.prepare(`SELECT value FROM meta WHERE key='revision'`).get().value;
db.close();

console.log(`[init-db] 数据库就绪: ${dbPath}`);
console.log(`[init-db] ${seeded ? '已写入演示供电网络。' : '库中已有数据, 跳过演示数据。'} 当前修订号 revision=${rev}`);
