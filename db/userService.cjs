// User accounts + PIN-based login. Fully offline — no external auth service.
// PINs are never stored in plain text: each user gets a random salt, and we
// store only sha256(pin + salt). This is sufficient for a local, physical-
// access-control use case (protecting a shared counter PC from staff opening
// screens they shouldn't), not a hardened multi-tenant auth system.
const crypto = require('crypto');
const { getDb } = require('./database.cjs');
const { sendGmail } = require('./mailer.cjs');

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(`${salt}:${pin}`).digest('hex');
}

function genSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function sanitizeUser(row) {
  if (!row) return null;
  // Owner is always full access regardless of the stored `access` value —
  // module restriction only ever applies to Staff accounts.
  return { id: row.id, name: row.name, role: row.role, access: row.role === 'OWNER' ? 'BOTH' : (row.access || 'BOTH'), active: !!row.active, createdAt: row.created_at };
}

function normalizeAccess(access) {
  return ['FOOD', 'ROOMS', 'BOTH'].includes(access) ? access : 'BOTH';
}

// True until an Owner account exists (drives whether the app shows the
// first-time "Create Owner PIN" setup step vs. the normal PIN login screen).
function hasOwnerAccount() {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'OWNER' AND active = 1").get();
  return row.c > 0;
}

// Called once, from the Setup Wizard, to create the very first account
// (always OWNER role) with the PIN the owner chooses during setup.
function createOwnerAccount({ name, pin }) {
  if (hasOwnerAccount()) throw new Error('An owner account already exists.');
  if (!pin || !/^\d{4,6}$/.test(pin)) throw new Error('PIN must be 4 to 6 digits.');
  const db = getDb();
  const salt = genSalt();
  const info = db
    .prepare('INSERT INTO users (name, role, pin_hash, pin_salt) VALUES (?,?,?,?)')
    .run(name || 'Owner', 'OWNER', hashPin(pin, salt), salt);
  return sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid));
}

// Owner-only: add a Staff account with its own PIN, and its module access
// (BOTH / FOOD / ROOMS — defaults to BOTH if not specified).
function createStaffAccount({ name, pin, access }) {
  if (!name) throw new Error('Staff name is required.');
  if (!pin || !/^\d{4,6}$/.test(pin)) throw new Error('PIN must be 4 to 6 digits.');
  const db = getDb();
  const salt = genSalt();
  const info = db
    .prepare('INSERT INTO users (name, role, access, pin_hash, pin_salt) VALUES (?,?,?,?,?)')
    .run(name, 'STAFF', normalizeAccess(access), hashPin(pin, salt), salt);
  return sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid));
}

