// Comprehensive edge-case regression sweep across every core module NOT
// already deeply covered by scripts/regression-test.cjs (billing math,
// room lifecycle, refunds) or scripts/multidevice-test.cjs (LAN/table sync
// concurrency). This file specifically targets: Inventory (raw materials +
// purchases), Food/Menu management, Table Management lifecycle, Expense
// tracking, and Room-Booking boundary conditions that live at the edges of
// normal usage — the kind of thing that only shows up in real day-to-day
// operation, not a happy-path demo.
//
// Every test asserts the CORRECT/desired behavior (not "whatever the code
// currently does") — a FAIL here means a real gap worth a human decision on
// whether to fix it or accept it as a known, intentional limitation. Each
// test's comment states which case it is BEFORE running, so failures are
// self-explanatory without needing to read the source.
//
// Run standalone: node scripts/edge-case-test.cjs
// Included in: npm run test:all
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billnest-edgecase-'));
const { initDatabase, getDb } = require('../db/database.cjs');
initDatabase(tmpDir);

const service = require('../db/service.cjs');
const roomService = require('../db/roomService.cjs');

let passed = 0;
let failed = 0;
const failures = [];
// Tests that fail here get a human judgment call recorded alongside them —
// 'BUG' means the failure represents a real gap worth fixing; 'ACCEPTED'
// means the current behavior, while not ideal, is a known/intentional
// limitation we're choosing to live with for now.
const verdicts = [];

