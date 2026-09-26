// Shared signing logic used by BOTH the CLI (generate-license.cjs) and the
// BillNest Dashboard (license-dashboard/). Kept in one place so the two
// tools can never drift out of sync on how a license blob is built.
// VENDOR-ONLY — never ship this file or private-key.pem with the app.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_PATH = path.join(__dirname, 'private-key.pem');

const MODULE_SETS = {
  both: ['food', 'rooms'],
  food: ['food'],
  rooms: ['rooms'],
};

function modulesKeyFor(modules) {
  const set = new Set(modules);
  if (set.has('food') && set.has('rooms')) return 'both';
  if (set.has('food')) return 'food';
  if (set.has('rooms')) return 'rooms';
  return 'both';
}

function loadPrivateKey() {
  if (!fs.existsSync(KEY_PATH)) {
    const err = new Error(
      `Private key not found at ${KEY_PATH}. Run "node scripts/license-authority/generate-keypair.cjs" ` +
      'first, then save the printed PRIVATE KEY block into that exact file path.'
    );
    err.code = 'NO_PRIVATE_KEY';
    throw err;
  }
  return crypto.createPrivateKey(fs.readFileSync(KEY_PATH, 'utf8'));
}

function resolveModules(modulesArg) {
  const key = (modulesArg || 'both').trim().toLowerCase();
  if (!MODULE_SETS[key]) {
    const err = new Error(`"${modulesArg}" is not a valid module option. Use "both", "food" or "rooms".`);
    err.code = 'BAD_MODULES';
    throw err;
  }
  return MODULE_SETS[key];
}

function resolveExpiry(expiryArg) {
  if (!expiryArg || expiryArg === 'perpetual') return null;
  const d = new Date(expiryArg);
  if (Number.isNaN(d.getTime())) {
    const err = new Error(`"${expiryArg}" is not a valid date. Use YYYY-MM-DD or "perpetual".`);
    err.code = 'BAD_EXPIRY';
    throw err;
  }
  return d.toISOString();
}

// Builds + signs a license blob. `modulesArg` is 'both'|'food'|'rooms',
// `expiryArg` is 'YYYY-MM-DD'|'perpetual'|falsy.
function generateLicenseBlob({ machineId, hotelName, expiryArg, modulesArg }) {
  if (!machineId || !hotelName) {
    const err = new Error('machineId and hotelName are both required.');
    err.code = 'MISSING_FIELDS';
    throw err;
  }
  const privateKey = loadPrivateKey();
  const modules = resolveModules(modulesArg);
  const expiresAt = resolveExpiry(expiryArg);

  const payload = {
    machineId: String(machineId).trim(),
    hotelName: String(hotelName).trim(),
    issuedAt: new Date().toISOString(),
    expiresAt,
    modules,
  };

  const payloadBuf = Buffer.from(JSON.stringify(payload));
  const signature = crypto.sign(null, payloadBuf, privateKey).toString('base64');
  const blob = Buffer.from(JSON.stringify({ payload, signature })).toString('base64');

  return { blob, payload };
}

module.exports = {
  MODULE_SETS,
  modulesKeyFor,
  resolveModules,
  resolveExpiry,
  generateLicenseBlob,
  loadPrivateKey,
};
