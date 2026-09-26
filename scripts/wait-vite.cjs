#!/usr/bin/env node
// Wait for any Vite dev port in range 5173-5185 to respond, then exit 0.
// Unlike `wait-on` (which requires ALL listed resources), this exits as soon
// as the FIRST port answers — matching Vite's incremented-port behaviour.
const http = require('http');

const PORTS = [5173,5174,5175,5176,5177,5178,5179,5180,5181,5182,5183,5184,5185];
const TIMEOUT_MS = 30000;
const POLL_MS = 300;

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port, path: '/', timeout: 500 }, () => resolve(port));
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const results = await Promise.all(PORTS.map(probe));
    const found = results.find((p) => p !== null);
    if (found !== undefined) {
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.error('Timed out waiting for Vite dev server');
  process.exit(1);
}

main();