// Owner-only: change an existing staff member's module access without
// needing to deactivate/recreate their account.
function updateUserAccess(id, access) {
  const db = getDb();
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw new Error('User not found.');
  if (target.role === 'OWNER') throw new Error("The Owner account always has full access.");
  db.prepare('UPDATE users SET access = ? WHERE id = ?').run(normalizeAccess(access), id);
  return sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function listUsers() {
  const db = getDb();
  return db.prepare('SELECT * FROM users ORDER BY (role = \'OWNER\') DESC, name').all().map(sanitizeUser);
}

// Owner-only: deactivate a staff account (soft-delete; keeps history intact,
// and can't be undone to reactivate accidentally without re-adding).
function deactivateUser(id) {
  const db = getDb();
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw new Error('User not found.');
  if (target.role === 'OWNER') throw new Error('Cannot deactivate the Owner account.');
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
  return true;
}

// Owner-only: reset a staff member's PIN (e.g. they forgot it).
function resetPin(id, newPin) {
  if (!newPin || !/^\d{4,6}$/.test(newPin)) throw new Error('PIN must be 4 to 6 digits.');
  const db = getDb();
  const salt = genSalt();
  const info = db.prepare('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(hashPin(newPin, salt), salt, id);
  if (info.changes === 0) throw new Error('User not found.');
  return true;
}

// Attempts a PIN login across all active accounts (PINs aren't tied to a
// visible username list at the lock screen, by design, so staff PINs stay
// private from each other) and returns the matching user, or null.
function loginWithPin(pin) {
  const db = getDb();
  const users = db.prepare('SELECT * FROM users WHERE active = 1').all();
  for (const u of users) {
    if (hashPin(pin, u.pin_salt) === u.pin_hash) return sanitizeUser(u);
  }
  return null;
}

// Self-service: any logged-in user (Owner or Staff) changes their own PIN
// after re-proving they know the current one. This is distinct from
// Owner-only `resetPin`, which resets someone else's PIN with no proof.
function changePin(id, currentPin, newPin) {
  if (!newPin || !/^\d{4,6}$/.test(newPin)) throw new Error('New PIN must be 4 to 6 digits.');
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('User not found.');
  if (hashPin(currentPin, user.pin_salt) !== user.pin_hash) throw new Error('Current PIN is incorrect.');
  const salt = genSalt();
  db.prepare('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(hashPin(newPin, salt), salt, id);
  return true;
}

// ---------------- Forgot PIN (Owner only) via email OTP ----------------
// Storage piggybacks on the generic `settings` key-value table (same one
// used for hotel name/address/tax) — no schema migration needed.
function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function clearSetting(key) {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

function hashOtp(otp, salt) {
  return crypto.createHash('sha256').update(`${salt}:${otp}`).digest('hex');
}

// Sends a fresh 6-digit OTP to the Owner's configured recovery Gmail. Throws
// if no recovery email/app password has been set up yet in Settings.
async function requestOwnerPinResetOtp() {
  const email = getSetting('recovery_email');
  const appPassword = getSetting('recovery_app_password');
  if (!email || !appPassword) {
    throw new Error('No recovery email is configured yet. Ask the Owner to set one up in Settings first.');
  }
  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = genSalt();
  setSetting('recovery_otp_hash', hashOtp(otp, salt));
  setSetting('recovery_otp_salt', salt);
  setSetting('recovery_otp_expires', String(Date.now() + 10 * 60 * 1000)); // 10 minutes

  await sendGmail({
    user: email,
    pass: appPassword,
    to: email,
    subject: 'BillNest — Your PIN reset code',
    text: `Your BillNest Owner PIN reset code is: ${otp}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
  });
  // Mask the email shown back to the UI (e.g. "ow***@gmail.com").
  const masked = email.replace(/^(.{2}).+(@.+)$/, '$1***$2');
  return { sentTo: masked };
}

// Verifies the OTP and, if valid, sets a new PIN for the Owner account.
function verifyOwnerPinResetOtp(otp, newPin) {
  if (!newPin || !/^\d{4,6}$/.test(newPin)) throw new Error('New PIN must be 4 to 6 digits.');
  const storedHash = getSetting('recovery_otp_hash');
  const salt = getSetting('recovery_otp_salt');
  const expires = Number(getSetting('recovery_otp_expires') || 0);
  if (!storedHash || !salt) throw new Error('No PIN reset was requested, or it already expired. Please request a new code.');
  if (Date.now() > expires) {
    clearSetting('recovery_otp_hash');
    clearSetting('recovery_otp_salt');
    clearSetting('recovery_otp_expires');
    throw new Error('That code has expired. Please request a new one.');
  }
  if (hashOtp(otp, salt) !== storedHash) throw new Error('Incorrect code. Please check the email and try again.');

  const db = getDb();
  const owner = db.prepare("SELECT * FROM users WHERE role = 'OWNER' AND active = 1").get();
  if (!owner) throw new Error('No Owner account found.');
  const newSalt = genSalt();
  db.prepare('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(hashPin(newPin, newSalt), newSalt, owner.id);

  clearSetting('recovery_otp_hash');
  clearSetting('recovery_otp_salt');
  clearSetting('recovery_otp_expires');
  return true;
}

module.exports = {
  hasOwnerAccount,
  createOwnerAccount,
  createStaffAccount,
  updateUserAccess,
  listUsers,
  deactivateUser,
  resetPin,
  changePin,
  requestOwnerPinResetOtp,
  verifyOwnerPinResetOtp,
  loginWithPin,
};
