// One-time dev/test utility: seeds ~1 year of random historical bills so we
// can visually check the Reporting page (charts, summary, sales history) and
// general app performance under a realistic data volume. Safe to delete after
// testing - it only INSERTs into bills/bill_items and does not touch the
// live 'counters' table used for today's real bill/token numbering.
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'hotel-billing-software', 'data', 'hotel_billing.db');
console.log('Seeding DB at', dbPath);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const foods = db.prepare('SELECT id, name, price FROM food_items').all();
if (foods.length === 0) {
  console.error('No food items found - seed defaults first by launching the app once.');
  process.exit(1);
}

const insertBill = db.prepare(`
  INSERT INTO bills (bill_number, token, payment_method, customer_name, subtotal, tax_percent, tax_amount, discount, total, status, cancel_reason, created_at)
  VALUES (@bill_number, @token, @payment_method, @customer_name, @subtotal, @tax_percent, @tax_amount, @discount, @total, @status, @cancel_reason, @created_at)
`);
const insertItem = db.prepare(`
  INSERT INTO bill_items (bill_id, food_id, name, price, quantity, total)
  VALUES (@bill_id, @food_id, @name, @price, @quantity, @total)
`);

const customerNames = ['Walk-in', 'Ravi Kumar', 'Anita Sharma', 'Vikram Singh', 'Priya Patel', 'Suresh Rao', 'Meena Iyer', null, null];

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }

const TAX_PERCENT = 5;
const today = new Date();
let totalBillsInserted = 0;
let globalSeq = 0;

const seedDay = db.transaction((dateObj, billsToday) => {
  for (let b = 0; b < billsToday; b++) {
    // Random time during business hours (10:00 - 23:00)
    const hour = randInt(10, 22);
    const minute = randInt(0, 59);
    const second = randInt(0, 59);
    const createdAt = new Date(dateObj);
    createdAt.setHours(hour, minute, second, 0);
    const createdAtStr = createdAt.getFullYear() + '-' +
      String(createdAt.getMonth() + 1).padStart(2, '0') + '-' +
      String(createdAt.getDate()).padStart(2, '0') + ' ' +
      String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ':' + String(second).padStart(2, '0');

    const dateKey = createdAtStr.slice(0, 10).replace(/-/g, '');
    globalSeq++;
    const billNumber = `INV-${dateKey}-SEED${String(globalSeq).padStart(6, '0')}`;
    const paymentMethod = Math.random() < 0.55 ? 'CASH' : 'ONLINE';
    const prefix = paymentMethod === 'ONLINE' ? 'G' : 'B';
    const token = `${prefix}${String(globalSeq).padStart(2, '0')}`;

    const itemCount = randInt(1, 5);
    const chosen = [];
    for (let i = 0; i < itemCount; i++) chosen.push(pick(foods));

    let subtotal = 0;
    const items = chosen.map((f) => {
      const qty = randInt(1, 3);
      const lineTotal = +(f.price * qty).toFixed(2);
      subtotal += lineTotal;
      return { food_id: f.id, name: f.name, price: f.price, quantity: qty, total: lineTotal };
    });
    subtotal = +subtotal.toFixed(2);
    const taxAmount = +(subtotal * TAX_PERCENT / 100).toFixed(2);
    const discount = Math.random() < 0.1 ? +(subtotal * 0.05).toFixed(2) : 0;
    const total = +(subtotal + taxAmount - discount).toFixed(2);
    const isCancelled = Math.random() < 0.04;

    const result = insertBill.run({
      bill_number: billNumber,
      token,
      payment_method: paymentMethod,
      customer_name: pick(customerNames),
      subtotal,
      tax_percent: TAX_PERCENT,
      tax_amount: taxAmount,
      discount,
      total,
      status: isCancelled ? 'CANCELLED' : 'COMPLETED',
      cancel_reason: isCancelled ? 'Customer changed mind' : null,
      created_at: createdAtStr,
    });
    const billId = result.lastInsertRowid;
    items.forEach((it) => insertItem.run({ bill_id: billId, ...it }));
    totalBillsInserted++;
  }
});

for (let daysAgo = 364; daysAgo >= 0; daysAgo--) {
  const d = new Date(today);
  d.setDate(d.getDate() - daysAgo);
  const dow = d.getDay(); // 0 = Sun, 6 = Sat
  const isWeekend = dow === 0 || dow === 6;
  const billsToday = isWeekend ? randInt(15, 35) : randInt(5, 22);
  seedDay(d, billsToday);
}

console.log(`Done. Inserted ${totalBillsInserted} bills across 365 days.`);
db.close();
