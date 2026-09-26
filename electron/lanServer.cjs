// Multi-Terminal Sync (opt-in) — a tiny dependency-free LAN server so 2+
// billing counters (or a future Captain/Waiter phone) on the same WiFi can
// all share ONE live database, instead of each device having its own
// separate local file. Only ever started on the device set as "Host" in
// Settings > Features > Multi-Terminal Sync.
//
// Deliberately built with Node's built-in `http` module only (no express/ws)
// — this office network can't install new npm packages, so anything relying
// on a new dependency literally couldn't be verified here. This also keeps
// the eventual footprint tiny and dependency-free for customers who install
// BillNest fresh.
//
// Protocol: a single generic RPC endpoint. The renderer's `window.api.xyz()`
// calls map 1:1 to Electron IPC channel names (see preload.cjs); this server
// re-uses those exact same channel names and their already-registered
// `ipcMain.handle` functions (captured into `registeredHandlers` in
// main.cjs), so a Client device's request for e.g. "table:list" runs the
// IDENTICAL code path a local desktop click would have run — just carried
// over HTTP instead of Electron's IPC transport.
const http = require('http');
const os = require('os');
const crypto = require('crypto');

let server = null;
let listening = false; // only true once the OS actually confirms the port bound (the 'listening' event)
let lastStartError = null;

function getLocalIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Only real, external IPv4 addresses are candidates at all.
      if (net.family !== 'IPv4' || net.internal) continue;
      // APIPA/link-local (169.254.x.x) means "no real network" — a cable
      // unplugged/DHCP failure address, never useful to hand a phone.
      if (net.address.startsWith('169.254.')) continue;
      candidates.push({ name, address: net.address });
    }
  }
  if (candidates.length === 0) return '127.0.0.1';

  // Score each candidate so the address we advertise to a phone/Client is
  // the one actually reachable over the same WiFi/LAN, not a VPN tunnel or
  // virtual/host-only adapter that happens to enumerate first. Lower score
  // wins. This matters a lot on a typical office/corporate laptop, which
  // commonly has a VPN client and/or Hyper-V/WSL/Docker virtual adapters
  // installed alongside the real WiFi/Ethernet NIC.
  function score(candidate) {
    const n = candidate.name.toLowerCase();
    const isVirtualName = /vpn|tap|tun|zerotier|tailscale|wireguard|virtual|vethernet|hyper-v|vmware|virtualbox|docker|wsl|loopback|bluetooth/.test(n);
    const isPrivateRange = /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(candidate.address);
    let s = 0;
    if (isVirtualName) s += 100; // heavily deprioritize known virtual/VPN adapter names
    if (!isPrivateRange) s += 10; // a real-looking public/other range is still less likely to be the LAN we want
    // Wi-Fi/Ethernet-named adapters are the most likely "actual LAN" NIC.
    if (/wi-?fi|wireless|ethernet|en0|eth\d/.test(n)) s -= 5;
    return s;
  }

  candidates.sort((a, b) => score(a) - score(b));
  return candidates[0].address;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-BillNest-Token',
  });
  res.end(data);
}

function authorized(req, authToken) {
  const supplied = req.headers['x-billnest-token'];
  if (!authToken || typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(authToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// These operations affect the Host machine or expose local files. They remain
// available to the Host's own desktop IPC, but never to LAN clients.
const LOCAL_ONLY_CHANNELS = new Set([
  'backup:chooseFolder', 'backup:now', 'backup:openFolder', 'backup:restore',
  'data:exportForMobile', 'room:pickIdDocument',
  'bill:openRecordsFolder', 'kot:openRecordsFolder', 'sync:getLocalConfig',
  'sync:setLocalConfig', 'sync:restart', 'app:relaunch',
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      // Basic guard against a runaway/malicious body on a LAN service.
      if (raw.length > 5 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

// `handlers` is the live `registeredHandlers` map from main.cjs (same object
// reference — new channels added later are automatically picked up).
function startLanServer({ port, handlers, getHotelName, getFeatureFlags, authToken }) {
  if (server) return { alreadyRunning: true, ip: getLocalIp(), port, listening };

  lastStartError = null;
  const instance = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      if (!authorized(req, authToken)) {
        sendJson(res, 401, { ok: false, error: 'Authentication required.' });
        return;
      }
      // `captainEnabled` lets a joining device (phone/tablet picking
      // "Captain / Waiter Mode") know — BEFORE it commits to connecting —
      // whether this Host's Owner has actually turned that feature on in
      // Settings > Features. Without this, a joining device had no way to
      // tell "not enabled yet" apart from "wrong IP/offline".
      const flags = getFeatureFlags ? getFeatureFlags() : {};
      sendJson(res, 200, {
        ok: true,
        hotelName: getHotelName ? getHotelName() : '',
        captainEnabled: !!flags.feature_captain_app,
        tableManagementEnabled: !!flags.feature_table_management,
        version: 1,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/rpc') {
      try {
        if (!authorized(req, authToken)) {
          sendJson(res, 401, { ok: false, error: 'Authentication required.' });
          return;
        }
        const raw = await readBody(req);
        const { channel, args } = JSON.parse(raw || '{}');
        if (LOCAL_ONLY_CHANNELS.has(channel)) {
          sendJson(res, 403, { ok: false, error: 'This operation is only available on the Host device.' });
          return;
        }
        const handler = handlers[channel];
        if (!handler) {
          sendJson(res, 404, { ok: false, error: `Unknown channel: ${channel}` });
          return;
        }
        // Electron handlers are `(event, ...args) => ...`; `event` is never
        // actually used by anything registered in this app (checked — every
        // handler either ignores it or only destructures its own args), so a
        // null placeholder is safe here.
        const result = await handler(null, ...(Array.isArray(args) ? args : []));
        sendJson(res, 200, { ok: true, result });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: (err && err.message) || String(err) });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  });

  server = instance;
  instance.on('error', (err) => {
    // Fail-safe: a port conflict (EADDRINUSE), permission denial, etc. must
    // never crash the app or leave the module in a "half started" state
    // where isLanServerRunning() lies. Record the reason so Settings can
    // show a real error instead of an unexplained "Not running".
    lastStartError = (err && err.code) ? `${err.code}: ${err.message}` : String(err);
    listening = false;
    server = null;
  });
  instance.on('listening', () => {
    listening = true;
  });
  instance.on('close', () => {
    listening = false;
  });
  instance.listen(port, '0.0.0.0');
  return { alreadyRunning: false, ip: getLocalIp(), port };
}

function stopLanServer() {
  if (server) {
    server.close();
    server = null;
  }
  listening = false;
}

function isLanServerRunning() {
  return listening;
}

function getLastStartError() {
  return lastStartError;
}

module.exports = { startLanServer, stopLanServer, isLanServerRunning, getLocalIp, getLastStartError };
