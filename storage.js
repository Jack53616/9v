'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const FILE_PATH = process.env.LICENSE_FILE || path.join(__dirname, 'licenses.json');

function ensureFileDir() {
  try {
    fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  } catch (_) {}
}

function nowSql() {
  return new Date().toISOString();
}

function FileStore() {
  this.rows = [];
  this.nextId = 1;
  this._load();
}

FileStore.prototype._load = function () {
  ensureFileDir();
  try {
    var raw = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    this.rows = Array.isArray(raw.rows) ? raw.rows : [];
    this.nextId = Number(raw.nextId) || (this.rows.length + 1);
  } catch (_) {
    this.rows = [];
    this.nextId = 1;
  }
};

FileStore.prototype._save = function () {
  ensureFileDir();
  fs.writeFileSync(FILE_PATH, JSON.stringify({ nextId: this.nextId, rows: this.rows }, null, 2));
};

FileStore.prototype.insertUnused = async function (row) {
  if (this.rows.some(function (item) { return item.key_hash === row.key_hash; })) {
    var err = new Error('dup');
    err.code = 'ER_DUP_ENTRY';
    throw err;
  }
  var saved = Object.assign({
    id: this.nextId++,
    status: 'unused',
    display_name: null,
    device_id: null,
    session_token: null,
    activated_at: null,
    expires_at: null,
    created_at: nowSql(),
    last_seen_at: null
  }, row);
  this.rows.push(saved);
  this._save();
  return saved;
};

FileStore.prototype.findByHash = async function (hash) {
  return this.rows.find(function (row) { return row.key_hash === hash; }) || null;
};

FileStore.prototype.findBySession = async function (token, deviceId) {
  return this.rows.find(function (row) {
    return row.session_token === token && row.device_id === deviceId;
  }) || null;
};

FileStore.prototype.findById = async function (id) {
  var want = Number(id);
  return this.rows.find(function (row) { return Number(row.id) === want; }) || null;
};

FileStore.prototype.listAll = async function () {
  return this.rows.slice().sort(function (a, b) { return Number(b.id) - Number(a.id); });
};

FileStore.prototype.update = async function (id, patch) {
  var row = this.rows.find(function (item) { return Number(item.id) === Number(id); });
  if (!row) return null;
  Object.assign(row, patch);
  this._save();
  return row;
};

function MysqlStore(pool) {
  this.pool = pool;
}

MysqlStore.prototype.insertUnused = async function (row) {
  await this.pool.query(
    'INSERT INTO licenses (key_hash, key_suffix, plan, status, created_by, created_at) VALUES (?, ?, ?, \'unused\', ?, ?)',
    [row.key_hash, row.key_suffix, row.plan, row.created_by, new Date()]
  );
};

MysqlStore.prototype.findByHash = async function (hash) {
  var result = await this.pool.query('SELECT * FROM licenses WHERE key_hash = ? LIMIT 1', [hash]);
  return result[0][0] || null;
};

MysqlStore.prototype.findBySession = async function (token, deviceId) {
  var result = await this.pool.query(
    'SELECT * FROM licenses WHERE session_token = ? AND device_id = ? LIMIT 1',
    [token, deviceId]
  );
  return result[0][0] || null;
};

MysqlStore.prototype.findById = async function (id) {
  var result = await this.pool.query('SELECT * FROM licenses WHERE id = ? LIMIT 1', [id]);
  return result[0][0] || null;
};

MysqlStore.prototype.listAll = async function () {
  var result = await this.pool.query('SELECT * FROM licenses ORDER BY id DESC');
  return result[0] || [];
};

MysqlStore.prototype.update = async function (id, patch) {
  var fields = [];
  var values = [];
  Object.keys(patch).forEach(function (key) {
    fields.push(key + ' = ?');
    values.push(patch[key]);
  });
  values.push(id);
  await this.pool.query('UPDATE licenses SET ' + fields.join(', ') + ' WHERE id = ?', values);
  var result = await this.pool.query('SELECT * FROM licenses WHERE id = ? LIMIT 1', [id]);
  return result[0][0] || null;
};

async function openStore() {
  if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) {
    return { kind: 'file', store: new FileStore(), mysql: 'not_configured' };
  }
  var pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT) || 3306,
    waitForConnections: true,
    connectionLimit: 6,
    enableKeepAlive: true,
    timezone: 'Z',
    connectTimeout: 8000
  });
  try {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS licenses (' +
        'id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,' +
        'key_hash CHAR(64) NOT NULL,' +
        'key_suffix VARCHAR(8) NOT NULL,' +
        'plan VARCHAR(16) NOT NULL,' +
        'status VARCHAR(16) NOT NULL,' +
        'display_name VARCHAR(80) DEFAULT NULL,' +
        'device_id VARCHAR(80) DEFAULT NULL,' +
        'session_token VARCHAR(64) DEFAULT NULL,' +
        'activated_at DATETIME DEFAULT NULL,' +
        'expires_at DATETIME DEFAULT NULL,' +
        'created_by BIGINT NOT NULL,' +
        'created_at DATETIME DEFAULT NULL,' +
        'last_seen_at DATETIME DEFAULT NULL,' +
        'UNIQUE KEY uq_key_hash (key_hash)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8'
    );
    await pool.query('SELECT 1');
    return { kind: 'mysql', store: new MysqlStore(pool), mysql: 'ok' };
  } catch (err) {
    try { await pool.end(); } catch (_) {}
    var code = (err && (err.code || err.message)) ? String(err.code || err.message) : 'error';
    process.stderr.write('mysql unavailable: ' + code + '\n');
    return { kind: 'file', store: new FileStore(), mysql: code };
  }
}

module.exports = { openStore };
