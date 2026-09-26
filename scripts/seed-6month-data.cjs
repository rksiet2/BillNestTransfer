// Dev/test utility: seeds ~12 months of realistic random business data (6
// months in the past through 6 months in the future) directly into the LIVE
// app database used by the running Electron/browser app — so Reporting,
// Sales Trend, Top Items, and Profit & Loss all have meaningful data to
// validate against, and the app can be restarted to check load performance
// with a realistic data volume.
//
// Seeds:
//   - FOOD bills (dine-in orders) with random items/qty/payment method
//   - ROOM bookings + linked bills (checked-out ones only, source=ROOM)
//   - Raw-material purchase_orders (stock-in) for the Purchases side of P&L
//   - General business `expenses` (salary/rent/utilities/etc.)
//
// Safe to re-run: every row it creates is tagged with a 'SEED' marker in its
// number/notes so it can be identified and wiped later without touching real
// data (see scripts/wipe-seed-data.cjs).
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'billnest', 'data', 'hotel_billing.db');
console.log('Seeding LIVE app DB at', dbPath);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDateTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const foods = db.prepare('SELECT id, name, price FROM food_items').all();
const rooms = db.prepare('SELECT id, room_number, room_type, base_price FROM rooms').all();
const rawMaterials = db.prepare('SELECT id, name, cost_per_unit FROM raw_materials').all();

if (foods.length === 0) {
  console.error('No food items found - launch the app once first so defaults get seeded.');
  process.exit(1);
}

const insertBill = db.prepare(`
  INSERT INTO bills (bill_number, token, payment_method, customer_name, subtotal, tax_percent, tax_amount, discount, total, status, cancel_reason, created_at, source)
  VALUES (@bill_number, @token, @payment_method, @customer_name, @subtotal, @tax_percent, @tax_amount, @discount, @total, @status, @cancel_reason, @created_at, @source)
`);
const insertItem = db.prepare(`
  INSERT INTO bill_items (bill_id, food_id, name, price, quantity, total)
  VALUES (@bill_id, @food_id, @name, @price, @quantity, @total)
`);
const insertBooking = db.prepare(`
  INSERT INTO room_bookings (booking_number, room_id, guest_name, guest_phone, num_guests, check_in_date, check_out_date, actual_check_in, actual_check_out, room_rate, tourist_tax, discount, tax_percent, payment_method, status, bill_id, created_at)
  VALUES (@booking_number, @room_id, @guest_name, @guest_phone, @num_guests, @check_in_date, @check_out_date, @actual_check_in, @actual_check_out, @room_rate, @tourist_tax, @discount, @tax_percent, @payment_method, @status, @bill_id, @created_at)
`);
const insertPurchase = db.prepare(`
  INSERT INTO purchase_orders (raw_material_id, quantity, cost_per_unit, total_cost, supplier, notes, created_at)
  VALUES (@raw_material_id, @quantity, @cost_per_unit, @total_cost, @supplier, @notes, @created_at)
`);
const insertExpense = db.prepare(`
  INSERT INTO expenses (category, paid_to, amount, payment_method, notes, created_at)
  VALUES (@category, @paid_to, @amount, @payment_method, @notes, @created_at)
`);

const customerNames = ['Walk-in', 'Ravi Kumar', 'Anita Sharma', 'Vikram Singh', 'Priya Patel', 'Suresh Rao', 'Meena Iyer', null, null];
const guestNames = ['Rahul Mehta', 'Sneha Kulkarni', 'Arjun Nair', 'Kavya Reddy', 'Farhan Ali', 'Divya Menon', 'Karan Bose', 'Isha Malhotra'];
const suppliers = ['Fresh Farms Supplier', 'City Wholesale Mart', 'Green Valley Produce', 'Metro Grocers'];
const expenseDefs = [
  { category: 'SALARY', paid_to: 'Staff Payroll', amount: () => randInt(35000, 55000) },
  { category: 'RENT', paid_to: 'Property Owner', amount: () => randInt(20000, 30000) },
  { category: 'UTILITIES', paid_to: 'Electricity Board', amount: () => randInt(4000, 9000) },
  { category: 'MAINTENANCE', paid_to: 'Maintenance Contractor', amount: () => randInt(1500, 6000) },
];

const TAX_PERCENT = 5;
const today = new Date();
today.setHours(12, 0, 0, 0);

let seq = Number(process.env.SEED_SEQ_START || 900000); // high range, won't collide with real invoice numbers
let billsInserted = 0;
let bookingsInserted = 0;
let purchasesInserted = 0;
let expensesInserted = 0;

const START_DAYS_AGO = 180;
const END_DAYS_AHEAD = 180;

function makeFoodBill(dateObj) {
  const hour = randInt(10, 22);
  const minute = randInt(0, 59);
  const second = randInt(0, 59);
  const createdAt = new Date(dateObj);
  createdAt.setHours(hour, minute, second, 0);
  const createdAtStr = fmtDateTime(createdAt);

  seq++;
  const billNumber = `SEED6M-F-${seq}`;
  const paymentMethod = Math.random() < 0.55 ? 'CASH' : 'ONLINE';
  const token = `${paymentMethod === 'ONLINE' ? 'G' : 'B'}${String(seq).slice(-3)}`;

  const itemCount = randInt(1, 5);
  const chosen = Array.from({ length: itemCount }, () => pick(foods));
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
    source: 'FOOD',
  });
  const billId = result.lastInsertRowid;
  items.forEach((it) => insertItem.run({ bill_id: billId, ...it }));
  billsInserted++;
}

