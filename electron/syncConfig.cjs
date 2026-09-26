// Multi-Terminal Sync's role/host-ip/port are deliberately kept OUT of the
// normal `settings` table (db/database.cjs). That table is the shared
// restaurant data — once a device is a Client, every settings:get/save call
// is transparently forwarded to the Host over HTTP (see preload-client.cjs),
// so a Client device could never reliably read or change ITS OWN role that
// way (it would be reading/writing the Host's role instead!).
//
// Instead, each device's sync role lives in a small local JSON file that is
// ALWAYS read/written directly on this machine, never proxied anywhere —
// exactly the one piece of config that must stay truly local per device.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let configPath = null;

function init(userDataDir) {
  configPath = path.join(userDataDir, 'sync-config.json');
}

function getConfig() {
  const defaults = { role: '', hostIp: '', port: '4001', authToken: '' };
  let config = defaults;
  if (configPath && fs.existsSync(configPath)) {
    try { config = { ...defaults, ...JSON.parse(fs.readFileSync(configPath, 'utf-8')) }; } catch { /* reset below */ }
  }
  // A random per-install token is required for LAN sync. Persisting it keeps
  // existing pairings working while preventing anonymous RPC access.
  if (!config.authToken) {
    config = { ...config, authToken: crypto.randomBytes(32).toString('base64url') };
    if (configPath) fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }
  return config;
}

function saveConfig(partial) {
  const next = { ...getConfig(), ...partial };
  if (!next.authToken) next.authToken = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

module.exports = { init, getConfig, saveConfig };