function test(name, fn, verdictIfFail) {
  try {
    fn();
    passed++;
    console.log(`  \u2705 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    verdicts.push({ name, verdict: verdictIfFail || 'BUG', reason: err.message });
    console.log(`  \u274c ${name}`);
    console.log(`     ${err.message}`);
  }
}

function approx(actual, expected, msg, eps = 0.01) {
  assert.ok(Math.abs(actual - expected) < eps, `${msg} (expected ${expected}, got ${actual})`);
}

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

// ============================================================
console.log('\n== 1. Inventory: Raw Materials & Purchases ==');
// ============================================================

test('saveRawMaterial creates a new item with 0 stock/threshold/cost by default (no stock-level tracking — see recordPurchase below)', () => {
  const id = service.saveRawMaterial({ name: 'Basmati Rice', unit: 'kg' });
  const material = service.getRawMaterials().find((m) => m.id === id);
  assert.ok(material, 'material should be findable via getRawMaterials');
  approx(material.current_stock, 0, 'current_stock starts at 0');
  approx(material.low_stock_threshold, 0, 'low_stock_threshold starts at 0');
  approx(material.cost_per_unit, 0, 'cost_per_unit starts at 0');
});

test('EXPECTED LIMITATION: recordPurchase increases spend totals but does NOT increase the raw material\'s current_stock (this app deliberately does no stock-level/quantity tracking, only money-spent tracking — see the comment above recordPurchase in db/service.cjs)', () => {
  const id = service.saveRawMaterial({ name: 'Edge Cooking Oil', unit: 'litre' });
  service.recordPurchase({ raw_material_id: id, quantity: 20, cost_per_unit: 150, supplier: 'ABC Traders' });
  const material = service.getRawMaterials().find((m) => m.id === id);
  approx(material.current_stock, 0, 'current_stock must remain 0 — this is intentional, not a bug, given no consumption/recipe tracking exists to draw it back down either');
  approx(material.cost_per_unit, 150, 'cost_per_unit SHOULD update to the latest purchase price (for convenience on the next purchase)');
}, 'ACCEPTED');

test('recordPurchase correctly totals cost_per_unit * quantity and it is reflected in getPurchaseSummary', () => {
  const id = service.saveRawMaterial({ name: 'Test Flour', unit: 'kg' });
  const before = service.getPurchaseSummary('all');
  service.recordPurchase({ raw_material_id: id, quantity: 25, cost_per_unit: 40, supplier: 'Flour Co' });
  const after = service.getPurchaseSummary('all');
  approx(after.totalSpend - before.totalSpend, 1000, 'purchase total should be exactly 25*40=1000');
});

test('getPurchaseHistory correctly filters by date range (from/to)', () => {
  const id = service.saveRawMaterial({ name: 'Date Filter Material', unit: 'kg' });
  service.recordPurchase({ raw_material_id: id, quantity: 5, cost_per_unit: 10, supplier: 'S1' });
  const today = new Date().toISOString().slice(0, 10);
  const inRange = service.getPurchaseHistory({ from: today, to: today });
  const outOfRange = service.getPurchaseHistory({ from: '2000-01-01', to: '2000-01-02' });
  assert.ok(inRange.some((p) => p.raw_material_id === id), 'a purchase made today should appear in a today-to-today filter');
  assert.ok(!outOfRange.some((p) => p.raw_material_id === id), 'a purchase made today should NOT appear in an unrelated 2000 date-range filter');
});

test('EDGE CASE: recordPurchase with a negative quantity or cost is REJECTED, not silently recorded as negative spend', () => {
  const id = service.saveRawMaterial({ name: 'Negative Purchase Material', unit: 'kg' });
  assert.throws(
    () => service.recordPurchase({ raw_material_id: id, quantity: -5, cost_per_unit: 10, supplier: 'Bad Data Co' }),
    /positive|invalid|greater than 0/i,
    'a negative quantity purchase should be rejected with a clear validation error'
  );
}, 'BUG');

test('EDGE CASE: deleting a raw material that already has purchase history gives a clear, friendly error (not a raw SQLITE FOREIGN KEY constraint message) — matches the same protective pattern deleteTable already uses for active orders', () => {
  const id = service.saveRawMaterial({ name: 'Referenced Material', unit: 'kg' });
  service.recordPurchase({ raw_material_id: id, quantity: 1, cost_per_unit: 5, supplier: 'S' });
  assert.throws(
    () => service.deleteRawMaterial(id),
    /purchase|history|record/i,
    'deleting a raw material with existing purchase history should throw a friendly, explanatory error, not a raw DB constraint error'
  );
  // Whatever happens, purchase history integrity must never be silently broken.
  const stillThere = service.getPurchaseHistory({}).some((p) => p.raw_material_id === id);
  assert.ok(stillThere, 'existing purchase records for this material must not disappear/orphan silently');
}, 'BUG');

test('deleteRawMaterial with NO purchase history succeeds cleanly and the item disappears from getRawMaterials', () => {
  const id = service.saveRawMaterial({ name: 'Unused Material', unit: 'kg' });
  service.deleteRawMaterial(id);
  assert.ok(!service.getRawMaterials().some((m) => m.id === id), 'deleted material should no longer be listed');
});

// ============================================================
console.log('\n== 2. Food & Menu management ==');
// ============================================================

test('addCategory + saveFoodItem: a new food item is immediately listed and searchable (case-insensitive)', () => {
  const cat = service.addCategory('Edge Case Category');
  const catId = cat.id || cat;
  const food = service.saveFoodItem({ name: 'Paneer Tikka Special', price: 220, categoryId: catId, category_id: catId });
  const foundLower = service.getFoodItems({ search: 'paneer tikka' });
  assert.ok(foundLower.some((f) => f.name === 'Paneer Tikka Special'), `search should be case-insensitive (found: ${JSON.stringify(foundLower.map((f)=>f.name))})`);
  assert.ok(food, 'saveFoodItem should return a truthy result (id or object)');
});

test('Deleting a food item does NOT retroactively corrupt an already-billed bill\'s line items (bill_items snapshot name/price at billing time, no FK tying them to a live food_items row)', () => {
  const cat = service.addCategory('Deletable Category');
  const catId = cat.id || cat;
  const foodId = service.saveFoodItem({ name: 'Soon To Be Deleted Item', price: 99, categoryId: catId, category_id: catId });
  const resolvedFoodId = typeof foodId === 'object' ? foodId.id : foodId;
  const bill = service.createBill({ items: [{ id: resolvedFoodId, name: 'Soon To Be Deleted Item', price: 99, quantity: 2 }], paymentMethod: 'CASH' });
  service.deleteFoodItem(resolvedFoodId);
  const fetched = service.getBillById(bill.id);
  assert.strictEqual(fetched.items.length, 1, 'the bill should still show its 1 line item after the food item is deleted');
  approx(fetched.items[0].total, 198, 'the line item total must remain intact (99*2), unaffected by the food item deletion');
});

test('EDGE CASE: saveFoodItem rejects a negative price (a real cashier typo like "-50" should not silently create a sellable item that PAYS the customer)', () => {
  const cat = service.addCategory('Negative Price Category');
  const catId = cat.id || cat;
  assert.throws(
    () => service.saveFoodItem({ name: 'Negative Price Item', price: -50, categoryId: catId, category_id: catId }),
    /price|positive|invalid/i,
    'a negative price should be rejected'
  );
}, 'BUG');

// ============================================================
console.log('\n== 3. Table Management lifecycle ==');
// ============================================================

test('saveTable + assignTableWaiter: assigning a table to a waiter, then reassigning to a different waiter, always reflects the LATEST waiter only', () => {
  const table = service.saveTable({ name: 'Edge-T1', capacity: 4 });
  service.assignTableWaiter(table.id, 'Waiter Ravi');
  const afterFirst = service.getTables().find((t) => t.id === table.id);
  assert.strictEqual(afterFirst.waiter_name, 'Waiter Ravi');
  service.assignTableWaiter(table.id, 'Waiter Sunita');
  const afterSecond = service.getTables().find((t) => t.id === table.id);
  assert.strictEqual(afterSecond.waiter_name, 'Waiter Sunita', 'reassigning a table must fully replace the previous waiter, not append/merge');
});

test('clearTableOrder on a table that has NO existing order is a safe no-op (does not throw)', () => {
  const table = service.saveTable({ name: 'Edge-T2', capacity: 2 });
  assert.doesNotThrow(() => service.clearTableOrder(table.id), 'clearing an already-empty table order must not throw');
  assert.strictEqual(service.getTableOrder(table.id), null, 'getTableOrder should report null for a table with no order');
});

test('saveTableOrder with an EMPTY items array is accepted and reads back as empty (used by the UI to represent "order cleared but table still selected")', () => {
  const table = service.saveTable({ name: 'Edge-T3', capacity: 2 });
  service.saveTableOrder(table.id, { items: [{ name: 'Item', price: 10, quantity: 1 }] });
  service.saveTableOrder(table.id, { items: [] });
  const order = service.getTableOrder(table.id);
  assert.deepStrictEqual(order.items, [], 'saving an empty items array should read back as an empty array, not null or the old items');
});

test('deleteTable is BLOCKED while the table status is OCCUPIED (matches the friendly-error pattern) — this already works correctly', () => {
  const table = service.saveTable({ name: 'Edge-T4', capacity: 4 });
  service.updateTableStatus(table.id, 'OCCUPIED');
  assert.throws(() => service.deleteTable(table.id), /active order|occupied/i, 'deleting an OCCUPIED table should be blocked with a clear message');
  service.updateTableStatus(table.id, 'EMPTY');
  assert.doesNotThrow(() => service.deleteTable(table.id), 'once EMPTY again, the table should delete cleanly');
});

test('Table names are NOT required to be unique (two tables can share a name, e.g. "T1" in two different areas/floors) — documenting current (permissive) behavior', () => {
  service.saveTable({ name: 'Edge-DUPNAME', capacity: 2, area: 'Ground Floor' });
  assert.doesNotThrow(() => service.saveTable({ name: 'Edge-DUPNAME', capacity: 2, area: 'First Floor' }), 'duplicate table names across different areas should be allowed, not rejected');
});

// ============================================================
console.log('\n== 4. Expense tracking ==');
// ============================================================

test('recordExpense + getExpenseSummary correctly groups multiple entries in the SAME category', () => {
  const before = service.getExpenseSummary('all');
  service.recordExpense({ category: 'Edge Utilities', paid_to: 'Electric Co', amount: 500, payment_method: 'CASH' });
  service.recordExpense({ category: 'Edge Utilities', paid_to: 'Water Co', amount: 300, payment_method: 'CASH' });
  const after = service.getExpenseSummary('all');
  const cat = after.byCategory.find((c) => c.category === 'Edge Utilities');
  approx(cat.spend, 800, 'two expenses in the same category should sum to 800 (500+300), not overwrite each other');
  approx(after.totalSpend - before.totalSpend, 800, 'overall expense total should increase by exactly 800');
});

test('EDGE CASE: recordExpense rejects a zero or negative amount (a ₹0 "expense" is meaningless and a negative one could be used to secretly inflate profit)', () => {
  assert.throws(
    () => service.recordExpense({ category: 'Edge Zero', paid_to: 'Nobody', amount: 0, payment_method: 'CASH' }),
    /amount|positive|invalid|greater than/i,
    'a zero-amount expense should be rejected'
  );
  assert.throws(
    () => service.recordExpense({ category: 'Edge Negative', paid_to: 'Nobody', amount: -100, payment_method: 'CASH' }),
    /amount|positive|invalid|greater than/i,
    'a negative-amount expense should be rejected'
  );
}, 'BUG');

test('getExpenseHistory correctly filters by date range (from/to)', () => {
  service.recordExpense({ category: 'Edge Date Filter', paid_to: 'Vendor', amount: 111, payment_method: 'CASH' });
  const today = new Date().toISOString().slice(0, 10);
  const inRange = service.getExpenseHistory({ from: today, to: today });
  const outOfRange = service.getExpenseHistory({ from: '2000-01-01', to: '2000-01-02' });
  assert.ok(inRange.some((e) => e.category === 'Edge Date Filter'), 'today\'s expense should appear in a today-to-today filter');
  assert.ok(!outOfRange.some((e) => e.category === 'Edge Date Filter'), 'today\'s expense should NOT appear in an unrelated 2000 date-range filter');
});

// ============================================================
console.log('\n== 5. Room booking boundary conditions ==');
// ============================================================

test('Back-to-back same-day turnover IS allowed: Room checked out today, and a NEW booking check-in for the SAME room on the SAME day must succeed (standard hotel same-day turnover, not a double-booking)', () => {
  roomService.saveRoom({ room_number: 'EDGE-TURNOVER', room_type: 'Standard', base_price: 1500, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'EDGE-TURNOVER');
  const booking1 = roomService.createBooking({ roomId: room.id, guestName: 'Morning Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH' });
  roomService.checkIn(booking1.id);
  roomService.checkOut(booking1.id, 'CASH');
  // New booking starting exactly on booking1's checkout date must be allowed.
  assert.doesNotThrow(
    () => roomService.createBooking({ roomId: room.id, guestName: 'Evening Guest', checkInDate: futureDate(1), checkOutDate: futureDate(2), paymentMethod: 'CASH' }),
    'a same-day turnover booking (new check-in date == old check-out date) must be allowed'
  );
});

test('A single-room (non-group) booking advance LARGER than the room charge is capped — balanceDue never goes negative', () => {
  roomService.saveRoom({ room_number: 'EDGE-OVERADVANCE', room_type: 'Standard', base_price: 1000, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'EDGE-OVERADVANCE');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Over Advance Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH', advancePayment: 5000, taxPercent: 0 });
  const { bill } = roomService.checkOut(booking.id);
  approx(bill.total, 1000, 'bill total should be the full room charge (1000), unaffected by the oversized advance');
  approx(bill.advancePayment, 1000, 'advance actually APPLIED to this bill must be capped at the room charge (1000), not the full 5000 paid');
  approx(bill.balanceDue, 0, 'balanceDue must be clamped at 0, never negative');
});

test('EDGE CASE: a manual discount larger than subtotal+tax does not push the bill total negative (clamped at 0)', () => {
  const bill = service.createBill({ items: [{ name: 'Cheap Item', price: 50, quantity: 1 }], paymentMethod: 'CASH', discount: 500, taxPercent: 0 });
  assert.ok(bill.total >= 0, `bill total must never be negative regardless of an oversized discount (got ${bill.total})`);
}, 'BUG');

// ============================================================
console.log('\n== 5b. Night-count calculation: calendar-day logic, not hour-based ==');
// ============================================================
// All of these protect against the class of bug where Math.round(hours/24)
// was used instead of date-only subtraction — which caused:
//   • A 1-hour or same-day stay to round to 0 nights (only Math.max(1,…) saved it)
//   • A 1-day-13-hour stay to round to 2 nights and overcharge the guest
// Hotel standard: nights = checkout_date - checkin_date (calendar days only).
// Time-of-day is irrelevant — check-in at 14:00, check-out at 11:00 next day
// is 1 night, NOT "0.875 nights rounded to 1" and NOT "1.375 nights rounded to 2".

function dateTimeStr(dateStr, timeStr) {
  // Build a "YYYY-MM-DDTHH:mm" string from a date and a time string.
  return `${dateStr}T${timeStr}`;
}

test('Night count: check-in and check-out on consecutive dates (14:00 → 11:00) = 1 night, not 0 (< 24h gap)', () => {
  roomService.saveRoom({ room_number: 'EDGE-NIGHTS-1', room_type: 'Standard', base_price: 1000, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'EDGE-NIGHTS-1');
  // 14:00 check-in, 11:00 checkout next day = 21 hours = MUST be 1 night
  const checkIn  = dateTimeStr(futureDate(0), '14:00');
  const checkOut = dateTimeStr(futureDate(1), '11:00');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Short Stay', checkInDate: checkIn, checkOutDate: checkOut, paymentMethod: 'CASH', taxPercent: 0 });
  const { bill } = roomService.checkOut(booking.id, 'CASH');
  approx(bill.subtotal, 1000, '21h stay must be billed as exactly 1 night (₹1,000), not 0 or 2');
});

test('Night count: check-in and check-out same calendar date (1-hour stay) = 1 night minimum (no fractional billing)', () => {
  roomService.saveRoom({ room_number: 'EDGE-NIGHTS-2', room_type: 'Standard', base_price: 1200, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'EDGE-NIGHTS-2');
  // Check-in 10:00 AM, check-out 11:00 AM same day = 1 hour = minimum 1 night
  const checkIn  = dateTimeStr(futureDate(0), '10:00');
  const checkOut = dateTimeStr(futureDate(0), '11:00');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Hour Stay', checkInDate: checkIn, checkOutDate: checkOut, paymentMethod: 'CASH', taxPercent: 0 });
  const { bill } = roomService.checkOut(booking.id, 'CASH');
  approx(bill.subtotal, 1200, '1-hour same-day stay must be billed as 1 night (₹1,200) — no sub-night rates exist');
});

test('Night count: check-in 14:00 day 1, check-out 11:00 day 3 = 2 nights (not 3 despite > 48 hours in the room)', () => {
  roomService.saveRoom({ room_number: 'EDGE-NIGHTS-3', room_type: 'Standard', base_price: 1000, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'EDGE-NIGHTS-3');
  // 14:00 → 11:00 two days later = 45 hours but only 2 calendar-night diff
  const checkIn  = dateTimeStr(futureDate(0), '14:00');
  const checkOut = dateTimeStr(futureDate(2), '11:00');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Two Night Stay', checkInDate: checkIn, checkOutDate: checkOut, paymentMethod: 'CASH', taxPercent: 0 });
  const { bill } = roomService.checkOut(booking.id, 'CASH');
  approx(bill.subtotal, 2000, '2-night calendar stay must bill exactly 2 × ₹1,000 = ₹2,000');
});

test('Night count: 1 day 13 hours (check-in 09:00 day 1, check-out 22:00 day 2) = 1 night, NOT 2 (Math.round(37h/24) would wrongly give 2)', () => {
  roomService.saveRoom({ room_number: 'EDGE-NIGHTS-4', room_type: 'Standard', base_price: 1500, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'EDGE-NIGHTS-4');
  // 09:00 → 22:00 next day = 37 hours → old Math.round logic: round(37/24)=2 nights WRONG
  // Calendar-day diff: day+1 − day+0 = 1 night CORRECT
  const checkIn  = dateTimeStr(futureDate(0), '09:00');
  const checkOut = dateTimeStr(futureDate(1), '22:00');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Long Day Stay', checkInDate: checkIn, checkOutDate: checkOut, paymentMethod: 'CASH', taxPercent: 0 });
  const { bill } = roomService.checkOut(booking.id, 'CASH');
  approx(bill.subtotal, 1500, '37-hour stay spanning 1 calendar-day boundary must be billed as 1 night (₹1,500), NOT 2');
});

test('Night count: discount larger than room charge does not produce a negative room bill total (clamped at ₹0)', () => {
  roomService.saveRoom({ room_number: 'EDGE-NIGHTS-5', room_type: 'Standard', base_price: 1000, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'EDGE-NIGHTS-5');
  // Rate ₹1,000, discount ₹3,200 — bill total must be ₹0, not −₹2,200
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Complimentary Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH', taxPercent: 0, discount: 3200 });
  const { bill } = roomService.checkOut(booking.id, 'CASH');
  assert.ok(bill.total >= 0, `room bill total must never be negative even when discount (3200) > room charge (1000) — got ${bill.total}`);
  approx(bill.total, 0, 'room bill with oversized discount should be clamped to ₹0');
});

test('Same-day turnover with TIME component: guest checks out at 11:00 AM via datetime string; new booking same day must not be blocked', () => {
  roomService.saveRoom({ room_number: 'EDGE-TURNOVER-DT', room_type: 'Standard', base_price: 1500, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'EDGE-TURNOVER-DT');
  // Checkout stored WITH time (T11:00) — the old raw-string comparison bug
  // treated this as a conflict against a new checkin stored as a plain date.
  const booking1 = roomService.createBooking({
    roomId: room.id, guestName: 'Checkout Guest',
    checkInDate: dateTimeStr(futureDate(0), '14:00'),
    checkOutDate: dateTimeStr(futureDate(1), '11:00'),
    paymentMethod: 'CASH',
  });
  roomService.checkIn(booking1.id);
  roomService.checkOut(booking1.id, 'CASH');
  // New guest checks IN on futureDate(1) — same calendar date as checkout above
  assert.doesNotThrow(
    () => roomService.createBooking({
      roomId: room.id, guestName: 'Checkin Guest',
      checkInDate: dateTimeStr(futureDate(1), '14:00'),
      checkOutDate: dateTimeStr(futureDate(2), '11:00'),
      paymentMethod: 'CASH',
    }),
    'same-day turnover with datetime strings must be allowed (checkout date == checkin date at calendar-day level)'
  );
});

// ============================================================
console.log('\n== 6. Room View: group badges, search, hotel logo & A4 room invoice ==');
// ============================================================

test('getRoomCalendar flags a multi-room group booking with isGroupBooking/groupRoomCount/bookingGroupId, computed across the WHOLE group (not just the visible date window)', () => {
  roomService.saveRoom({ room_number: 'EDGE-GRP-1', room_type: 'Standard', base_price: 1000, max_occupancy: 2 });
  roomService.saveRoom({ room_number: 'EDGE-GRP-2', room_type: 'Standard', base_price: 1200, max_occupancy: 2 });
  const room1 = roomService.getRooms().find((r) => r.room_number === 'EDGE-GRP-1');
  const room2 = roomService.getRooms().find((r) => r.room_number === 'EDGE-GRP-2');
  roomService.createBooking({
    guestName: 'Group Badge Guest',
    guestPhone: '9998887771',
    paymentMethod: 'CASH',
    rooms: [
      { roomId: room1.id, checkInDate: futureDate(2), checkOutDate: futureDate(4) },
      { roomId: room2.id, checkInDate: futureDate(2), checkOutDate: futureDate(4) },
    ],
  });
  const calendar = roomService.getRoomCalendar({ from: futureDate(2), to: futureDate(4) });
  const room1Entry = calendar.find((r) => r.room_number === 'EDGE-GRP-1');
  assert.ok(room1Entry, 'the calendar should include the room');
  const grp1Booking = room1Entry.bookings[0];
  assert.ok(grp1Booking, 'the new booking should appear in the room calendar for its date window');
  assert.strictEqual(grp1Booking.isGroupBooking, true, 'a 2-room booking must be flagged isGroupBooking');
  assert.strictEqual(grp1Booking.groupRoomCount, 2, 'groupRoomCount must reflect all rooms in the group, not just ones in the visible window');
  assert.ok(grp1Booking.bookingGroupId, 'bookingGroupId must be present so the frontend can fetch sibling rooms');
});

test('listBookings search matches guest name, phone, booking number, AND a joined bill number (case-insensitive)', () => {
  roomService.saveRoom({ room_number: 'EDGE-SEARCH', room_type: 'Standard', base_price: 1500, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'EDGE-SEARCH');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Search Target Guest', guestPhone: '9123456780', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH' });
  roomService.checkIn(booking.id);
  const { bill } = roomService.checkOut(booking.id, 'CASH');

  const byName = roomService.listBookings({ search: 'search target' });
  assert.ok(byName.some((b) => b.id === booking.id), 'search should match on guest name (case-insensitive substring)');

  const byPhone = roomService.listBookings({ search: '9123456780' });
  assert.ok(byPhone.some((b) => b.id === booking.id), 'search should match on guest phone');

  const byBookingNo = roomService.listBookings({ search: booking.bookingNumber || booking.booking_number });
  assert.ok(byBookingNo.some((b) => b.id === booking.id), 'search should match on booking number');

  const byBillNo = roomService.listBookings({ search: bill.bill_number });
  assert.ok(byBillNo.some((b) => b.id === booking.id), 'search should match via the joined bill number (EXISTS subquery)');

  const noMatch = roomService.listBookings({ search: 'zzz-no-such-guest-zzz' });
  assert.ok(!noMatch.some((b) => b.id === booking.id), 'an unrelated search term should not match');
});

test('Hotel logo set in Settings is snapshotted onto a new ROOM bill (hotelLogo), and is ALWAYS empty for FOOD bills regardless of the setting', () => {
  service.saveSettings({ room_biz_logo_path: 'C:\\fake\\logo.png' });
  roomService.saveRoom({ room_number: 'EDGE-LOGO', room_type: 'Standard', base_price: 1000, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'EDGE-LOGO');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Logo Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH' });
  const { bill: roomBill } = roomService.checkOut(booking.id, 'CASH');
  const fullRoomBill = service.getBillById(roomBill.id);
  assert.strictEqual(fullRoomBill.hotelLogo, 'C:\\fake\\logo.png', 'a ROOM bill created after the logo was set must carry it as hotelLogo');

  const foodBill = service.createBill({ items: [{ name: 'Logo Test Food Item', price: 100, quantity: 1 }], paymentMethod: 'CASH', taxPercent: 0 });
  const fullFoodBill = service.getBillById(foodBill.id);
  assert.strictEqual(fullFoodBill.hotelLogo, '', 'a FOOD bill must never show a hotel logo, even if room_biz_logo_path is set');
  service.saveSettings({ room_biz_logo_path: '' });
});

test('getBillById on a ROOM bill includes full stay/guest details (room number, type, check-in/out, guest phone) for the A4 room invoice', () => {
  roomService.saveRoom({ room_number: 'EDGE-STAY-DETAILS', room_type: 'Deluxe', base_price: 2000, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'EDGE-STAY-DETAILS');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Stay Details Guest', guestPhone: '9112233445', checkInDate: futureDate(0), checkOutDate: futureDate(2), paymentMethod: 'CASH' });
  const { bill } = roomService.checkOut(booking.id, 'CASH');
  const fullBill = service.getBillById(bill.id);
  assert.strictEqual(fullBill.roomNumber, 'EDGE-STAY-DETAILS', 'A4 invoice needs the room number on the bill');
  assert.strictEqual(fullBill.roomType, 'Deluxe', 'A4 invoice needs the room type on the bill');
  assert.strictEqual(fullBill.guestPhone, '9112233445', 'A4 invoice needs the guest phone on the bill');
  assert.strictEqual(fullBill.checkInDate, futureDate(0), 'A4 invoice needs the check-in date on the bill');
  assert.strictEqual(fullBill.checkOutDate, futureDate(2), 'A4 invoice needs the check-out date on the bill');
});

test('getGroupInvoiceData carries hotelLogo plus per-room guest/stay details for the combined A4 group invoice', () => {
  service.saveSettings({ room_biz_logo_path: 'C:\\fake\\group-logo.png' });
  roomService.saveRoom({ room_number: 'EDGE-GRPINV-1', room_type: 'Standard', base_price: 1000, max_occupancy: 2 });
  roomService.saveRoom({ room_number: 'EDGE-GRPINV-2', room_type: 'Standard', base_price: 1000, max_occupancy: 2 });
  const r1 = roomService.getRooms().find((r) => r.room_number === 'EDGE-GRPINV-1');
  const r2 = roomService.getRooms().find((r) => r.room_number === 'EDGE-GRPINV-2');
  const bookings = roomService.createBooking({
    guestName: 'Group Invoice Guest',
    guestPhone: '9001122334',
    paymentMethod: 'CASH',
    rooms: [
      { roomId: r1.id, checkInDate: futureDate(0), checkOutDate: futureDate(1) },
      { roomId: r2.id, checkInDate: futureDate(0), checkOutDate: futureDate(1) },
    ],
  });
  const groupId = bookings[0].bookingGroupId;
  for (const b of bookings) {
    roomService.checkIn(b.id);
    roomService.checkOut(b.id, 'CASH');
  }
  const invoice = roomService.getGroupInvoiceData(groupId);
  assert.strictEqual(invoice.hotelLogo, 'C:\\fake\\group-logo.png', 'combined group invoice must carry the hotel logo');
  assert.strictEqual(invoice.rooms.length, 2, 'both rooms should be present in the combined invoice');
  assert.ok(invoice.rooms.every((r) => r.checkInDate && r.checkOutDate), 'every room in the combined invoice must carry its own check-in/out dates');
  assert.ok(invoice.rooms.every((r) => r.guestName), 'every room in the combined invoice must carry its own guest name');
  service.saveSettings({ room_biz_logo_path: '' });
});

// ============================================================
console.log('\n== 7. Session-discovered bugs: DB datetime format, group invoice gate, advance cap ==');
// ============================================================
// These tests cover the exact failure modes found during live testing in the
// Sep 2026 session — scenarios that slipped through because the old test suite
// only tested happy paths with consistent datetime formats and single-room bookings.

test('SQLite datetime format mismatch: booking stored with space separator ("YYYY-MM-DD HH:mm") must NOT block a new booking stored with T separator ("YYYY-MM-DDTHH:mm") for the same same-day-turnover', () => {
  // The root cause: SQLite raw string comparison treats space (0x20) as
  // alphabetically BEFORE 'T' (0x54), so  "2026-09-15 00:00" >= "2026-09-15T11:00"
  // returned FALSE — a plain-date checkout looked like it was STILL OCCUPYING
  // the room to a T-format checkin on the same calendar day.
  // Fix: assertRoomAvailable now uses date(check_out_date) and date(check_in_date)
  // which strips any time component before comparison.
  roomService.saveRoom({ room_number: 'EDGE-DTFMT', room_type: 'Standard', base_price: 1000, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'EDGE-DTFMT');

  // Simulate a booking whose checkout was stored with the OLD space separator
  // (as produced by seed scripts and some older code paths) — directly INSERT
  // via getDb() to bypass createBooking's normalisation, so we can set the
  // checkout date with a space separator exactly as the legacy format stored it.
  const spaceCheckOut = `${futureDate(1)} 11:00`;  // space separator — old format
  getDb().prepare(`
    INSERT INTO room_bookings
      (booking_number, room_id, booking_group_id, guest_name, check_in_date, check_out_date,
       room_rate, tax_percent, payment_method, advance_payment, advance_applied, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'CHECKED_OUT')
  `).run(
    'EDGE-DTFMT-OLD-BKG', room.id, 'GRPFMT01', 'Space Format Guest',
    `${futureDate(0)}T14:00`, spaceCheckOut,
    1000, 0, 'CASH', 0, 0
  );

  // Now try to create a NEW booking that starts on futureDate(1) — same
  // calendar day as the old booking's checkout. With the date() fix this
  // MUST succeed; without it, the space-format checkout was treated as still
  // ongoing and blocked the new checkin with a false conflict error.
  assert.doesNotThrow(
    () => roomService.createBooking({
      roomId: room.id, guestName: 'T-Format New Guest',
      checkInDate: `${futureDate(1)}T14:00`,
      checkOutDate: `${futureDate(2)}T11:00`,
      paymentMethod: 'CASH',
    }),
    'a new booking starting on the SAME calendar day as an existing checkout stored with a space separator must not be blocked (date() strips format differences)'
  );
});

test('Combined invoice gate: button only shown when EVERY room in the group is CHECKED_OUT (not just some of them)', () => {
  // The old bug: `g.status === "CHECKED_OUT"` collapsed the group's status
  // only if the first room happened to be out — a partially-checked-out group
  // could still show the button. Fixed to `g.rooms.every(r => r.status === "CHECKED_OUT")`.
  // At the SERVICE level: getGroupInvoiceData throws if any room is still pending.
  roomService.saveRoom({ room_number: 'EDGE-GI-A', room_type: 'Standard', base_price: 1000, max_occupancy: 2 });
  roomService.saveRoom({ room_number: 'EDGE-GI-B', room_type: 'Standard', base_price: 1000, max_occupancy: 2 });
  const rA = roomService.getRooms().find((r) => r.room_number === 'EDGE-GI-A');
  const rB = roomService.getRooms().find((r) => r.room_number === 'EDGE-GI-B');

  const bookings = roomService.createBooking({
    guestName: 'Group Gate Guest', guestPhone: '9000000001',
    paymentMethod: 'CASH',
    rooms: [
      { roomId: rA.id, checkInDate: futureDate(0), checkOutDate: futureDate(1) },
      { roomId: rB.id, checkInDate: futureDate(0), checkOutDate: futureDate(1) },
    ],
  });
  const groupId = bookings[0].bookingGroupId;

  // Check out only room A — group is NOT fully done yet
  roomService.checkIn(bookings[0].id);
  roomService.checkOut(bookings[0].id, 'CASH');

  // getGroupInvoiceData should THROW because room B is still BOOKED
  assert.throws(
    () => roomService.getGroupInvoiceData(groupId),
    /not been checked out|Room EDGE-GI-B/i,
    'getGroupInvoiceData must throw a clear error when any room in the group is still pending checkout'
  );

  // Now check out room B too — the invoice should succeed
  roomService.checkIn(bookings[1].id);
  roomService.checkOut(bookings[1].id, 'CASH');
  assert.doesNotThrow(
    () => roomService.getGroupInvoiceData(groupId),
    'getGroupInvoiceData must succeed once ALL rooms in the group are checked out'
  );
});

test('Advance payment cap: advance stored at booking time larger than final room charge — checkOut never produces a negative bill total or balance_due', () => {
  // This covers the scenario shown in the screenshot where the booking list
  // displayed "-₹3,200.00" and "-₹6,400.00" — the advance applied exceeded
  // the room charge and pushed the bill total into negative territory.
  roomService.saveRoom({ room_number: 'EDGE-ADVNEG', room_type: 'Standard', base_price: 800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'EDGE-ADVNEG');
  // Room rate ₹800, 1 night = ₹800 total charge.  Advance stored as ₹5,000.
  const booking = roomService.createBooking({
    roomId: room.id, guestName: 'Big Advance Guest',
    checkInDate: futureDate(0), checkOutDate: futureDate(1),
    paymentMethod: 'CASH', advancePayment: 5000, taxPercent: 0,
  });
  const { bill } = roomService.checkOut(booking.id, 'CASH');
  assert.ok(bill.total >= 0,        `bill.total must never be negative (got ${bill.total})`);
  assert.ok(bill.balanceDue >= 0,   `bill.balanceDue must never be negative (got ${bill.balanceDue})`);
  assert.ok(bill.advancePayment >= 0, `bill.advancePayment must never be negative (got ${bill.advancePayment})`);
  approx(bill.total, 800, 'bill total must be the full room charge (800)');
  approx(bill.advancePayment, 800, 'advance applied must be capped at the room charge (800), not the full 5000');
  approx(bill.balanceDue, 0, 'balance due must be ₹0 when advance >= total');
});

test('Discount + advance sum cap: when both discount and advance are set, combined they cannot push the bill total or balanceDue negative', () => {
  // Scenario: rate ₹2,000 × 1 night, discount ₹1,500, advance ₹1,500.
  // • bill.total     = 2000 − 1500 = ₹500  (total after manual discount)
  // • advanceApplied = min(₹1,500, ₹500) = ₹500  (capped at remaining charge)
  // • balanceDue     = 500 − 500 = ₹0
  // None of these should go negative regardless of the advance size.
  roomService.saveRoom({ room_number: 'EDGE-DISCADV', room_type: 'Deluxe', base_price: 2000, max_occupancy: 3 });
  const room = roomService.getRooms().find((r) => r.room_number === 'EDGE-DISCADV');
  const booking = roomService.createBooking({
    roomId: room.id, guestName: 'Discount Advance Guest',
    checkInDate: futureDate(0), checkOutDate: futureDate(1),
    paymentMethod: 'CASH', advancePayment: 1500, discount: 1500, taxPercent: 0,
  });
  const { bill } = roomService.checkOut(booking.id, 'CASH');
  assert.ok(bill.total >= 0,        `bill.total must never be negative (got ${bill.total})`);
  assert.ok(bill.balanceDue >= 0,   `bill.balanceDue must never be negative (got ${bill.balanceDue})`);
  assert.ok(bill.advancePayment >= 0, `bill.advancePayment must never be negative (got ${bill.advancePayment})`);
  approx(bill.total, 500, 'bill total must be rate(2000) − discount(1500) = ₹500');
  approx(bill.advancePayment, 500, 'advance applied must be capped at the remaining charge (500), not the full stored advance (1500)');
  approx(bill.balanceDue, 0, 'balanceDue must be ₹0 when advance absorbs the remaining charge');
});

console.log(`\n${'='.repeat(60)}`);
console.log(`RESULT: ${passed} passed, ${failed} failed (of ${passed + failed} total)`);
console.log('='.repeat(60));
if (verdicts.length) {
  console.log('\nFailure verdicts (human-reviewable — BUG = worth fixing, ACCEPTED = known/intentional limitation):');
  for (const v of verdicts) {
    console.log(`  [${v.verdict}] ${v.name}`);
    console.log(`      -> ${v.reason}`);
  }
}
process.exitCode = failures.filter((f) => verdicts.find((v) => v.name === f.name)?.verdict === 'BUG').length > 0 ? 1 : 0;
