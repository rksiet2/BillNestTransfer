// Offline, machine-locked software licensing.
//
// How it works:
//   1. Each installation computes a MACHINE ID from a stable hardware
//      identifier (the motherboard's SMBIOS UUID) — this survives Windows
//      reinstalls/updates but changes if the app is copied to different
//      hardware.
//   2. The vendor (you) runs a private tool that is NEVER shipped with the
//      app (scripts/license-authority/generate-license.cjs) to Ed25519-sign
//      { machineId, hotelName, expiresAt, modules } with a private key only
//      you hold. `modules` is which parts of the app this key unlocks —
//      ['food','rooms'] (full app), ['food'] (Food Billing only) or
//      ['rooms'] (Hotel/Room Booking only) — so a "Food Billing only" or
//      "Hotel Billing only" plan can be sold as a cheaper, restricted key.
//   3. This app verifies that signature using the PUBLIC key baked in below
//      (safe to expose publicly — a public key can never be used to forge a
//      new license) and additionally checks the signed machineId matches
//      THIS machine's own id.
//   4. Copying the whole install (database, license file, everything) to a
//      different PC changes the machine id, so the exact same license file
//      no longer validates there — the new machine needs its own license,
//      which only the vendor can issue (they hold the only private key).
//
// Fully offline — no server, no internet requirement, consistent with the
// rest of this app's offline-first design.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { APP_NAME } = require('./brand.cjs');
const { execSync } = require('child_process');
const { app } = require('electron');

// Public half of the vendor's signing keypair.
// Generate your own real keypair with:
//   node scripts/license-authority/generate-keypair.cjs
// then paste the printed public key here, replacing the placeholder below.
// Keep the matching PRIVATE key off this repo/computer — see
// scripts/license-authority/README.md.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAGK3zun9EvSWMGOSY2VBq2fzsrzwEhPdiMAGcFORTjEI=
-----END PUBLIC KEY-----`;

function licenseFilePath() {
  return path.join(app.getPath('userData'), 'license.lic');
}

// The SMBIOS UUID is written into the motherboard firmware at manufacture —
// stable across OS reinstalls/app reinstalls, unique per physical machine,
// and (unlike a MAC address) not something that changes if a network
// adapter is swapped or Wi-Fi/Ethernet is used interchangeably. Falls back
// to a hash of hostname+CPU+RAM if PowerShell/WMI is ever unavailable
// (rare — e.g. a locked-down VM), which is still stable per machine even if
// slightly less tamper-resistant than the SMBIOS UUID.
function getMachineId() {
  try {
    const out = execSync(
      'powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"',
      { timeout: 5000, windowsHide: true }
    ).toString().trim();
    if (out && out.length > 8) return crypto.createHash('sha256').update(out).digest('hex');
  } catch (_) {
    // fall through to the fallback below
  }
  const fallback = `${os.hostname()}|${os.cpus()?.[0]?.model || ''}|${os.totalmem()}`;
  return crypto.createHash('sha256').update(fallback).digest('hex');
}

// Verifies a base64 license blob's signature + machine binding + expiry.
// Returns the decoded payload on success; throws a user-facing Error otherwise.
function verifyLicenseBlob(blobBase64) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(blobBase64).trim(), 'base64').toString('utf8'));
  } catch (_) {
    throw new Error(`This license code is corrupted or not a valid ${APP_NAME} license.`);
  }
  const { payload, signature } = parsed || {};
  if (!payload || !signature) {
    throw new Error(`This license code is corrupted or not a valid ${APP_NAME} license.`);
  }

  let publicKey;
  try {
    publicKey = crypto.createPublicKey(PUBLIC_KEY_PEM);
  } catch (_) {
    throw new Error('This app build has no valid vendor public key configured — contact the vendor.');
  }
  const payloadBuf = Buffer.from(JSON.stringify(payload));
  const sigBuf = Buffer.from(signature, 'base64');
  const ok = crypto.verify(null, payloadBuf, publicKey, sigBuf);
  if (!ok) {
    throw new Error('This license code is not valid for this software (signature check failed).');
  }

  if (payload.machineId !== getMachineId()) {
    throw new Error('This license is bound to a different computer. Contact the vendor for a new license for this machine.');
  }
  if (payload.expiresAt) {
    const expiresMs = new Date(payload.expiresAt).getTime();
    const nowMs = Date.now();
    const GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7-day grace window after expiry
    if (nowMs > expiresMs + GRACE_MS) {
      // Fully past grace — block access
      throw new Error('EXPIRED');
    }
    if (nowMs > expiresMs) {
      // Still within grace — allow but flag so UI can warn
      const daysLeft = Math.ceil((expiresMs + GRACE_MS - nowMs) / (24 * 60 * 60 * 1000));
      payload.gracePeriodDaysLeft = daysLeft;
    }
  }
  // Older licenses issued before per-module keys existed have no `modules`
  // field — treat those as unrestricted (full app) so nobody who already
  // activated loses access when this app is updated.
  if (!Array.isArray(payload.modules) || !payload.modules.length) {
    payload.modules = ['food', 'rooms'];
  }
  return payload;
}

// Returns { valid: true, payload, machineId } or { valid: false, reason, machineId }.
// Never throws — safe to call unconditionally at startup.
function getLicenseStatus() {
  const machineId = getMachineId();
  const filePath = licenseFilePath();
  if (!fs.existsSync(filePath)) {
    return { valid: false, reason: 'NOT_ACTIVATED', machineId };
  }
  try {
    const blob = fs.readFileSync(filePath, 'utf8');
    const payload = verifyLicenseBlob(blob);
    return { valid: true, payload, machineId };
  } catch (err) {
    // Try to extract expiresAt from the raw blob so ActivationScreen can show
    // the actual expiry date even when the license is fully expired past grace.
    let expiresAt = null;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(Buffer.from(String(raw).trim(), 'base64').toString('utf8'));
      expiresAt = parsed?.payload?.expiresAt || null;
    } catch (_) { /* ignore */ }
    return { valid: false, reason: err.message, machineId, expiresAt };
  }
}

// Validates the pasted/imported license blob and, only if fully valid,
// persists it to disk. Throws with a clean user-facing message on any
// failure (bad code, wrong machine, expired, tampered, etc.).
function activateLicense(blobBase64) {
  let payload;
  try {
    payload = verifyLicenseBlob(blobBase64);
  } catch (err) {
    if (err.message === 'EXPIRED') {
      throw new Error('This license has expired. Contact the vendor to renew before activating.');
    }
    throw err;
  }
  const filePath = licenseFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(blobBase64).trim(), 'utf8');
  return payload;
}

module.exports = { getMachineId, getLicenseStatus, activateLicense, licenseFilePath };
