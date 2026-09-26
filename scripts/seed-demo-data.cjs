// Wipes all transactional data from the live app database and seeds a fresh,
// curated demo dataset that:
//   1. Shows every invoice format correctly (single room, group, food bill).
//   2. Exercises every recently-fixed bug scenario so you can validate them
//      visually in the running app:
//        • Same-day turnover (checkout date == next guest's checkin date)
//        • Multi-room group where ALL rooms are CHECKED_OUT → Combined Invoice button shows
//        • Advance payment on a booking → advance/balance visible on invoice
//        • 14:00→11:00 next-day stay → bills 1 night (21 hours = 1 calendar night)
//        • 09:00→22:00 next-day stay → bills 1 night (37 hours, NOT 2 nights)
//        • Oversized discount → ₹0 bill, never negative
//        • Guest with Aadhaar ID number populated → shows on invoice
//        • Guest with no ID number → ID row omitted from invoice
//   3. Leaves master data untouched: Food Menu, Categories, Rooms, Raw
//      Materials, Settings (hotel name/address/GSTIN/UPI/logo) and Staff logins
//      are all exactly as configured by the owner — only the day-to-day
//      transactional records are wiped and replaced.
//
// Usage: node scripts/seed-demo-data.cjs
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { initDatabase, getDb, getBillRecordsDir, getKotRecordsDir } = require('../db/database.cjs');

const USER_DATA_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'hotel-billing-software');
if (!fs.existsSync(USER_DATA_DIR)) {
  console.error(`App data folder not found at ${USER_DATA_DIR}. Launch the app once first to create it.`);
  process.exit(1);
}

// initDatabase runs all pending ALTER TABLE migrations before we do anything,
// so the schema is fully up-to-date (booking_group_id, advance_payment,
// advance_applied, biz_* snapshot columns, etc.) regardless of when the DB
// was first created.
initDatabase(USER_DATA_DIR);
const db = getDb();

// ──────────────────────────────────────────────────────────────────────────────
// 0. Wipe all transactional tables
// ──────────────────────────────────────────────────────────────────────────────
console.log('Wiping existing transactional data...');
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
  DELETE FROM sqlite_sequence
    WHERE name IN ('bills','bill_items','room_bookings','booking_addons',
                   'booking_contacts','expenses','stock_movements','purchase_orders');
