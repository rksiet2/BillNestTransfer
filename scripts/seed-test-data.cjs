// Wipes all TRANSACTIONAL data (bills, room bookings, expenses, purchases,
// stock ledger) from the LIVE app database and reseeds ~1 year of realistic
// historical activity plus a batch of future/upcoming room bookings, so every
// report/dashboard/perspective (Today/Week/Month/Year, P&L, Room Status,
// Sales History) has real-looking data to test against.
//
// Master/config data is left untouched on purpose: Food Menu, Categories,
// Rooms, Raw Materials, Settings (hotel name/address/tax/UPI) and Staff
// logins all stay exactly as configured — only the day-to-day transactional
// records are wiped and replaced.
//
// Usage: node scripts/seed-test-data.cjs
const path = require('path');
const os = require('os');
const fs = require('fs');
const { initDatabase, getDb, getBillRecordsDir, getKotRecordsDir } = require('../db/database.cjs');

const USER_DATA_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'billnest');
if (!fs.existsSync(USER_DATA_DIR)) {
  console.error(`Could not find the live app data folder at ${USER_DATA_DIR}. Aborting — nothing was changed.`);
  process.exit(1);
}

initDatabase(USER_DATA_DIR);
const db = getDb();

const HIST_DAYS = 365; // seed [today-365 .. today-1]
const FUTURE_DAYS = 150; // seed future bookings within [today+1 .. today+150]
const FUTURE_BOOKING_TARGET = 156;

const today = new Date();
today.setHours(0, 0, 0, 0);