// Room bookings: only past/today check-outs get a linked bill (source=ROOM,
// counted in revenue) — future-dated ones are left as 'BOOKED' (upcoming
// reservations, no revenue yet), matching real-world behaviour.
function makeRoomBooking(checkInDate) {
  if (rooms.length === 0) return;
  const nights = randInt(1, 4);
  const checkOutDate = new Date(checkInDate);
  checkOutDate.setDate(checkOutDate.getDate() + nights);

  const room = pick(rooms);
  const guestName = pick(guestNames);
  const roomRate = room.base_price;
  const touristTax = randInt(0, 100);
  const subtotal = roomRate * nights;
  const discount = Math.random() < 0.08 ? +(subtotal * 0.05).toFixed(2) : 0;
  const taxAmount = +((subtotal - discount) * TAX_PERCENT / 100).toFixed(2);
  const total = +(subtotal - discount + taxAmount + touristTax).toFixed(2);
  const paymentMethod = Math.random() < 0.5 ? 'CASH' : 'ONLINE';

  const isFuture = checkOutDate.getTime() > today.getTime();
  seq++;
  const bookingNumber = `SEED6M-BK-${seq}`;

  let billId = null;
  if (!isFuture) {
    const billNumber = `SEED6M-R-${seq}`;
    const token = `${paymentMethod === 'ONLINE' ? 'G' : 'B'}${String(seq).slice(-3)}`;
    const result = insertBill.run({
      bill_number: billNumber,
      token,
      payment_method: paymentMethod,
      customer_name: guestName,
      subtotal,
      tax_percent: TAX_PERCENT,
      tax_amount: taxAmount,
      discount,
      total,
      status: 'COMPLETED',
      cancel_reason: null,
      created_at: fmtDateTime(checkOutDate),
      source: 'ROOM',
    });
    billId = result.lastInsertRowid;
    insertItem.run({
      bill_id: billId,
      food_id: null,
      name: `Room ${room.room_number} (${room.room_type}) x ${nights} night${nights > 1 ? 's' : ''}`,
      price: roomRate,
      quantity: nights,
      total: subtotal,
    });
    billsInserted++;
  }

  insertBooking.run({
    booking_number: bookingNumber,
    room_id: room.id,
    guest_name: guestName,
    guest_phone: `9${randInt(100000000, 999999999)}`,
    num_guests: randInt(1, 3),
    check_in_date: fmtDate(checkInDate),
    check_out_date: fmtDate(checkOutDate),
    actual_check_in: isFuture ? null : fmtDateTime(checkInDate),
    actual_check_out: isFuture ? null : fmtDateTime(checkOutDate),
    room_rate: roomRate,
    tourist_tax: touristTax,
    discount,
    tax_percent: TAX_PERCENT,
    payment_method: isFuture ? null : paymentMethod,
    status: isFuture ? 'BOOKED' : 'CHECKED_OUT',
    bill_id: billId,
    created_at: fmtDateTime(checkInDate),
  });
  bookingsInserted++;
}

function makeMonthlyExpensesAndPurchases(monthDate) {
  // Fixed monthly overheads
  for (const def of expenseDefs) {
    insertExpense.run({
      category: def.category,
      paid_to: def.paid_to,
      amount: def.amount(),
      payment_method: Math.random() < 0.7 ? 'ONLINE' : 'CASH',
      notes: 'SEED6M monthly overhead',
      created_at: fmtDateTime(monthDate),
    });
    expensesInserted++;
  }
  // A few raw-material stock purchases through the month
  if (rawMaterials.length > 0) {
    const purchaseCount = randInt(3, 6);
    for (let i = 0; i < purchaseCount; i++) {
      const mat = pick(rawMaterials);
      const qty = randInt(5, 50);
      const costPerUnit = mat.cost_per_unit || randInt(20, 200);
      const purchaseDate = new Date(monthDate);
      purchaseDate.setDate(randInt(1, 27));
      insertPurchase.run({
        raw_material_id: mat.id,
        quantity: qty,
        cost_per_unit: costPerUnit,
        total_cost: +(qty * costPerUnit).toFixed(2),
        supplier: pick(suppliers),
        notes: 'SEED6M stock purchase',
        created_at: fmtDateTime(purchaseDate),
      });
      purchasesInserted++;
    }
  }
}

const runAll = db.transaction(() => {
  // Daily FOOD bills + occasional room bookings, from -180 days to +180 days
  for (let offset = -START_DAYS_AGO; offset <= END_DAYS_AHEAD; offset++) {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    const dow = d.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isFuture = offset > 0;

    // Fewer bills seeded for future dates (upcoming/expected, not yet happened
    // in reality) so today still reads as the natural "most data so far" point.
    const billsToday = isFuture
      ? randInt(2, isWeekend ? 10 : 6)
      : (isWeekend ? randInt(15, 35) : randInt(5, 22));
    for (let b = 0; b < billsToday; b++) makeFoodBill(d);

    // ~1 in 4 days, start a room booking checking in that day
    if (Math.random() < 0.25) makeRoomBooking(d);
  }

  // Monthly overhead expenses + purchases, from -6 months to +6 months
  for (let m = -6; m <= 6; m++) {
    const monthDate = new Date(today.getFullYear(), today.getMonth() + m, 1);
    makeMonthlyExpensesAndPurchases(monthDate);
  }
});

runAll();

console.log(`Done.`);
console.log(`  FOOD+ROOM bills inserted: ${billsInserted}`);
console.log(`  Room bookings inserted:   ${bookingsInserted}`);
console.log(`  Purchase orders inserted: ${purchasesInserted}`);
console.log(`  Expenses inserted:        ${expensesInserted}`);
db.close();
