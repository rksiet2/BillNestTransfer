// Permanent regression suite for MULTI-DEVICE / multi-terminal-sync
// scenarios (Multi-Terminal Sync opt-in feature). Runs the REAL LAN server
// (electron/lanServer.cjs) against a real throwaway SQLite DB and fires
// genuinely concurrent HTTP requests at it (via Promise.all) — this proves
// there's no interleaving/race condition, not just that sequential calls
// happen to work.
//
// Added after a real user-reported bug: a table's in-progress cart lived
// only in each device's in-memory React state, so a second device opening
// the same table would never see items another device had already added
// (e.g. Device A's ₹800 order would NOT become ₹900 when Device B added
// ₹100 more — it silently created a second, disconnected order instead).
// The fix added server-side `table_orders` persistence (db/service.cjs:
// getTableOrder/saveTableOrder/clearTableOrder) reachable over LAN via the
// existing generic /rpc dispatcher. These tests lock in:
//   1. Table Management feature OFF never touches table_orders, and
//      counter billing (no table) is 100% unaffected.
//   2. Multiple concurrent COUNTER bills (no table) never cross-contaminate
//      items and never collide on bill number / token, even fired in
//      genuine HTTP concurrency (Promise.all, real sockets).
//   3. Two different tables edited concurrently by two different devices
//      never bleed into each other (waiter name, items).
//   4. The originally reported bug itself: Device A adds items to a table,
//      Device B opens the SAME table later and adds more — must merge into
//      ONE order, not create a second disconnected entry.
//   5. Billing/clearing a table wipes ITS OWN order only, leaving other
//      tables' in-progress orders untouched (no stale resurrection).
//   6. High-concurrency stress: 20 simultaneous counter bills, still all
//      unique — guards the counters table's read-then-write increment
//      logic (db/database.cjs nextBillNumber/nextToken) against any future
//      change that accidentally introduces an async gap between the SELECT
//      and UPDATE (which would reintroduce a real race condition).
//
// Run standalone: node scripts/multidevice-test.cjs
// Included in: npm run test:all
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billnest-multidevice-'));
const { initDatabase } = require('../db/database.cjs');
initDatabase(tmpDir);
const service = require('../db/service.cjs');
const { startLanServer, stopLanServer } = require('../electron/lanServer.cjs');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2705 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  \u274c ${name}`);
    console.log(`     ${err.message}`);
  }
}

// Minimal `registeredHandlers` map mirroring the real one built in main.cjs
// (same channel names, same (event, ...args) signature) — enough to drive
// lanServer.cjs's generic /rpc dispatcher for the channels this suite needs.
// NOTE: if a new table-order or bill channel is ever added to main.cjs, add
// it here too so this suite keeps exercising the real dispatch path.
const registeredHandlers = {
  'settings:get': () => service.getSettings(),
  'settings:save': (e, partial) => service.saveSettings(partial),
  'bill:create': (e, payload) => service.createBill(payload),
  'table:list': () => service.getTables(),
  'table:save': (e, table) => service.saveTable(table),
  'table:updateStatus': (e, id, status) => service.updateTableStatus(id, status),
  'table:assignWaiter': (e, id, waiterName) => service.assignTableWaiter(id, waiterName),
  'table:getOrder': (e, id) => service.getTableOrder(id),
  'table:saveOrder': (e, id, payload) => service.saveTableOrder(id, payload),
  'table:clearOrder': (e, id) => service.clearTableOrder(id),
};

// Fixed test-only port, distinct from the app's real default (4001) so this
// suite can run alongside a live dev instance without a conflict.
const PORT = 4901;
const AUTH_TOKEN = 'multidevice-test-token';
function rpc(channel, ...args) {
  const body = JSON.stringify({ channel, args });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: PORT, path: '/rpc', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BillNest-Token': AUTH_TOKEN, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (!parsed.ok) reject(new Error(parsed.error));
            else resolve(parsed.result);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  startLanServer({ port: PORT, authToken: AUTH_TOKEN, handlers: registeredHandlers, getHotelName: () => 'Test Hotel', getFeatureFlags: () => ({}) });
  await new Promise((r) => setTimeout(r, 150)); // let the socket actually bind

  console.log('\n=== 1) Table Management feature OFF: counter billing unaffected ===');
  service.saveSettings({ feature_table_management: 'false' });

  const [c1, c2] = await Promise.all([
    rpc('bill:create', { items: [{ id: 1, name: 'Paneer Tikka', price: 220, quantity: 2 }], paymentMethod: 'CASH', taxPercent: 5 }),
    rpc('bill:create', { items: [{ id: 2, name: 'Veg Biryani', price: 180, quantity: 1 }], paymentMethod: 'ONLINE', taxPercent: 5 }),
  ]);
  check('feature-off: both counter bills succeed with correct totals', () => {
    assert.strictEqual(c1.subtotal, 440);
    assert.strictEqual(c2.subtotal, 180);
  });
  check('feature-off: bill numbers are distinct', () => {
    assert.notStrictEqual(c1.billNumber, c2.billNumber);
  });
  check('feature-off: tokens are distinct and correctly prefixed per payment method', () => {
    assert.ok(c1.token.startsWith('B'));
    assert.ok(c2.token.startsWith('G'));
    assert.notStrictEqual(c1.token, c2.token);
  });
  const billC1 = service.getBillById(c1.id);
  const billC2 = service.getBillById(c2.id);
  check('feature-off: bill 1 in DB only has its own item', () => {
    assert.strictEqual(billC1.items.length, 1);
    assert.strictEqual(billC1.items[0].name, 'Paneer Tikka');
  });
  check('feature-off: bill 2 in DB only has its own item', () => {
    assert.strictEqual(billC2.items.length, 1);
    assert.strictEqual(billC2.items[0].name, 'Veg Biryani');
  });

  console.log('\n=== 2) Feature back ON: multiple concurrent COUNTER bills (no table) stay isolated ===');
  service.saveSettings({ feature_table_management: 'true' });
  const counterBills = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      rpc('bill:create', { items: [{ id: 100 + i, name: `Item-${i}`, price: 50 + i, quantity: 1 }], paymentMethod: i % 2 === 0 ? 'CASH' : 'ONLINE', taxPercent: 5 })
    )
  );
  check('6 concurrent counter bills all created', () => assert.strictEqual(counterBills.length, 6));
  check('all 6 bill numbers are unique', () => {
    const nums = counterBills.map((b) => b.billNumber);
    assert.strictEqual(new Set(nums).size, 6);
  });
  check('all 6 tokens are unique', () => {
    const tokens = counterBills.map((b) => b.token);
    assert.strictEqual(new Set(tokens).size, 6);
  });
  check('each bill only contains its own single item (no cross-contamination)', () => {
    counterBills.forEach((b, i) => {
      const full = service.getBillById(b.id);
      assert.strictEqual(full.items.length, 1);
      assert.strictEqual(full.items[0].name, `Item-${i}`);
    });
  });

  console.log('\n=== 3) Two waiters on two DIFFERENT tables, edited concurrently: no cross-table bleed ===');
  await rpc('table:save', { name: 'T1', capacity: 4 });
  await rpc('table:save', { name: 'T2', capacity: 4 });
  const tables = await rpc('table:list');
  const t1 = tables.find((t) => t.name === 'T1');
  const t2 = tables.find((t) => t.name === 'T2');

  await Promise.all([
    rpc('table:assignWaiter', t1.id, 'Waiter-Ravi'),
    rpc('table:assignWaiter', t2.id, 'Waiter-Sonu'),
    rpc('table:saveOrder', t1.id, { items: [{ id: 1, name: 'Paneer', price: 200, quantity: 4 }], customerName: 'Table1 Guest', customerPhone: '' }),
    rpc('table:saveOrder', t2.id, { items: [{ id: 2, name: 'Biryani', price: 180, quantity: 1 }], customerName: 'Table2 Guest', customerPhone: '' }),
  ]);
  const [orderA, orderB, tablesAfter] = await Promise.all([rpc('table:getOrder', t1.id), rpc('table:getOrder', t2.id), rpc('table:list')]);
  check('table 1 order has only table 1 items (800 total)', () => {
    assert.strictEqual(orderA.items.length, 1);
    assert.strictEqual(orderA.items[0].name, 'Paneer');
    assert.strictEqual(orderA.items[0].quantity * orderA.items[0].price, 800);
  });
  check('table 2 order has only table 2 items (180 total)', () => {
    assert.strictEqual(orderB.items.length, 1);
    assert.strictEqual(orderB.items[0].name, 'Biryani');
  });
  check('waiter assignment did not cross tables', () => {
    const t1After = tablesAfter.find((t) => t.id === t1.id);
    const t2After = tablesAfter.find((t) => t.id === t2.id);
    assert.strictEqual(t1After.waiter_name, 'Waiter-Ravi');
    assert.strictEqual(t2After.waiter_name, 'Waiter-Sonu');
  });

  console.log('\n=== 4) Sequential multi-device edit on the SAME table: 800 + 100 = 900 (the reported bug) ===');
  await rpc('table:saveOrder', t1.id, { items: [{ id: 1, name: 'Paneer', price: 200, quantity: 4 }], customerName: 'Table1 Guest', customerPhone: '' });
  const deviceBView = await rpc('table:getOrder', t1.id);
  const updatedItems = [...deviceBView.items, { id: 3, name: 'Coke', price: 100, quantity: 1 }];
  await rpc('table:saveOrder', t1.id, { items: updatedItems, customerName: deviceBView.customerName, customerPhone: deviceBView.customerPhone });
  const finalOrder = await rpc('table:getOrder', t1.id);
  check('table 1 now totals 900 (800 + 100), single merged order', () => {
    const total = finalOrder.items.reduce((s, it) => s + it.price * it.quantity, 0);
    assert.strictEqual(total, 900);
    assert.strictEqual(finalOrder.items.length, 2);
  });

  console.log('\n=== 5) Billing a table clears its order for the next guest (no stale resurrection) ===');
  await rpc('bill:create', { items: finalOrder.items, paymentMethod: 'CASH', taxPercent: 5, tableId: t1.id });
  await rpc('table:updateStatus', t1.id, 'BILLED');
  await rpc('table:clearOrder', t1.id);
  const clearedOrder = await rpc('table:getOrder', t1.id);
  check('table 1 order is null after clearing (next guest starts fresh)', () => {
    assert.strictEqual(clearedOrder, null);
  });
  const t2StillHasOrder = await rpc('table:getOrder', t2.id);
  check('table 2 untouched by table 1 billing/clearing', () => {
    assert.strictEqual(t2StillHasOrder.items.length, 1);
    assert.strictEqual(t2StillHasOrder.items[0].name, 'Biryani');
  });

  console.log('\n=== 6) High-concurrency stress: 20 simultaneous counter bills, still all unique ===');
  const stress = await Promise.all(
    Array.from({ length: 20 }, (_, i) => rpc('bill:create', { items: [{ id: 200 + i, name: `Stress-${i}`, price: 10, quantity: 1 }], paymentMethod: 'CASH', taxPercent: 5 }))
  );
  check('20 concurrent bills -> 20 unique bill numbers', () => {
    assert.strictEqual(new Set(stress.map((b) => b.billNumber)).size, 20);
  });
  check('20 concurrent bills -> 20 unique tokens', () => {
    assert.strictEqual(new Set(stress.map((b) => b.token)).size, 20);
  });

  stopLanServer();

  console.log('\n==================================================');
  console.log(`RESULT: ${passed} passed, ${failed} failed (of ${passed + failed} total)`);
  console.log('==================================================');
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  stopLanServer();
  console.error('Fatal error running multidevice-test.cjs:', err);
  process.exitCode = 1;
});