`);

// Clear bill/KOT text files so "Bill Records" and "KOT Records" only show
// the freshly-seeded set.
for (const dir of [getBillRecordsDir(), getKotRecordsDir()]) {
  for (const f of fs.readdirSync(dir)) {
    if (f.toLowerCase().endsWith('.txt')) fs.unlinkSync(path.join(dir, f));
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Load master/config data (read-only — we never modify these)
// ──────────────────────────────────────────────────────────────────────────────
const settings = Object.fromEntries(
  db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value])
);
const hotelName = settings.hotel_name || 'Hotel';
const roomBizName = settings.room_biz_name || hotelName;
const taxPercent = parseFloat(settings.tax_percent || '5');
const foodItems = db.prepare('SELECT * FROM food_items WHERE available = 1').all();
const rooms = db.prepare("SELECT * FROM rooms WHERE status != 'MAINTENANCE' ORDER BY room_number").all();

if (!foodItems.length) { console.warn('No food items — run the app once to seed them.'); }
if (!rooms.length) { console.warn('No rooms found — check rooms master data.'); }

// ──────────────────────────────────────────────────────────────────────────────
// 2. Helpers
// ──────────────────────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function dateOnly(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function dt(d, h, m) {
  // Returns a "YYYY-MM-DDTHH:mm" string (datetime-local format the app uses).
  const nd = new Date(d); nd.setHours(h, m, 0, 0);
  return `${dateOnly(nd)}T${pad(nd.getHours())}:${pad(nd.getMinutes())}`;
}
function sqlNow() {
  const now = new Date();
  return `${dateOnly(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function roomById(id) { return rooms.find((r) => r.id === id); }
function roomByNumber(num) { return rooms.find((r) => r.room_number === num); }
function choice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Today and key anchor dates for the demo
const today = new Date(); today.setHours(0, 0, 0, 0);
const yesterday = addDays(today, -1);
const twoDaysAgo = addDays(today, -2);
const threeDaysAgo = addDays(today, -3);
const fourDaysAgo = addDays(today, -4);
const tomorrow = addDays(today, 1);
const twoDaysLater = addDays(today, 2);
const threeDaysLater = addDays(today, 3);
const fourDaysLater = addDays(today, 4);
const fiveDaysLater = addDays(today, 5);
const sixDaysLater = addDays(today, 6);

// Seeded bill/booking number counters (date-scoped, mirrors db/database.cjs format)
const countersMap = new Map();
function nextSeq(key) {
  const v = (countersMap.get(key) || 0) + 1; countersMap.set(key, v); return v;
}
function nextBillNum(d) {
  const dk = dateOnly(d).replace(/-/g, '');
  return `INV-${dk}-${pad(nextSeq(`bill_${dk}`))}`;
}
function nextBkgNum(d) {
  const dk = dateOnly(d).replace(/-/g, '');
  return `BKG-${dk}-${pad(nextSeq(`bkg_${dk}`))}`;
}
let _tokenSeq = 0;
function nextToken(pm) {
  _tokenSeq++;
  return `${pm === 'ONLINE' ? 'G' : 'B'}${pad(_tokenSeq)}`;
}
let _groupSeq = 0;
function newGroupId() {
  _groupSeq++;
  return `BG${Date.now()}${_groupSeq}demo`;
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. Insert helpers
// ──────────────────────────────────────────────────────────────────────────────
const insBill = db.prepare(`
  INSERT INTO bills
    (bill_number, token, payment_method, customer_name, subtotal, tax_percent, tax_amount,
     discount, advance_payment, balance_due, total, status, cancel_reason, created_at,
     order_note, source, biz_name, biz_address, biz_phone, biz_gstin, biz_footer, biz_upi_id, booking_number)
  VALUES
    (@bn, @tok, @pm, @cust, @sub, @txp, @txa, @disc, @adv, @bal, @tot, @st, @cr, @at,
     @note, @src, @bizName, @bizAddr, @bizPhone, @bizGstin, @bizFooter, @bizUpi, @bkgNum)
`);

const insItem = db.prepare(`
  INSERT INTO bill_items (bill_id, food_id, name, price, quantity, total)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insBkg = db.prepare(`
  INSERT INTO room_bookings
    (booking_number, room_id, booking_group_id, guest_name, guest_phone,
     guest_id_type, guest_id_number, num_guests, check_in_date, check_out_date,
     actual_check_in, actual_check_out, room_rate, tourist_tax, discount,
     tax_percent, payment_method, advance_payment, advance_applied, status,
     cancel_reason, bill_id, notes, created_at)
  VALUES
    (@bkgNum, @roomId, @grpId, @guest, @phone,
     @idType, @idNum, @numGuests, @cin, @cout,
     @acin, @acout, @rate, @ttax, @disc,
     @txp, @pm, @adv, @advApplied, @status,
     @cr, @billId, @notes, @createdAt)
`);

const insContact = db.prepare(`
  INSERT INTO booking_contacts (booking_group_id, name, phone, email, special_request)
  VALUES (?, ?, ?, ?, ?)
`);

// Biz identity snapshots
const foodBiz = {
  bizName: hotelName,
  bizAddr: settings.hotel_address || '',
  bizPhone: settings.hotel_phone || '',
  bizGstin: settings.hotel_gstin || '',
  bizFooter: settings.bill_footer || 'Thank you! Visit again.',
  bizUpi: settings.upi_id || '',
};
const roomBiz = {
  bizName: roomBizName,
  bizAddr: settings.room_biz_address || settings.hotel_address || '',
  bizPhone: settings.room_biz_phone || settings.hotel_phone || '',
  bizGstin: settings.room_biz_gstin || settings.hotel_gstin || '',
  bizFooter: settings.room_bill_footer || settings.bill_footer || 'Thank you! Visit again.',
  bizUpi: settings.room_upi_id || settings.upi_id || '',
};

// Create a room bill (checkout bill) and return its bill id
function createRoomBill({
  date, pm, guest, bkgNum, roomNum, roomType, nights, rate, touristTax = 0,
  discount = 0, advance = 0, txp = 0, note = '',
}) {
  const sub = +(rate * nights + touristTax).toFixed(2);
  const txa = +(sub * txp / 100).toFixed(2);
  const tot = Math.max(0, +(sub + txa - discount).toFixed(2));
  const bal = Math.max(0, +(tot - advance).toFixed(2));
  const bn = nextBillNum(date);
  const tok = nextToken(pm);
  const createdAt = `${dateOnly(date)} ${pad(11)}:00:00`;
  const result = insBill.run({
    bn, tok, pm, cust: guest, sub, txp, txa,
    disc: discount, adv: advance, bal, tot,
    st: 'COMPLETED', cr: null,
    at: createdAt,
    note: note || `Room Booking ${bkgNum} - Room ${roomNum}${advance > 0 ? ` | Less: Advance Payment Received ₹${advance}` : ''}`,
    src: 'ROOM',
    ...roomBiz,
    bkgNum,
  });
  const billId = result.lastInsertRowid;
  // Room charge line item
  insItem.run(billId, null, `Room ${roomNum} (${roomType}) x ${nights} night${nights > 1 ? 's' : ''}`, rate, nights, +(rate * nights).toFixed(2));
  if (touristTax > 0) insItem.run(billId, null, 'Tourist Tax', touristTax, 1, touristTax);
  return billId;
}

// Create a food bill and return its bill id
function createFoodBill({ date, pm, guest, items, txp, discount = 0 }) {
  const sub = +items.reduce((s, it) => s + it.price * it.qty, 0).toFixed(2);
  const txa = +(sub * txp / 100).toFixed(2);
  const tot = Math.max(0, +(sub + txa - discount).toFixed(2));
  const bn = nextBillNum(date);
  const tok = nextToken(pm);
  const createdAt = `${dateOnly(date)} ${pad(Math.floor(10 + Math.random() * 13))}:${pad(Math.floor(Math.random() * 60))}:00`;
  const result = insBill.run({
    bn, tok, pm, cust: guest || null, sub, txp, txa,
    disc: discount, adv: 0, bal: null, tot,
    st: 'COMPLETED', cr: null,
    at: createdAt,
    note: null, src: 'FOOD',
    ...foodBiz,
    bkgNum: null,
  });
  const billId = result.lastInsertRowid;
  for (const it of items) {
    insItem.run(billId, it.id || null, it.name, it.price, it.qty, +(it.price * it.qty).toFixed(2));
  }
  return billId;
}

// ──────────────────────────────────────────────────────────────────────────────
// 4. FOOD BILLS — recent sample bills across the last week
// ──────────────────────────────────────────────────────────────────────────────
console.log('\nSeeding food bills...');
let foodCount = 0;
if (foodItems.length) {
  const days = [twoDaysAgo, yesterday, today];
  const dayBillsCount = [6, 8, 4];
  const guests = ['Rahul Sharma', 'Walk-in', 'Priya Verma', 'Amit Singh', null, 'Sneha Gupta', 'Vikram Rao', null];

  days.forEach((d, di) => {
    const count = dayBillsCount[di];
    for (let b = 0; b < count; b++) {
      const itemCount = 1 + Math.floor(Math.random() * 4);
      const pool = [...foodItems].sort(() => Math.random() - 0.5).slice(0, itemCount);
      const items = pool.map((fi) => ({ id: fi.id, name: fi.name, price: fi.price, qty: 1 + Math.floor(Math.random() * 3) }));
      const pm = Math.random() < 0.55 ? 'CASH' : 'ONLINE';
      const discount = Math.random() < 0.1 ? Math.round(items[0].price * 0.05) : 0;
      createFoodBill({ date: d, pm, guest: choice(guests), items, txp: taxPercent, discount });
      foodCount++;
    }
  });

  // Scenario: cancelled food bill (order placed by mistake)
  const cancelBn = nextBillNum(yesterday);
  const cancelTok = nextToken('CASH');
  const fi0 = foodItems[0];
  const cancelResult = insBill.run({
    bn: cancelBn, tok: cancelTok, pm: 'CASH', cust: 'Arjun Reddy',
    sub: fi0.price, txp: taxPercent, txa: +(fi0.price * taxPercent / 100).toFixed(2),
    disc: 0, adv: 0, bal: null, tot: +(fi0.price * (1 + taxPercent / 100)).toFixed(2),
    st: 'CANCELLED', cr: 'Customer changed mind',
    at: `${dateOnly(yesterday)} 14:30:00`,
    note: null, src: 'FOOD', ...foodBiz, bkgNum: null,
  });
  insItem.run(cancelResult.lastInsertRowid, fi0.id, fi0.name, fi0.price, 1, fi0.price);
  foodCount++;
}
console.log(`  -> ${foodCount} food bills`);

// ──────────────────────────────────────────────────────────────────────────────
// 5. ROOM BOOKINGS — curated scenarios
// ──────────────────────────────────────────────────────────────────────────────
console.log('\nSeeding room bookings...');
let bookingCount = 0;
const room101 = roomByNumber('101');
const room102 = roomByNumber('102');
const room103 = roomByNumber('103');
const room201 = roomByNumber('201');
const room202 = roomByNumber('202');
const room301 = roomByNumber('301');

// ── 5A. CHECKED_OUT — standard single stay (2 nights) with Aadhaar ID, advance, discount ──
// Validates: ID row shows on invoice, advance/balance display, correct 2-night charge
if (room101) {
  const grp = newGroupId();
  const bkgNum = nextBkgNum(threeDaysAgo);
  const billId = createRoomBill({
    date: yesterday, pm: 'CASH', guest: 'Rahul Sharma', bkgNum,
    roomNum: room101.room_number, roomType: room101.room_type,
    nights: 2, rate: room101.base_price,
    discount: 200, advance: 500, txp: 0,
  });
  insBkg.run({
    bkgNum, roomId: room101.id, grpId: grp,
    guest: 'Rahul Sharma', phone: '9876543210',
    idType: 'Aadhaar Card', idNum: '1234 5678 9012',
    numGuests: 2,
    cin: dt(threeDaysAgo, 14, 0), cout: dt(yesterday, 11, 0),
    acin: `${dateOnly(threeDaysAgo)} 14:15:00`, acout: `${dateOnly(yesterday)} 11:05:00`,
    rate: room101.base_price, ttax: 0, disc: 200,
    txp: 0, pm: 'CASH', adv: 500, advApplied: 500,
    status: 'CHECKED_OUT', cr: null, billId,
    notes: 'Early checkout requested',
    createdAt: `${dateOnly(threeDaysAgo)} 10:30:00`,
  });
  insContact.run(grp, 'Rahul Sharma', '9876543210', null, null);
  bookingCount++;
}

// ── 5B. CHECKED_OUT — 21h stay (14:00 day1 → 11:00 day2) = 1 night calendar ──
// Validates: night-count fix — this MUST bill as exactly 1 night, not 0 or 2
if (room102) {
  const grp = newGroupId();
  const bkgNum = nextBkgNum(yesterday);
  const billId = createRoomBill({
    date: today, pm: 'ONLINE', guest: 'Priya Verma', bkgNum,
    roomNum: room102.room_number, roomType: room102.room_type,
    nights: 1, rate: room102.base_price, txp: 0,
  });
  insBkg.run({
    bkgNum, roomId: room102.id, grpId: grp,
    guest: 'Priya Verma', phone: '9123456789',
    idType: null, idNum: null,   // <-- no ID: ID row should NOT appear on invoice
    numGuests: 1,
    cin: dt(yesterday, 14, 0), cout: dt(today, 11, 0),
    acin: `${dateOnly(yesterday)} 14:10:00`, acout: `${dateOnly(today)} 11:00:00`,
    rate: room102.base_price, ttax: 0, disc: 0,
    txp: 0, pm: 'ONLINE', adv: 0, advApplied: 0,
    status: 'CHECKED_OUT', cr: null, billId, notes: null,
    createdAt: `${dateOnly(yesterday)} 09:45:00`,
  });
  insContact.run(grp, 'Priya Verma', '9123456789', null, null);
  bookingCount++;
}

// ── 5C. SAME-DAY TURNOVER on room 102 — new guest checks IN today (same date as 5B checkout) ──
// Validates: same-day turnover fix — this booking MUST NOT be blocked by the 5B checkout
if (room102) {
  const grp = newGroupId();
  const bkgNum = nextBkgNum(today);
  insBkg.run({
    bkgNum, roomId: room102.id, grpId: grp,
    guest: 'Karan Bose', phone: '9988776655',
    idType: 'PAN Card', idNum: 'ABCPK1234M',
    numGuests: 2,
    cin: dt(today, 14, 0), cout: dt(tomorrow, 11, 0),
    acin: `${dateOnly(today)} 14:30:00`, acout: null,
    rate: room102.base_price, ttax: 100, disc: 0,
    txp: 0, pm: 'CASH', adv: 0, advApplied: 0,
    status: 'CHECKED_IN', cr: null, billId: null, notes: null,
    createdAt: `${dateOnly(today)} 09:00:00`,
  });
  insContact.run(grp, 'Karan Bose', '9988776655', null, null);
  bookingCount++;
}

// ── 5D. CHECKED_OUT — 37h stay (09:00 day1 → 22:00 day2) = 1 night NOT 2 ──
// Validates: old Math.round(37/24)=2 bug is fixed — must bill exactly 1 night
if (room103) {
  const grp = newGroupId();
  const bkgNum = nextBkgNum(twoDaysAgo);
  const billId = createRoomBill({
    date: yesterday, pm: 'CASH', guest: 'Amit Singh', bkgNum,
    roomNum: room103.room_number, roomType: room103.room_type,
    nights: 1, rate: room103.base_price, touristTax: 100, txp: 0,
  });
  insBkg.run({
    bkgNum, roomId: room103.id, grpId: grp,
    guest: 'Amit Singh', phone: '9000111222',
    idType: 'Passport', idNum: 'J1234567',
    numGuests: 1,
    cin: dt(twoDaysAgo, 9, 0), cout: dt(yesterday, 22, 0),
    acin: `${dateOnly(twoDaysAgo)} 09:20:00`, acout: `${dateOnly(yesterday)} 22:10:00`,
    rate: room103.base_price, ttax: 100, disc: 0,
    txp: 0, pm: 'CASH', adv: 0, advApplied: 0,
    status: 'CHECKED_OUT', cr: null, billId, notes: '37h stay — should be 1 night',
    createdAt: `${dateOnly(twoDaysAgo)} 08:30:00`,
  });
  insContact.run(grp, 'Amit Singh', '9000111222', null, null);
  bookingCount++;
}

// ── 5E. CHECKED_OUT — oversized discount (discount > room charge) → ₹0 bill ──
// Validates: Math.max(0,...) clamp — bill total must be ₹0 not negative
if (room201) {
  const grp = newGroupId();
  const bkgNum = nextBkgNum(twoDaysAgo);
  // Rate ₹2,800 × 1 night = ₹2,800. Discount ₹5,000 → clamped to ₹0 total.
  const rate = room201.base_price;
  const disc = 5000; // intentionally oversized
  const sub = +(rate * 1).toFixed(2);
  const tot = 0; // clamped
  const bn = nextBillNum(yesterday);
  const tok = nextToken('CASH');
  const result = insBill.run({
    bn, tok, pm: 'CASH', cust: 'Sneha Gupta',
    sub, txp: 0, txa: 0, disc, adv: 0, bal: 0, tot,
    st: 'COMPLETED', cr: null,
    at: `${dateOnly(yesterday)} 11:00:00`,
    note: `Room Booking ${bkgNum} - Room ${room201.room_number} | Complimentary Stay`,
    src: 'ROOM', ...roomBiz, bkgNum,
  });
  const billId = result.lastInsertRowid;
  insItem.run(billId, null, `Room ${room201.room_number} (${room201.room_type}) x 1 night`, rate, 1, rate);
  insBkg.run({
    bkgNum, roomId: room201.id, grpId: grp,
    guest: 'Sneha Gupta', phone: '9700200300',
    idType: null, idNum: null,
    numGuests: 2,
    cin: dt(twoDaysAgo, 14, 0), cout: dt(yesterday, 11, 0),
    acin: `${dateOnly(twoDaysAgo)} 14:30:00`, acout: `${dateOnly(yesterday)} 11:00:00`,
    rate, ttax: 0, disc,
    txp: 0, pm: 'CASH', adv: 0, advApplied: 0,
    status: 'CHECKED_OUT', cr: null, billId, notes: 'Complimentary / courtesy stay',
    createdAt: `${dateOnly(twoDaysAgo)} 12:00:00`,
  });
  insContact.run(grp, 'Sneha Gupta', '9700200300', null, null);
  bookingCount++;
}

// ── 5F. GROUP BOOKING — ALL rooms CHECKED_OUT → "Combined Invoice" button must appear ──
// Validates: g.rooms.every(r => r.status === 'CHECKED_OUT') fix
// Rooms 202 (Deluxe) and 301 (Suite) form a group, both checked out.
if (room202 && room301) {
  const grp = newGroupId();
  const masterBkgNum = nextBkgNum(threeDaysAgo);
  const bkgNum2 = `${masterBkgNum}-R2`;

  // Room 202 checkout bill
  const bill202 = createRoomBill({
    date: yesterday, pm: 'CASH', guest: 'Vikram Rao', bkgNum: masterBkgNum,
    roomNum: room202.room_number, roomType: room202.room_type,
    nights: 2, rate: room202.base_price, advance: 1000, txp: 0,
  });
  insBkg.run({
    bkgNum: masterBkgNum, roomId: room202.id, grpId: grp,
    guest: 'Vikram Rao', phone: '9111222333',
    idType: 'Aadhaar Card', idNum: '9876 5432 1098',
    numGuests: 2,
    cin: dt(threeDaysAgo, 14, 0), cout: dt(yesterday, 11, 0),
    acin: `${dateOnly(threeDaysAgo)} 14:00:00`, acout: `${dateOnly(yesterday)} 11:00:00`,
    rate: room202.base_price, ttax: 0, disc: 0,
    txp: 0, pm: 'CASH', adv: 1000, advApplied: 1000,
    status: 'CHECKED_OUT', cr: null, billId: bill202, notes: 'Group booking lead guest',
    createdAt: `${dateOnly(threeDaysAgo)} 10:00:00`,
  });

  // Room 301 checkout bill
  const bill301 = createRoomBill({
    date: yesterday, pm: 'CASH', guest: 'Vikram Rao', bkgNum: bkgNum2,
    roomNum: room301.room_number, roomType: room301.room_type,
    nights: 2, rate: room301.base_price, txp: 0,
  });
  insBkg.run({
    bkgNum: bkgNum2, roomId: room301.id, grpId: grp,
    guest: 'Vikram Rao', phone: '9111222333',
    idType: null, idNum: null,
    numGuests: 3,
    cin: dt(threeDaysAgo, 14, 0), cout: dt(yesterday, 11, 0),
    acin: `${dateOnly(threeDaysAgo)} 14:05:00`, acout: `${dateOnly(yesterday)} 11:10:00`,
    rate: room301.base_price, ttax: 0, disc: 0,
    txp: 0, pm: 'CASH', adv: 0, advApplied: 0,
    status: 'CHECKED_OUT', cr: null, billId: bill301, notes: null,
    createdAt: `${dateOnly(threeDaysAgo)} 10:00:00`,
  });

  insContact.run(grp, 'Vikram Rao', '9111222333', null, null);
  insContact.run(grp, 'Anjali Nair', '9333444555', null, 'Extra pillows please');
  bookingCount += 2;
  console.log(`  Group booking ${masterBkgNum} (rooms ${room202.room_number}+${room301.room_number}) FULLY checked out → Combined Invoice button should be visible`);
}

// ── 5G. GROUP BOOKING — mixed status (1 CHECKED_IN, 1 BOOKED today) → Combined Invoice NOT shown ──
// Validates the NEGATIVE case: button hidden when group is not fully out
// Uses rooms 101 + 103 (both free today after scenarios 5A and 5D checked out)
if (room101 && room103) {
  const grp = newGroupId();
  const masterBkgNum = nextBkgNum(today);
  const bkgNum2 = `${masterBkgNum}-R2`;
  insBkg.run({
    bkgNum: masterBkgNum, roomId: room101.id, grpId: grp,
    guest: 'Meera Pillai', phone: '9222333444',
    idType: null, idNum: null, numGuests: 2,
    cin: dt(today, 14, 0), cout: dt(twoDaysLater, 11, 0),
    acin: `${dateOnly(today)} 14:30:00`, acout: null,
    rate: room101.base_price, ttax: 0, disc: 0,
    txp: 0, pm: 'ONLINE', adv: 500, advApplied: 0,
    status: 'CHECKED_IN', cr: null, billId: null, notes: null,
    createdAt: `${dateOnly(today)} 09:00:00`,
  });
  insBkg.run({
    bkgNum: bkgNum2, roomId: room103.id, grpId: grp,
    guest: 'Meera Pillai', phone: '9222333444',
    idType: null, idNum: null, numGuests: 1,
    cin: dt(today, 14, 0), cout: dt(twoDaysLater, 11, 0),
    acin: null, acout: null,
    rate: room103.base_price, ttax: 0, disc: 0,
    txp: 0, pm: 'ONLINE', adv: 0, advApplied: 0,
    status: 'BOOKED', cr: null, billId: null, notes: null,
    createdAt: `${dateOnly(today)} 09:00:00`,
  });
  insContact.run(grp, 'Meera Pillai', '9222333444', 'meera@example.com', 'High floor preferred');
  bookingCount += 2;
  console.log(`  Group booking ${masterBkgNum} (rooms ${room101.room_number}+${room103.room_number}) PARTIALLY checked in → Combined Invoice must NOT appear`);
}

// ── 5H. BOOKED (future) — upcoming single booking with large advance ──
if (room103) {
  const grp = newGroupId();
  const bkgNum = nextBkgNum(today);
  insBkg.run({
    bkgNum, roomId: room103.id, grpId: grp,
    guest: 'Divya Menon', phone: '9444555666',
    idType: null, idNum: null, numGuests: 3,
    cin: dt(twoDaysLater, 14, 0), cout: dt(fiveDaysLater, 11, 0),
    acin: null, acout: null,
    rate: room103.base_price, ttax: 150, disc: 0,
    txp: 0, pm: 'CASH', adv: 1000, advApplied: 0,
    status: 'BOOKED', cr: null, billId: null, notes: '3-night booking with ₹1,000 advance',
    createdAt: sqlNow(),
  });
  insContact.run(grp, 'Divya Menon', '9444555666', null, 'Vegetarian meals preferred');
  bookingCount++;
}

// ── 5I. BOOKED (future) — upcoming booking, no advance ──
if (room301) {
  const grp = newGroupId();
  const bkgNum = nextBkgNum(today);
  insBkg.run({
    bkgNum, roomId: room301.id, grpId: grp,
    guest: 'Rohit Mehta', phone: '9555666777',
    idType: null, idNum: null, numGuests: 2,
    cin: dt(threeDaysLater, 14, 0), cout: dt(sixDaysLater, 11, 0),
    acin: null, acout: null,
    rate: room301.base_price, ttax: 0, disc: 500,
    txp: 0, pm: 'ONLINE', adv: 0, advApplied: 0,
    status: 'BOOKED', cr: null, billId: null, notes: 'Corporate guest — ₹500 corporate discount pre-applied',
    createdAt: sqlNow(),
  });
  insContact.run(grp, 'Rohit Mehta', '9555666777', 'rohit.mehta@corp.com', null);
  bookingCount++;
}

// ── 5J. CANCELLED booking — validate cancel flow display ──
if (room202) {
  const grp = newGroupId();
  const bkgNum = nextBkgNum(twoDaysAgo);
  insBkg.run({
    bkgNum, roomId: room202.id, grpId: grp,
    guest: 'Ajay Kulkarni', phone: '9777888999',
    idType: null, idNum: null, numGuests: 1,
    cin: dt(fourDaysLater, 14, 0), cout: dt(fiveDaysLater, 11, 0),
    acin: null, acout: null,
    rate: room202.base_price, ttax: 0, disc: 0,
    txp: 0, pm: 'CASH', adv: 800, advApplied: 0,
    status: 'CANCELLED', cr: 'Guest cancelled travel plans',
    billId: null, notes: null,
    createdAt: `${dateOnly(twoDaysAgo)} 11:00:00`,
  });
  insContact.run(grp, 'Ajay Kulkarni', '9777888999', null, null);
  bookingCount++;
}

// ── 5K. KEY SCENARIO: 3-room group — rooms 201+202 check in TODAY, room 301 originally booked ──
//        for today+2 (Sep 16) but guest wants to move in NOW with the rest of the group.
//        Validates: early check-in/out allowed for a future-dated group sibling
//        when other rooms in the group are already CHECKED_IN today.
//        Room 201 → CHECKED_IN today
//        Room 202 → CHECKED_IN today
//        Room 301 → BOOKED for today+2 but should be check-in/out-able early from the UI
if (room201 && room202 && room301) {
  const grp = newGroupId();
  const masterBkgNum = nextBkgNum(today);
  const bkgNum2 = `${masterBkgNum}-R2`;
  const bkgNum3 = `${masterBkgNum}-R3`;
  // Room 201 — checked in today, checkout today+3
  insBkg.run({
    bkgNum: masterBkgNum, roomId: room201.id, grpId: grp,
    guest: 'Naveen Rathi', phone: '9666777888',
    idType: 'Voter ID', idNum: 'ABC1234567',
    numGuests: 2,
    cin: dt(today, 14, 0), cout: dt(threeDaysLater, 11, 0),
    acin: `${dateOnly(today)} 14:20:00`, acout: null,
    rate: room201.base_price, ttax: 0, disc: 0,
    txp: 0, pm: 'CASH', adv: 2000, advApplied: 0,
    status: 'CHECKED_IN', cr: null, billId: null, notes: 'Group lead room',
    createdAt: `${dateOnly(today)} 10:00:00`,
  });
  // Room 202 — checked in today, checkout today+3
  insBkg.run({
    bkgNum: bkgNum2, roomId: room202.id, grpId: grp,
    guest: 'Naveen Rathi', phone: '9666777888',
    idType: null, idNum: null, numGuests: 2,
    cin: dt(today, 14, 0), cout: dt(threeDaysLater, 11, 0),
    acin: `${dateOnly(today)} 14:25:00`, acout: null,
    rate: room202.base_price, ttax: 0, disc: 0,
    txp: 0, pm: 'CASH', adv: 0, advApplied: 0,
    status: 'CHECKED_IN', cr: null, billId: null, notes: null,
    createdAt: `${dateOnly(today)} 10:00:00`,
  });
  // Room 301 — originally booked for today+2, but guest arrived early with group.
  // The Check In button should be ENABLED because siblings 201+202 are already CHECKED_IN.
  insBkg.run({
    bkgNum: bkgNum3, roomId: room301.id, grpId: grp,
    guest: 'Naveen Rathi', phone: '9666777888',
    idType: null, idNum: null, numGuests: 3,
    cin: dt(twoDaysLater, 14, 0), cout: dt(threeDaysLater, 11, 0),
    acin: null, acout: null,
    rate: room301.base_price, ttax: 0, disc: 0,
    txp: 0, pm: 'CASH', adv: 0, advApplied: 0,
    status: 'BOOKED', cr: null, billId: null,
    notes: 'Originally booked from today+2 — guest arrived early, check in today with rest of group',
    createdAt: `${dateOnly(today)} 10:00:00`,
  });
  insContact.run(grp, 'Naveen Rathi', '9666777888', null, 'Extra room booked for family arriving later — now arriving early');
  bookingCount += 3;
  console.log(`  Group booking ${masterBkgNum} (rooms ${room201.room_number}+${room202.room_number}+${room301.room_number}): 201+202 CHECKED_IN today, 301 BOOKED for today+2`);
  console.log(`  → Room 301 "Check In" button must be ENABLED (early check-in allowed for group siblings)`);
}

console.log(`  -> ${bookingCount} room bookings across all scenarios`);

// ──────────────────────────────────────────────────────────────────────────────
// 6. EXPENSES — last 3 months sample
// ──────────────────────────────────────────────────────────────────────────────
console.log('\nSeeding expenses...');
const insExp = db.prepare(
  'INSERT INTO expenses (category, paid_to, amount, payment_method, notes, created_at) VALUES (?,?,?,?,?,?)'
);
const expEntries = [
  ['RENT',        'Property Owner',     22000, 'ONLINE', 'Monthly rent Sep 2026',     addDays(today, -3)],
  ['RENT',        'Property Owner',     22000, 'ONLINE', 'Monthly rent Aug 2026',     addDays(today, -34)],
  ['RENT',        'Property Owner',     22000, 'ONLINE', 'Monthly rent Jul 2026',     addDays(today, -65)],
  ['SALARY',      'Kitchen Staff',      15000, 'CASH',   'Sep 2026 kitchen salary',   addDays(today, -3)],
  ['SALARY',      'Front Desk Staff',   12000, 'CASH',   'Sep 2026 front desk salary',addDays(today, -3)],
  ['SALARY',      'Kitchen Staff',      15000, 'CASH',   'Aug 2026 kitchen salary',   addDays(today, -34)],
  ['SALARY',      'Front Desk Staff',   12000, 'CASH',   'Aug 2026 front desk salary',addDays(today, -34)],
  ['UTILITIES',   'Electricity Board',   4800, 'ONLINE', 'Electricity bill Sep',      addDays(today, -5)],
  ['UTILITIES',   'Water Supply',         600, 'CASH',   'Water bill Sep',            addDays(today, -5)],
  ['UTILITIES',   'Electricity Board',   5100, 'ONLINE', 'Electricity bill Aug',      addDays(today, -36)],
  ['MAINTENANCE', 'AC Repair Service',   3500, 'CASH',   'AC unit room 301 repaired', addDays(today, -10)],
  ['MAINTENANCE', 'Plumber',              800, 'CASH',   'Bathroom tap room 103',     addDays(today, -20)],
  ['OTHER',       'Misc Vendor',         1200, 'CASH',   'Cleaning supplies',         addDays(today, -7)],
];
for (const [cat, paidTo, amount, pm, notes, d] of expEntries) {
  insExp.run(cat, paidTo, amount, pm, notes, `${dateOnly(d)} 10:00:00`);
}
console.log(`  -> ${expEntries.length} expenses`);

// ──────────────────────────────────────────────────────────────────────────────
// 7. RAW MATERIAL PURCHASES — recent restocks
// ──────────────────────────────────────────────────────────────────────────────
console.log('\nSeeding raw material purchases...');
const rawMats = db.prepare('SELECT * FROM raw_materials').all();
let purchaseCount = 0;
if (rawMats.length) {
  const insPO = db.prepare(
    'INSERT INTO purchase_orders (raw_material_id, quantity, cost_per_unit, total_cost, supplier, notes, created_at) VALUES (?,?,?,?,?,?,?)'
  );
  const insSM = db.prepare(
    'INSERT INTO stock_movements (raw_material_id, change_qty, type, reference_id, notes, created_at) VALUES (?,?,?,?,?,?)'
  );
  const restocks = [
    // A few recent purchases so the "Inventory" page isn't empty
    { name: 'Paneer',        qty: 10,  cpu: 320, supplier: 'Fresh Dairy Co' },
    { name: 'Chicken',       qty: 15,  cpu: 220, supplier: 'Meat Market' },
    { name: 'Rice',          qty: 25,  cpu: 70,  supplier: 'Rice Traders' },
    { name: 'Wheat Flour',   qty: 20,  cpu: 40,  supplier: 'Flour Mill' },
    { name: 'Butter',        qty: 5,   cpu: 450, supplier: 'Dairy Depot' },
    { name: 'Cooking Oil',   qty: 10,  cpu: 150, supplier: 'Oil Depot' },
    { name: 'Milk',          qty: 15,  cpu: 55,  supplier: 'Fresh Dairy Co' },
  ];
  for (const r of restocks) {
    const mat = rawMats.find((m) => m.name === r.name);
    if (!mat) continue;
    const totalCost = +(r.qty * r.cpu).toFixed(2);
    const createdAt = `${dateOnly(addDays(today, -7))} 09:30:00`;
    const po = insPO.run(mat.id, r.qty, r.cpu, totalCost, r.supplier, null, createdAt);
    insSM.run(mat.id, r.qty, 'PURCHASE', po.lastInsertRowid, 'Demo restock', createdAt);
    purchaseCount++;
  }
}
console.log(`  -> ${purchaseCount} purchase orders`);

// ──────────────────────────────────────────────────────────────────────────────
// 8. Persist seeded counter values so the running app's next bill/booking
//    continues from the right sequence, not back to 0001.
// ──────────────────────────────────────────────────────────────────────────────
const insCounter = db.prepare('INSERT OR REPLACE INTO counters (key, value) VALUES (?, ?)');
for (const [key, value] of countersMap.entries()) insCounter.run(key, value);

// ──────────────────────────────────────────────────────────────────────────────
// 9. Summary
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(64));
console.log('SEED COMPLETE. What to validate in the running app:');
console.log('═'.repeat(64));
console.log('');
console.log('FOOD BILLING:');
console.log('  • Bills page shows recent orders (last 3 days) + 1 cancelled bill');
console.log('  • Sales Report shows correct totals for yesterday/today');
console.log('');
console.log('ROOM BOOKINGS:');
console.log('  • Room 101 — AVAILABLE (prev guest Rahul Sharma checked out)');
console.log('  • Room 102 — OCCUPIED  (Karan Bose checked in today at 14:00)');
console.log('                          SAME-DAY TURNOVER: Priya Verma was checked');
console.log('                          out this morning; Karan Bose checked in this');
console.log('                          afternoon — should work without conflict');
console.log('  • Room 103 — AVAILABLE (Amit Singh 37h stay = billed 1 night ✓)');
console.log('  • Room 201 — OCCUPIED  (Naveen Rathi 3-night stay)');
console.log('  • Room 202 — AVAILABLE until tomorrow (Ajay Kulkarni cancelled)');
console.log('                          Future BOOKED bookings visible in calendar');
console.log('  • Room 301 — AVAILABLE (future booking from Rohit Mehta in 3 days)');
console.log('');
console.log('INVOICES TO CHECK:');
console.log('  1. Rahul Sharma (Room 101) — 2-night invoice with advance ₹500');
console.log('     discount ₹200, balance ₹(2×1800 - 200 - 500) = ₹2,900');
console.log('     Aadhaar Card row MUST appear (ID number is set)');
console.log('  2. Priya Verma (Room 102) — 1-night invoice (21h stay = 1 night)');
console.log('     ID row MUST NOT appear (no ID type or number set)');
console.log('  3. Amit Singh (Room 103) — 1-night + ₹100 tourist tax (37h = 1 night)');
console.log('     NOT 2 nights despite staying 37 hours');
console.log('  4. Sneha Gupta (Room 201) — ₹0 invoice (discount ₹5,000 > rate ₹2,800)');
console.log('     bill total MUST be ₹0, never negative');
console.log('  5. Vikram Rao (Rooms 202+301) — COMBINED INVOICE button must show');
console.log('     (both rooms are CHECKED_OUT)');
console.log('     Room 202: 2 nights + advance ₹1,000 applied');
console.log('     Room 301: 2 nights');
console.log('  6. Meera Pillai (Rooms 101+103) — Combined Invoice must NOT show');
console.log('     (room 101 CHECKED_IN, room 103 BOOKED — group not fully done yet)');
console.log('  7. Naveen Rathi (Rooms 201+202+301) — 3-room group');
console.log('     201+202: CHECKED_IN today. 301: BOOKED for today+2.');
console.log('     *** Room 301 "Check In" button must be ENABLED (early group check-in) ***');
console.log('     Check in room 301 today → date auto-advances to today → bills correctly');
console.log('');
console.log('Master data (menu, rooms, settings, staff) left untouched.');
console.log('');
