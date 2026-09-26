// VENDOR-ONLY TOOL — the "BillNest Dashboard": a small local web app for
// tracking every license you've ever issued (who, which machine, which
// modules, expiry) and for creating/extending licenses through a UI instead
// of the command line. Run with `npm run dashboard`, opens in your browser.
// NEVER expose this on a public network — it holds your signing key.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { generateLicenseBlob, resolveModules } = require('../scripts/license-authority/license-core.cjs');
const licensesDb = require('../scripts/license-authority/licenses-db.cjs');

const PORT = process.env.DASHBOARD_PORT || 4790;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([.]{2}[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

function statusFor(license) {
  if (!license.expires_at) return 'PERPETUAL';
  return new Date(license.expires_at) < new Date() ? 'EXPIRED' : 'ACTIVE';
}

function serializeLicense(row) {
  return {
    id: row.id,
    clientName: row.client_name,
    machineId: row.machine_id,
    modules: JSON.parse(row.modules),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    notes: row.notes,
    blob: row.blob,
    status: statusFor(row),
    updatedAt: row.updated_at,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/licenses' && req.method === 'GET') {
      const rows = licensesDb.listLicenses().map(serializeLicense);
      return sendJson(res, 200, rows);
    }

    if (url.pathname === '/api/licenses' && req.method === 'POST') {
      const body = await readBody(req);
      const { machineId, clientName, expiry, modules, notes } = body;
      const { blob, payload } = generateLicenseBlob({
        machineId,
        hotelName: clientName,
        expiryArg: expiry,
        modulesArg: modules,
      });
      const row = licensesDb.recordLicense({
        clientName: payload.hotelName,
        machineId: payload.machineId,
        modules: payload.modules,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        blob,
        notes,
      });
      return sendJson(res, 201, serializeLicense(row));
    }

    const extendMatch = url.pathname.match(/^\/api\/licenses\/(\d+)\/extend$/);
    if (extendMatch && req.method === 'POST') {
      const id = Number(extendMatch[1]);
      const existing = licensesDb.getLicense(id);
      if (!existing) return sendJson(res, 404, { error: 'License not found' });
      const body = await readBody(req);
      const modulesKey = body.modules
        ? body.modules
        : (JSON.parse(existing.modules).includes('food') && JSON.parse(existing.modules).includes('rooms')
          ? 'both'
          : JSON.parse(existing.modules).includes('food') ? 'food' : 'rooms');
      resolveModules(modulesKey); // validates
      const { blob, payload } = generateLicenseBlob({
        machineId: existing.machine_id,
        hotelName: existing.client_name,
        expiryArg: body.expiry,
        modulesArg: modulesKey,
      });
      const row = licensesDb.updateLicense(id, {
        modules: payload.modules,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        blob,
        notes: body.notes,
      });
      return sendJson(res, 200, serializeLicense(row));
    }

    // Revoke: re-issues the license with expiresAt = yesterday so the
    // customer's app blocks access on its next hourly recheck or restart.
    // The new (expired) blob must be sent to the customer for them to apply.
    const revokeMatch = url.pathname.match(/^\/api\/licenses\/(\d+)\/revoke$/);
    if (revokeMatch && req.method === 'POST') {
      const id = Number(revokeMatch[1]);
      const existing = licensesDb.getLicense(id);
      if (!existing) return sendJson(res, 404, { error: 'License not found' });
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const m = JSON.parse(existing.modules);
      const modulesKey = m.includes('food') && m.includes('rooms') ? 'both' : m.includes('food') ? 'food' : 'rooms';
      const { blob, payload } = generateLicenseBlob({
        machineId: existing.machine_id,
        hotelName: existing.client_name,
        expiryArg: yesterday,
        modulesArg: modulesKey,
      });
      const row = licensesDb.updateLicense(id, {
        modules: payload.modules,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        blob,
        notes: existing.notes,
      });
      return sendJson(res, 200, serializeLicense(row));
    }

    const deleteMatch = url.pathname.match(/^\/api\/licenses\/(\d+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      licensesDb.deleteLicense(Number(deleteMatch[1]));
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      return serveStatic(req, res, url.pathname);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n🧾 BillNest Dashboard running at http://localhost:${PORT}\n`);
  const { exec } = require('child_process');
  const url = `http://localhost:${PORT}`;
  const openCmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(openCmd, () => {});
});