// ---------------- small helpers ----------------
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function choice(arr) {
  return arr[randInt(0, arr.length - 1)];
}
function chance(p) {
  return Math.random() < p;
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}
function dateOnly(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dateCompact(d) {
  return dateOnly(d).replace(/-/g, '');
}
function dateTimeStr(d, hour, minute) {
  const withTime = new Date(d);
  if (hour != null) withTime.setHours(hour, minute != null ? minute : randInt(0, 59), randInt(0, 59), 0);
  return `${dateOnly(withTime)} ${pad(withTime.getHours())}:${pad(withTime.getMinutes())}:${pad(withTime.getSeconds())}`;
}
// Matches the <input type="datetime-local"> value format the real booking
// form submits ("YYYY-MM-DDTHH:mm") — check_in_date/check_out_date must be
// stored this way (not a bare date) or formatDate() on the frontend parses
// them as UTC midnight and displays a bogus shifted time (e.g. 05:30 am for
// IST) instead of the intended check-in/check-out hour.
function dateTimeLocalStr(d, hour, minute) {
  const withTime = new Date(d);
  withTime.setHours(hour, minute, 0, 0);
  return `${dateOnly(withTime)}T${pad(withTime.getHours())}:${pad(withTime.getMinutes())}`;
}

// Local counters, seeded per fake calendar day (mirrors db/database.cjs's
// real nextToken/nextBillNumber/nextKotNumber/nextBookingNumber format, but
// driven by the SIMULATED date instead of the real "now" so historical
// numbers look right for the day they were "created" on).
const counters = new Map();
function nextCounter(key) {
  const v = (counters.get(key) || 0) + 1;
  counters.set(key, v);
  return v;
}
function nextToken(d, paymentMethod) {
  const prefix = paymentMethod === 'ONLINE' ? 'G' : 'B';
  const next = nextCounter(`token_${prefix}_${dateOnly(d)}`);
  const digits = next < 100 ? 2 : next < 1000 ? 3 : next < 10000 ? 4 : next < 100000 ? 5 : 6;
  return `${prefix}${String(next).padStart(digits, '0')}`;
}
function nextBillNumber(d) {
  const next = nextCounter(`bill_${dateCompact(d)}`);
  return `INV-${dateCompact(d)}-${String(next).padStart(4, '0')}`;
}
function nextKotNumber(d) {
  const next = nextCounter(`kot_${dateCompact(d)}`);
  return `KOT-${dateCompact(d)}-${String(next).padStart(4, '0')}`;
}
function nextBookingNumber(d) {
  const next = nextCounter(`booking_${dateCompact(d)}`);
  return `BKG-${dateCompact(d)}-${String(next).padStart(4, '0')}`;
}
function makeBookingGroupId() {
  return `BG${Date.now()}${Math.random().toString(36).slice(2, 8)}${randInt(1000, 9999)}`;
}

// ---------------- bill text file writers (mirrors db/service.cjs) ----------------
function center(text, width) {
  const pad2 = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(pad2) + text;
}
function padCols(cols, widths) {
  return cols.map((c, i) => String(c).padEnd(widths[i])).join('');
}
function writeBillFile(bill) {
  const dir = getBillRecordsDir();
  const filePath = path.join(dir, `${bill.billNumber}_${bill.token}.txt`);
  const lines = [];
  const width = 42;
  const line = (ch = '-') => ch.repeat(width);
  lines.push(center(bill.hotelName.toUpperCase(), width));
  if (bill.hotelAddress) lines.push(center(bill.hotelAddress, width));
  if (bill.hotelPhone) lines.push(center(`Ph: ${bill.hotelPhone}`, width));
  if (bill.hotelGstin) lines.push(center(bill.hotelGstin, width));
  lines.push(center('TAX INVOICE', width));
  lines.push(line());
  lines.push(`Bill No : ${bill.billNumber}`);
  lines.push(`Token   : ${bill.token}  (${bill.paymentMethod})`);
  lines.push(`Date    : ${bill.createdAt}`);
  if (bill.customerName) lines.push(`Customer: ${bill.customerName}`);
  lines.push(line());
  lines.push(padCols(['Item', 'Qty', 'Price', 'Total'], [18, 5, 8, 9]));
  lines.push(line());
  for (const it of bill.items) {
    lines.push(padCols([it.name, String(it.quantity), it.price.toFixed(2), (it.price * it.quantity).toFixed(2)], [18, 5, 8, 9]));
  }
  lines.push(line());
  lines.push(padCols(['Subtotal', '', '', bill.subtotal.toFixed(2)], [18, 5, 8, 9]));
  lines.push(padCols([`Tax (${bill.taxPercent}%)`, '', '', bill.taxAmount.toFixed(2)], [18, 5, 8, 9]));
  if (bill.discount) lines.push(padCols(['Discount', '', '', ('-' + bill.discount.toFixed(2))], [18, 5, 8, 9]));
  lines.push(line());
  lines.push(padCols(['TOTAL', '', '', bill.total.toFixed(2)], [18, 5, 8, 9]));
  lines.push(line('='));
  lines.push(center(bill.billFooter || 'Thank you! Visit again.', width));
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}
function writeKotFile(bill) {
  const dir = getKotRecordsDir();
  const filePath = path.join(dir, `${bill.kotNumber}_${bill.token}.txt`);
  const width = 36;
  const line = (ch = '-') => ch.repeat(width);
  const lines = [];
  lines.push(center('KITCHEN ORDER TICKET', width));
  lines.push(center('(KOT)', width));
  lines.push(line());
  lines.push(`KOT No  : ${bill.kotNumber}`);
  lines.push(`Token   : ${bill.token}`);
  lines.push(`Date    : ${bill.createdAt}`);
  if (bill.customerName) lines.push(`Customer: ${bill.customerName}`);
  lines.push(line());
  lines.push(padCols(['Item', 'Qty'], [28, 8]));
  lines.push(line());
  for (const it of bill.items) {
    lines.push(padCols([it.name, String(it.quantity)], [28, 8]));
  }
  lines.push(line());
  lines.push(center('*** PREPARE FRESH & FAST ***', width));
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

// ---------------- wipe transactional data ----------------
console.log('Wiping existing transactional data (bills, bookings, expenses, purchases, stock ledger)...');
db.exec(`
  DELETE FROM booking_addons;
  DELETE FROM booking_contacts;
  DELETE FROM room_bookings;
  DELETE FROM bill_items;
  DELETE FROM bills;
  DELETE FROM expenses;
  DELETE FROM stock_movements;
  DELETE FROM purchase_orders;
  DELETE FROM counters;
  DELETE FROM sqlite_sequence WHERE name IN ('bills','bill_items','room_bookings','booking_addons','booking_contacts','expenses','stock_movements','purchase_orders');
`);

// Clear out old bill/KOT text files so "Bill Records"/"KOT Records" only
// contains the freshly-seeded set (avoids thousands of stale leftover files
// from whatever testing produced the previous 6 bills).
for (const dir of [getBillRecordsDir(), getKotRecordsDir()]) {
  for (const f of fs.readdirSync(dir)) {
    if (f.toLowerCase().endsWith('.txt')) fs.unlinkSync(path.join(dir, f));
  }
}

// ---------------- load master/config data ----------------
const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
const hotelName = settings.hotel_name || 'Hotel';
const taxPercent = parseFloat(settings.tax_percent || '5');
const foodItems = db.prepare('SELECT * FROM food_items WHERE available = 1').all();
const rooms = db.prepare("SELECT * FROM rooms WHERE status != 'MAINTENANCE'").all();
const rawMaterials = db.prepare('SELECT * FROM raw_materials').all();

if (!foodItems.length) console.warn('No available food items found — no food bills will be seeded.');
if (!rooms.length) console.warn('No active rooms found — no room bookings will be seeded.');

const GUEST_NAMES = [
  'Rahul Sharma', 'Priya Verma', 'Amit Singh', 'Sneha Gupta', 'Vikram Rao',
  'Anjali Nair', 'Rohit Mehta', 'Kavita Joshi', 'Arjun Reddy', 'Neha Kapoor',
  'Suresh Iyer', 'Pooja Malhotra', 'Karan Chopra', 'Divya Menon', 'Manoj Tiwari',
  'Ritu Bansal', 'Sanjay Pandey', 'Meera Pillai', 'Ajay Kulkarni', 'Shreya Desai',
  'Vivek Agarwal', 'Nisha Thakur', 'Deepak Yadav', 'Swati Bhatt', 'Naveen Rathi',
];
const CANCEL_REASONS = [
  'Customer changed mind', 'Ordered by mistake', 'Guest cancelled plans',
  'Duplicate order', 'Kitchen unable to prepare in time', 'Payment issue',
];
function randomPhone() {
  return '9' + String(randInt(100000000, 999999999));
}

// ---------------- helper to create one food (Cart) bill ----------------
function createFoodBill(d, hour, minute) {
  const itemCount = randInt(1, 5);
  const picked = [];
  const pool = [...foodItems];
  for (let i = 0; i < itemCount && pool.length; i++) {
    const idx = randInt(0, pool.length - 1);
    const fi = pool.splice(idx, 1)[0];
    picked.push({ id: fi.id, name: fi.name, price: fi.price, quantity: randInt(1, 4) });
  }
  const subtotal = +picked.reduce((s, it) => s + it.price * it.quantity, 0).toFixed(2);
  const discount = chance(0.15) ? +Math.min(subtotal * 0.1, randInt(20, 80)).toFixed(2) : 0;
  const taxAmount = +(subtotal * (taxPercent / 100)).toFixed(2);
  const total = +(subtotal + taxAmount - discount).toFixed(2);
  const paymentMethod = chance(0.55) ? 'CASH' : 'ONLINE';
  const cancelled = chance(0.05);
  const createdAtDate = new Date(d);
  createdAtDate.setHours(hour, minute, randInt(0, 59), 0);
  const createdAt = dateTimeStr(d, hour, minute);
  const customerName = chance(0.5) ? choice(GUEST_NAMES) : null;

  const token = nextToken(d, paymentMethod);
  const billNumber = nextBillNumber(d);
  const kotNumber = nextKotNumber(d);

  const info = db
    .prepare(
      `INSERT INTO bills (bill_number, token, payment_method, customer_name, subtotal, tax_percent, tax_amount, discount, total, status, cancel_reason, created_at, kot_number, order_note, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      billNumber, token, paymentMethod, customerName, subtotal, taxPercent, taxAmount, discount, total,
      cancelled ? 'CANCELLED' : 'COMPLETED', cancelled ? choice(CANCEL_REASONS) : null, createdAt, kotNumber, null, 'FOOD'
    );
  const billId = info.lastInsertRowid;
  const insertItem = db.prepare('INSERT INTO bill_items (bill_id, food_id, name, price, quantity, total) VALUES (?,?,?,?,?,?)');
  for (const it of picked) insertItem.run(billId, it.id, it.name, it.price, it.quantity, +(it.price * it.quantity).toFixed(2));

  const bill = {
    billNumber, token, kotNumber, paymentMethod, customerName, subtotal,
    taxPercent, taxAmount, discount, total, createdAt, items: picked,
    hotelName, hotelAddress: settings.hotel_address || '', hotelPhone: settings.hotel_phone || '',
    hotelGstin: settings.hotel_gstin || '', billFooter: settings.bill_footer || 'Thank you! Visit again.',
  };
  const filePath = writeBillFile(bill);
  const kotFilePath = writeKotFile(bill);
  db.prepare('UPDATE bills SET file_path = ?, kot_file_path = ? WHERE id = ?').run(filePath, kotFilePath, billId);
  return billId;
}

// ---------------- 1. seed food bills across the last 365 days ----------------
console.log(`Seeding food bills for the last ${HIST_DAYS} days...`);
let foodBillCount = 0;
if (foodItems.length) {
  for (let i = HIST_DAYS; i >= 1; i--) {
    const d = addDays(today, -i);
    const dow = d.getDay(); // 0=Sun..6=Sat
    const isWeekend = dow === 0 || dow === 5 || dow === 6;
    const count = randInt(isWeekend ? 14 : 8, isWeekend ? 24 : 16);
    for (let b = 0; b < count; b++) {
      createFoodBill(d, randInt(8, 23), randInt(0, 59));
      foodBillCount++;
    }
  }
}
console.log(`  -> ${foodBillCount} food bills created.`);

// ---------------- helper to check out a room booking (creates its bill) ----------------
function checkOutSeeded(booking, checkOutDate, checkOutHour) {
  const numNights = Math.max(1, Math.round((new Date(booking.checkOutDate) - new Date(booking.checkInDate)) / 86400000));
  const items = [
    { name: `Room ${booking.roomNumber} (${booking.roomType}) x ${numNights} night${numNights > 1 ? 's' : ''}`, price: booking.roomRate, quantity: numNights },
  ];
  if (booking.touristTax > 0) items.push({ name: 'Tourist Tax', price: booking.touristTax, quantity: 1 });
  const subtotal = +items.reduce((s, it) => s + it.price * it.quantity, 0).toFixed(2);
  const discountTotal = +((booking.discount || 0) + (booking.advancePayment || 0)).toFixed(2);
  const taxAmount = +(subtotal * ((booking.taxPercent || 0) / 100)).toFixed(2);
  const total = +(subtotal + taxAmount - discountTotal).toFixed(2);
  const createdAt = dateTimeStr(checkOutDate, checkOutHour, randInt(0, 59));

  const token = nextToken(checkOutDate, booking.paymentMethod);
  const billNumber = nextBillNumber(checkOutDate);
  const orderNoteParts = [`Room Booking ${booking.bookingNumber} - Room ${booking.roomNumber}`];
  if (booking.advancePayment > 0) orderNoteParts.push(`Less: Advance Payment Received Rs.${booking.advancePayment}`);

  const info = db
    .prepare(
      `INSERT INTO bills (bill_number, token, payment_method, customer_name, subtotal, tax_percent, tax_amount, discount, total, status, created_at, kot_number, order_note, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(billNumber, token, booking.paymentMethod, booking.guestName, subtotal, booking.taxPercent || 0, taxAmount, discountTotal, total, 'COMPLETED', createdAt, null, orderNoteParts.join(' | '), 'ROOM');
  const billId = info.lastInsertRowid;
  const insertItem = db.prepare('INSERT INTO bill_items (bill_id, food_id, name, price, quantity, total) VALUES (?,?,?,?,?,?)');
  for (const it of items) insertItem.run(billId, null, it.name, it.price, it.quantity, +(it.price * it.quantity).toFixed(2));

  const bill = {
    billNumber, token, paymentMethod: booking.paymentMethod, customerName: booking.guestName, subtotal,
    taxPercent: booking.taxPercent || 0, taxAmount, discount: discountTotal, total, createdAt, items,
    hotelName, hotelAddress: settings.hotel_address || '', hotelPhone: settings.hotel_phone || '',
    hotelGstin: settings.hotel_gstin || '', billFooter: settings.bill_footer || 'Thank you! Visit again.',
  };
  const filePath = writeBillFile(bill);
  db.prepare('UPDATE bills SET file_path = ? WHERE id = ?').run(filePath, billId);
  return billId;
}

// ---------------- 2. seed historical room bookings (mostly checked out) ----------------
console.log('Seeding historical room bookings...');
let histBookingCount = 0;
const histRangeStart = addDays(today, -HIST_DAYS);
for (const room of rooms) {
  let cursor = new Date(histRangeStart);
  while (true) {
    cursor = addDays(cursor, randInt(0, 4)); // vacancy gap
    const lengthNights = randInt(1, 6);
    const checkOutCursor = addDays(cursor, lengthNights);
    if (checkOutCursor >= today) break; // stop once we'd run into "today" or beyond

    const checkInDate = dateTimeLocalStr(cursor, 14, 0);
    const checkOutDate = dateTimeLocalStr(checkOutCursor, 11, 0);
    const guestName = choice(GUEST_NAMES);
    const guestPhone = randomPhone();
    const paymentMethod = chance(0.55) ? 'CASH' : 'ONLINE';
    const roomRate = room.base_price;
    const touristTax = chance(0.3) ? randInt(50, 150) : 0;
    const discount = chance(0.1) ? randInt(50, 300) : 0;
    const advancePayment = chance(0.2) ? randInt(500, Math.round(roomRate * lengthNights * 0.3)) : 0;
    const cancelled = chance(0.05);
    const groupId = makeBookingGroupId();
    const bookingNumber = nextBookingNumber(cursor);

    const info = db
      .prepare(
        `INSERT INTO room_bookings
         (booking_number, room_id, booking_group_id, guest_name, guest_phone, num_guests, check_in_date, check_out_date,
          actual_check_in, actual_check_out, room_rate, tourist_tax, discount, tax_percent, payment_method, advance_payment, status, cancel_reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        bookingNumber, room.id, groupId, guestName, guestPhone, randInt(1, Math.max(1, room.max_occupancy)),
        checkInDate, checkOutDate,
        cancelled ? null : dateTimeStr(cursor, randInt(12, 14), randInt(0, 59)),
        cancelled ? null : dateTimeStr(checkOutCursor, randInt(10, 12), randInt(0, 59)),
        roomRate, touristTax, discount, taxPercent, paymentMethod, advancePayment,
        cancelled ? 'CANCELLED' : 'CHECKED_OUT',
        cancelled ? choice(CANCEL_REASONS) : null,
        dateTimeStr(cursor, randInt(8, 11), randInt(0, 59))
      );
    const bookingId = info.lastInsertRowid;
    db.prepare('INSERT INTO booking_contacts (booking_group_id, name, phone) VALUES (?,?,?)').run(groupId, guestName, guestPhone);

    if (!cancelled) {
      const billId = checkOutSeeded(
        { bookingNumber, roomNumber: room.room_number, roomType: room.room_type, guestName, roomRate, touristTax, discount, taxPercent, paymentMethod, advancePayment, checkInDate, checkOutDate },
        checkOutCursor,
        randInt(10, 12)
      );
      db.prepare('UPDATE room_bookings SET bill_id = ? WHERE id = ?').run(billId, bookingId);
    }
    histBookingCount++;
    cursor = new Date(checkOutCursor);
  }
}
console.log(`  -> ${histBookingCount} historical room bookings created.`);

// ---------------- 3. seed future/upcoming bookings (status BOOKED) ----------------
console.log(`Seeding up to ${FUTURE_BOOKING_TARGET} future bookings over the next ${FUTURE_DAYS} days...`);
let futureBookingCount = 0;
if (rooms.length) {
  const futureEnd = addDays(today, FUTURE_DAYS);
  const roomCursors = rooms.map(() => addDays(today, randInt(1, 3)));
  let anyRoomHasRoom = true;
  while (futureBookingCount < FUTURE_BOOKING_TARGET && anyRoomHasRoom) {
    anyRoomHasRoom = false;
    for (let ri = 0; ri < rooms.length && futureBookingCount < FUTURE_BOOKING_TARGET; ri++) {
      const room = rooms[ri];
      let cursor = roomCursors[ri];
      cursor = addDays(cursor, randInt(0, 2));
      const lengthNights = randInt(1, 4);
      const checkOutCursor = addDays(cursor, lengthNights);
      if (checkOutCursor > futureEnd) continue; // this room is out of room in the window
      anyRoomHasRoom = true;

      const checkInDate = dateTimeLocalStr(cursor, 14, 0);
      const checkOutDate = dateTimeLocalStr(checkOutCursor, 11, 0);
      const guestName = choice(GUEST_NAMES);
      const guestPhone = randomPhone();
      const paymentMethod = chance(0.6) ? 'CASH' : 'ONLINE';
      const roomRate = room.base_price;
      const touristTax = chance(0.3) ? randInt(50, 150) : 0;
      const discount = chance(0.1) ? randInt(50, 300) : 0;
      const advancePayment = chance(0.3) ? randInt(500, Math.round(roomRate * lengthNights * 0.3)) : 0;
      const groupId = makeBookingGroupId();
      const bookingNumber = nextBookingNumber(cursor);

      db.prepare(
        `INSERT INTO room_bookings
         (booking_number, room_id, booking_group_id, guest_name, guest_phone, num_guests, check_in_date, check_out_date,
          room_rate, tourist_tax, discount, tax_percent, payment_method, advance_payment, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'BOOKED',?)`
      ).run(
        bookingNumber, room.id, groupId, guestName, guestPhone, randInt(1, Math.max(1, room.max_occupancy)),
        checkInDate, checkOutDate, roomRate, touristTax, discount, taxPercent, paymentMethod, advancePayment,
        dateTimeStr(today, randInt(9, 20), randInt(0, 59))
      );
      db.prepare('INSERT INTO booking_contacts (booking_group_id, name, phone) VALUES (?,?,?)').run(groupId, guestName, guestPhone);

      roomCursors[ri] = new Date(checkOutCursor);
      futureBookingCount++;
    }
  }
}
console.log(`  -> ${futureBookingCount} future bookings created.`);

// ---------------- 4. seed expenses across the year ----------------
console.log('Seeding expenses...');
let expenseCount = 0;
for (let m = 0; m < 12; m++) {
  const monthStart = addDays(today, -HIST_DAYS + m * 30);
  if (monthStart >= today) break;
  const insertExpense = (category, paidTo, amount, method, notes, dayOffset) => {
    const d = addDays(monthStart, dayOffset);
    if (d >= today) return;
    db.prepare('INSERT INTO expenses (category, paid_to, amount, payment_method, notes, created_at) VALUES (?,?,?,?,?,?)').run(
      category, paidTo, amount, method, notes, dateTimeStr(d, randInt(9, 18), randInt(0, 59))
    );
    expenseCount++;
  };
  insertExpense('RENT', 'Property Owner', randInt(15000, 25000), chance(0.5) ? 'CASH' : 'ONLINE', 'Monthly rent', randInt(1, 5));
  insertExpense('SALARY', 'Kitchen Staff', randInt(8000, 20000), 'CASH', 'Monthly salary', randInt(1, 7));
  insertExpense('SALARY', 'Front Desk Staff', randInt(8000, 18000), 'CASH', 'Monthly salary', randInt(1, 7));
  insertExpense('UTILITIES', 'Electricity Board', randInt(1500, 6000), chance(0.5) ? 'CASH' : 'ONLINE', 'Electricity bill', randInt(8, 15));
  insertExpense('UTILITIES', 'Water Supply', randInt(300, 1200), 'CASH', 'Water bill', randInt(8, 15));
  if (chance(0.6)) insertExpense('MAINTENANCE', 'Local Repair Service', randInt(500, 5000), 'CASH', 'Repairs & maintenance', randInt(10, 25));
  if (chance(0.4)) insertExpense('OTHER', 'Misc Vendor', randInt(200, 3000), chance(0.5) ? 'CASH' : 'ONLINE', 'Miscellaneous', randInt(5, 28));
}
console.log(`  -> ${expenseCount} expenses created.`);

// ---------------- 5. seed raw material purchases across the year ----------------
console.log('Seeding raw material purchases...');
let purchaseCount = 0;
for (const rm of rawMaterials) {
  // A purchase roughly every 3-4 weeks for each raw material across the year.
  let cursor = addDays(today, -HIST_DAYS + randInt(0, 10));
  while (cursor < today) {
    const quantity = +(rm.unit === 'pcs' ? randInt(50, 300) : randInt(5, 40)).toFixed(2);
    const costVariance = rm.cost_per_unit * (0.9 + Math.random() * 0.2);
    const costPerUnit = +costVariance.toFixed(2);
    const totalCost = +(quantity * costPerUnit).toFixed(2);
    const createdAt = dateTimeStr(cursor, randInt(9, 17), randInt(0, 59));
    const info = db
      .prepare('INSERT INTO purchase_orders (raw_material_id, quantity, cost_per_unit, total_cost, supplier, notes, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(rm.id, quantity, costPerUnit, totalCost, 'Local Supplier', null, createdAt);
    db.prepare('INSERT INTO stock_movements (raw_material_id, change_qty, type, reference_id, notes, created_at) VALUES (?,?,?,?,?,?)').run(
      rm.id, quantity, 'PURCHASE', info.lastInsertRowid, 'Seeded historical purchase', createdAt
    );
    purchaseCount++;
    cursor = addDays(cursor, randInt(18, 28));
  }
}
console.log(`  -> ${purchaseCount} purchase orders created.`);

// ---------------- persist final counter values so the running app continues cleanly ----------------
const insertCounter = db.prepare('INSERT INTO counters (key, value) VALUES (?, ?)');
for (const [key, value] of counters.entries()) insertCounter.run(key, value);

console.log('\nDone. Summary:');
console.log(`  Food bills:            ${foodBillCount}`);
console.log(`  Historical bookings:   ${histBookingCount}`);
console.log(`  Future bookings:       ${futureBookingCount}`);
console.log(`  Expenses:              ${expenseCount}`);
console.log(`  Purchase orders:       ${purchaseCount}`);
console.log('Master data (menu, categories, rooms, raw materials, settings, staff logins) left untouched.');
