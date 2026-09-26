// Vendor-only "who did I sell this to" tracking database — a local
// better-sqlite3 file kept alongside the private key, NEVER committed
// (see .gitignore) and NEVER shipped with the app. Used by both the CLI
// (generate-license.cjs) and the BillNest Dashboard so every license either
// tool issues shows up in one combined history.
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'licenses.db');
let db = null;

function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      modules TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT,
      blob TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function listLicenses() {
  return getDb().prepare('SELECT * FROM licenses ORDER BY updated_at DESC').all();
}

function getLicense(id) {
  return getDb().prepare('SELECT * FROM licenses WHERE id = ?').get(id);
}

// Records a freshly-issued license (new client, or a brand-new key for an
// existing one) as its own row — keeps full history instead of overwriting.
function recordLicense({ clientName, machineId, modules, issuedAt, expiresAt, blob, notes }) {
  const stmt = getDb().prepare(`
    INSERT INTO licenses (client_name, machine_id, modules, issued_at, expires_at, blob, notes)
    VALUES (@clientName, @machineId, @modules, @issuedAt, @expiresAt, @blob, @notes)
  `);
  const info = stmt.run({
    clientName,
    machineId,
    modules: JSON.stringify(modules),
    issuedAt,
    expiresAt: expiresAt || null,
    blob,
    notes: notes || '',
  });
  return getLicense(info.lastInsertRowid);
}

// Extending/re-issuing overwrites the SAME row (same client/machine keeps
// one current row) with the freshly-signed blob + new dates, so the
// dashboard's list always shows each client's one CURRENT license at a
// glance, while `notes` can still carry manual history if the vendor wants.
function updateLicense(id, { modules, issuedAt, expiresAt, blob, notes }) {
  getDb().prepare(`
    UPDATE licenses
    SET modules = @modules, issued_at = @issuedAt, expires_at = @expiresAt, blob = @blob,
        notes = COALESCE(@notes, notes), updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id,
    modules: JSON.stringify(modules),
    issuedAt,
    expiresAt: expiresAt || null,
    blob,
    notes: notes ?? null,
  });
  return getLicense(id);
}

function deleteLicense(id) {
  getDb().prepare('DELETE FROM licenses WHERE id = ?').run(id);
}

module.exports = { listLicenses, getLicense, recordLicense, updateLicense, deleteLicense };
