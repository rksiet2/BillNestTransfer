// Automated regression test suite for BillNest's core business logic
// (billing math, source separation, room booking lifecycle, PIN auth rules).
//
// Runs against a throwaway SQLite DB in a temp folder — never touches your
// real data. Safe to run any time with: npm run test:regression
//
// This complements TEST-PLAN.md (which covers UI/visual checks a script
// can't verify) by automating everything that IS deterministic and
// script-checkable: money math, filters, and access-control rules.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billnest-regression-'));

const { initDatabase } = require('../db/database.cjs');
initDatabase(tmpDir);

const service = require('../db/service.cjs');
const roomService = require('../db/roomService.cjs');
const userService = require('../db/userService.cjs');

let passed = 0;
let failed = 0;
const failures = [];

// Supports both sync test bodies (used everywhere below) and async ones (used
// by the integration-engine tests in section 7, which call `await` internally).
// For an async fn, this RETURNS a promise the caller must `await` so pass/fail
// is recorded and logged before the script moves on — see the async IIFE
// wrapping section 7 at the bottom of this file.
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++;
        console.log(`  ✅ ${name}`);
      }).catch((err) => {
        failed++;
        failures.push({ name, err });
        console.log(`  ❌ ${name}`);
        console.log(`     ${err.message}`);
      });
    }
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
  return undefined;
}

function approx(a, b, msg) {
  assert.ok(Math.abs(a - b) < 0.005, `${msg}: expected ${b}, got ${a}`);
}

console.log('\n== 1. Food billing math ==');

test('createBill computes subtotal/tax/total correctly (no discount)', () => {
  const bill = service.createBill({
    items: [
      { name: 'Butter Chicken', price: 320, quantity: 2 },
      { name: 'Butter Naan', price: 45, quantity: 3 },
    ],
    paymentMethod: 'CASH',
    customerName: 'Test Guest',
    taxPercent: 5,
    source: 'FOOD',
  });
  approx(bill.subtotal, 775, 'subtotal'); // 320*2 + 45*3 = 640+135
  approx(bill.taxAmount, 38.75, 'taxAmount'); // 775 * 5%
  approx(bill.total, 813.75, 'total');
});

test('createBill applies discount correctly', () => {
  const bill = service.createBill({
    items: [{ name: 'Paneer Tikka', price: 250, quantity: 1 }],
    paymentMethod: 'ONLINE',
    taxPercent: 10,
    discount: 25,
    source: 'FOOD',
  });
  approx(bill.subtotal, 250, 'subtotal');
  approx(bill.taxAmount, 25, 'taxAmount');
  approx(bill.total, 250 + 25 - 25, 'total (discount applied after tax)');
});

test('createBill rejects an empty cart', () => {
  assert.throws(() => service.createBill({ items: [], paymentMethod: 'CASH' }), /at least one item/i);
});

test('Cash vs Online bills are tallied separately in getSummary', () => {
  service.createBill({ items: [{ name: 'Dal Makhani', price: 200, quantity: 1 }], paymentMethod: 'CASH', taxPercent: 0, source: 'FOOD' });
  service.createBill({ items: [{ name: 'Dal Makhani', price: 200, quantity: 1 }], paymentMethod: 'ONLINE', taxPercent: 0, source: 'FOOD' });
  const summary = service.getSummary('all');
  assert.ok(summary.cashRevenue >= 200, 'cashRevenue should include the cash bill');
  assert.ok(summary.onlineRevenue >= 200, 'onlineRevenue should include the online bill');
});

test('Quick picks rank available food by completed sales and ignore cancelled bills', () => {
  const food = service.getFoodItems()[0];
  service.createBill({
    items: [{ id: food.id, name: food.name, price: food.price, quantity: 2 }],
    paymentMethod: 'CASH',
    source: 'FOOD',
  });
  const cancelled = service.createBill({
    items: [{ id: food.id, name: food.name, price: food.price, quantity: 20 }],
    paymentMethod: 'CASH',
    source: 'FOOD',
  });
  service.cancelBill(cancelled.id, 'exclude from best sellers');
  const popular = service.getPopularFood(1);
  assert.strictEqual(popular[0].id, food.id, 'the sold food should rank first');
  assert.strictEqual(popular[0].units_sold, 2, 'cancelled quantities should not count');
});

console.log('\n== 2. Cancellation exclusion ==');

test('Cancelled bills are excluded from revenue totals', () => {
  const before = service.getSummary('all');
  const bill = service.createBill({
    items: [{ name: 'Chicken 65', price: 999, quantity: 1 }],
    paymentMethod: 'CASH',
    taxPercent: 0,
    source: 'FOOD',
  });
  const afterCreate = service.getSummary('all');
  approx(afterCreate.revenue, before.revenue + 999, 'revenue should increase by the new bill');

  service.cancelBill(bill.id, 'Test cancellation');
  const afterCancel = service.getSummary('all');
  approx(afterCancel.revenue, before.revenue, 'revenue should revert after cancellation');
  assert.strictEqual(afterCancel.cancelledCount, before.cancelledCount + 1, 'cancelledCount should increment');
});

console.log('\n== 3. Food vs Hotel(Room) source separation ==');

test('Room booking checkout is tagged source=ROOM, not FOOD', () => {
  roomService.saveRoom({ room_number: 'TEST-101', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const rooms = roomService.getRooms();
  const room = rooms.find((r) => r.room_number === 'TEST-101');

  const today = new Date();
  const checkIn = today.toISOString().slice(0, 10);
  const checkOutDate = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);

  const booking = roomService.createBooking({
    roomId: room.id,
    guestName: 'GST Test Guest',
    checkInDate: checkIn,
    checkOutDate: checkOutDate,
    paymentMethod: 'CASH',
    taxPercent: 12,
  });

  const beforeFood = service.getSummary({ period: 'all', source: 'FOOD' });
  const beforeRoom = service.getSummary({ period: 'all', source: 'ROOM' });

  const { bill } = roomService.checkOut(booking.id);

  approx(bill.subtotal, 1800, 'room booking subtotal should be exactly one night at 1800, not corrupted');
  approx(bill.taxAmount, 216, 'room booking tax (12% of 1800)');
  approx(bill.total, 2016, 'room booking total');

  const afterFood = service.getSummary({ period: 'all', source: 'FOOD' });
  const afterRoom = service.getSummary({ period: 'all', source: 'ROOM' });

  approx(afterFood.revenue, beforeFood.revenue, 'FOOD revenue must be unaffected by a ROOM checkout');
  approx(afterRoom.revenue, beforeRoom.revenue + 2016, 'ROOM revenue must include the checkout bill');
});

test('getSummary("both"/no source) equals FOOD + ROOM split', () => {
  const food = service.getSummary({ period: 'all', source: 'FOOD' });
  const room = service.getSummary({ period: 'all', source: 'ROOM' });
  const both = service.getSummary({ period: 'all' });
  approx(both.revenue, food.revenue + room.revenue, 'combined revenue should equal FOOD + ROOM');
});

test('getBills source filter returns only matching rows', () => {
  const foodBills = service.getBills({ source: 'FOOD' });
  const roomBills = service.getBills({ source: 'ROOM' });
  assert.ok(foodBills.every((b) => b.source === 'FOOD'), 'all FOOD-filtered bills must have source=FOOD');
  assert.ok(roomBills.every((b) => b.source === 'ROOM'), 'all ROOM-filtered bills must have source=ROOM');
});

console.log('\n== 4. Room booking lifecycle & availability ==');

test('Cannot double-book an overlapping date range for the same room', () => {
  const rooms = roomService.getRooms();
  const room = rooms.find((r) => r.room_number === 'TEST-101');
  const today = new Date();
  const checkIn = new Date(today.getTime() + 5 * 86400000).toISOString().slice(0, 10);
  const checkOutDate = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);

  roomService.createBooking({ roomId: room.id, guestName: 'Guest A', checkInDate: checkIn, checkOutDate, paymentMethod: 'CASH' });
  assert.throws(
    () => roomService.createBooking({ roomId: room.id, guestName: 'Guest B', checkInDate: checkIn, checkOutDate, paymentMethod: 'CASH' }),
    /available|booked|conflict/i
  );
});

test('checkOut requires a payment method to be set', () => {
  const rooms = roomService.getRooms();
  const room = rooms.find((r) => r.room_number === 'TEST-101');
  const today = new Date();
  // Check-in date must be today (not the future) so this test actually
  // exercises the "payment method required" guard rather than tripping the
  // separate future-date guard added for the check-in/checkout lifecycle.
  const checkIn = today.toISOString().slice(0, 10);
  const checkOutDate = new Date(today.getTime() + 1 * 86400000).toISOString().slice(0, 10);
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'No Payment Guest', checkInDate: checkIn, checkOutDate });
  assert.throws(() => roomService.checkOut(booking.id), /payment method/i);
});

test('Cancelled booking is excluded from ROOM revenue (never billed)', () => {
  const rooms = roomService.getRooms();
  const room = rooms.find((r) => r.room_number === 'TEST-101');
  const today = new Date();
  const checkIn = new Date(today.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const checkOutDate = new Date(today.getTime() + 31 * 86400000).toISOString().slice(0, 10);
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Cancel Guest', checkInDate: checkIn, checkOutDate, paymentMethod: 'CASH' });
  roomService.cancelBooking(booking.id, 'Test cancel');
  const b = roomService.getBookingById(booking.id);
  assert.strictEqual(b.status, 'CANCELLED');
  assert.strictEqual(b.billId, null, 'a cancelled booking must never have a bill attached');
});

test('Multi-room booking shares one booking_group_id and links all guest contacts', () => {
  roomService.saveRoom({ room_number: 'TEST-MULTI-1', room_type: 'Standard', base_price: 1500, max_occupancy: 2 });
  roomService.saveRoom({ room_number: 'TEST-MULTI-2', room_type: 'Deluxe', base_price: 2500, max_occupancy: 3 });
  const rooms = roomService.getRooms();
  const r1 = rooms.find((r) => r.room_number === 'TEST-MULTI-1');
  const r2 = rooms.find((r) => r.room_number === 'TEST-MULTI-2');
  const today = new Date();
  const checkIn = new Date(today.getTime() + 40 * 86400000).toISOString().slice(0, 10);
  const checkOutDate = new Date(today.getTime() + 42 * 86400000).toISOString().slice(0, 10);

  const result = roomService.createBooking({
    checkInDate: checkIn,
    checkOutDate,
    rooms: [{ roomId: r1.id, roomRate: 1500, numGuests: 2 }, { roomId: r2.id, roomRate: 2500, numGuests: 3 }],
    contacts: [{ name: 'Primary Guest', phone: '9999900001' }, { name: 'Second Guest', phone: '9999900002' }],
    paymentMethod: 'CASH',
  });

  assert.ok(Array.isArray(result), 'createBooking should return an array when multiple rooms are booked in one submission');
  assert.strictEqual(result.length, 2, 'both rooms should be booked');
  assert.strictEqual(result[0].bookingGroupId, result[1].bookingGroupId, 'all rooms in one submission must share the same booking_group_id');
  assert.strictEqual(result[0].contacts.length, 2, 'both guest contacts should be linked to the shared booking group');
});

test('A failing room in a multi-room booking rolls back ALL rooms in that submission (no partial booking)', () => {
  roomService.saveRoom({ room_number: 'TEST-ATOMIC-OK', room_type: 'Standard', base_price: 1600, max_occupancy: 2 });
  roomService.saveRoom({ room_number: 'TEST-ATOMIC-MAINT', room_type: 'Standard', base_price: 1600, max_occupancy: 2, status: 'MAINTENANCE' });
  const rooms = roomService.getRooms();
  const okRoom = rooms.find((r) => r.room_number === 'TEST-ATOMIC-OK');
  const maintRoom = rooms.find((r) => r.room_number === 'TEST-ATOMIC-MAINT');
  const today = new Date();
  const checkIn = new Date(today.getTime() + 50 * 86400000).toISOString().slice(0, 10);
  const checkOutDate = new Date(today.getTime() + 51 * 86400000).toISOString().slice(0, 10);

  assert.throws(
    () => roomService.createBooking({
      checkInDate: checkIn,
      checkOutDate,
      // okRoom is processed FIRST (would succeed on its own) — maintRoom
      // (processed second) is under maintenance and must fail. Without a DB
      // transaction wrapping the whole loop, okRoom would stay booked even
      // though the user sees an error for the whole submission.
      rooms: [{ roomId: okRoom.id, roomRate: 1600 }, { roomId: maintRoom.id, roomRate: 1600 }],
      contacts: [{ name: 'Atomic Test Guest', phone: '9999900003' }],
      paymentMethod: 'CASH',
    }),
    /maintenance/i
  );

  const availability = roomService.getRoomAvailability({ from: checkIn, to: checkOutDate });
  const okRoomStatus = availability.find((r) => r.room_number === 'TEST-ATOMIC-OK');
  assert.strictEqual(okRoomStatus.isAvailable, true, 'room processed before the failing one must be rolled back and remain available, not left booked in the background');
});

test('A failing room in a multi-room booking is also rejected for an already-booked (not just maintenance) conflict, with full rollback', () => {
  roomService.saveRoom({ room_number: 'TEST-ATOMIC-OK-2', room_type: 'Standard', base_price: 1700, max_occupancy: 2 });
  roomService.saveRoom({ room_number: 'TEST-ATOMIC-TAKEN', room_type: 'Standard', base_price: 1700, max_occupancy: 2 });
  const rooms = roomService.getRooms();
  const okRoom = rooms.find((r) => r.room_number === 'TEST-ATOMIC-OK-2');
  const takenRoom = rooms.find((r) => r.room_number === 'TEST-ATOMIC-TAKEN');
  const today = new Date();
  const checkIn = new Date(today.getTime() + 60 * 86400000).toISOString().slice(0, 10);
  const checkOutDate = new Date(today.getTime() + 61 * 86400000).toISOString().slice(0, 10);

  // Pre-book takenRoom so the multi-room submission below must fail on it.
  roomService.createBooking({ roomId: takenRoom.id, guestName: 'Existing Guest', checkInDate: checkIn, checkOutDate, paymentMethod: 'CASH' });

  assert.throws(
    () => roomService.createBooking({
      checkInDate: checkIn,
      checkOutDate,
      rooms: [{ roomId: okRoom.id, roomRate: 1700 }, { roomId: takenRoom.id, roomRate: 1700 }],
      contacts: [{ name: 'Atomic Test Guest 2', phone: '9999900004' }],
      paymentMethod: 'CASH',
    }),
    /available/i
  );

  const availability = roomService.getRoomAvailability({ from: checkIn, to: checkOutDate });
  const okRoomStatus = availability.find((r) => r.room_number === 'TEST-ATOMIC-OK-2');
  assert.strictEqual(okRoomStatus.isAvailable, true, 'the other room in the failed submission must be rolled back and remain available');
});

console.log('\n== 5. Owner / Staff PIN auth rules ==');

test('No owner account exists initially', () => {
  assert.strictEqual(userService.hasOwnerAccount(), false);
});

test('Owner account can be created exactly once', () => {
  const owner = userService.createOwnerAccount({ name: 'Test Owner', pin: '1234' });
  assert.strictEqual(owner.role, 'OWNER');
  assert.strictEqual(userService.hasOwnerAccount(), true);
  assert.throws(() => userService.createOwnerAccount({ name: 'Second Owner', pin: '5678' }), /already exists/i);
});

test('PIN must be 4-6 digits (rejects short/long/non-numeric)', () => {
  assert.throws(() => userService.createStaffAccount({ name: 'Bad PIN', pin: '12' }), /4 to 6 digits/i);
  assert.throws(() => userService.createStaffAccount({ name: 'Bad PIN', pin: '1234567' }), /4 to 6 digits/i);
  assert.throws(() => userService.createStaffAccount({ name: 'Bad PIN', pin: 'abcd' }), /4 to 6 digits/i);
});

test('Staff account can log in with correct PIN, not with wrong PIN', () => {
  userService.createStaffAccount({ name: 'Staff One', pin: '4321' });
  const loggedIn = userService.loginWithPin('4321');
  assert.ok(loggedIn, 'should log in with correct PIN');
  assert.strictEqual(loggedIn.role, 'STAFF');
  const failedLogin = userService.loginWithPin('9999');
  assert.strictEqual(failedLogin, null, 'wrong PIN must not log in');
});

test('Owner login PIN still works alongside staff PIN', () => {
  const loggedIn = userService.loginWithPin('1234');
  assert.ok(loggedIn, 'owner PIN should still work');
  assert.strictEqual(loggedIn.role, 'OWNER');
});

test('Owner account cannot be deactivated', () => {
  const owner = userService.listUsers().find((u) => u.role === 'OWNER');
  assert.throws(() => userService.deactivateUser(owner.id), /cannot deactivate the owner/i);
});

test('Staff account can be deactivated and then can no longer log in', () => {
  const staff = userService.listUsers().find((u) => u.name === 'Staff One');
  userService.deactivateUser(staff.id);
  const loginAttempt = userService.loginWithPin('4321');
  assert.strictEqual(loginAttempt, null, 'deactivated staff PIN must stop working');
});

test('resetPin changes a user\'s PIN', () => {
  const staff2 = userService.createStaffAccount({ name: 'Staff Two', pin: '1111' });
  userService.resetPin(staff2.id, '2222');
  assert.strictEqual(userService.loginWithPin('1111'), null, 'old PIN must stop working after reset');
  const relogin = userService.loginWithPin('2222');
  assert.ok(relogin, 'new PIN must work after reset');
});

console.log('\n== 6. Expense tracking & Profit and Loss math ==');

test('recordExpense stores category/amount/payment method correctly', () => {
  const exp = service.recordExpense({ category: 'SALARY', paid_to: 'Ramesh (Chef)', amount: 15000, payment_method: 'CASH', notes: 'August salary' });
  assert.strictEqual(exp.category, 'SALARY');
  assert.strictEqual(exp.paid_to, 'Ramesh (Chef)');
  approx(exp.amount, 15000, 'expense amount');
  assert.strictEqual(exp.payment_method, 'CASH');
});

test('getExpenseSummary totals multiple expenses correctly, grouped by category', () => {
  const before = service.getExpenseSummary('all');
  service.recordExpense({ category: 'RENT', paid_to: 'Landlord', amount: 20000, payment_method: 'ONLINE' });
  service.recordExpense({ category: 'UTILITIES', paid_to: 'Electricity Board', amount: 3500, payment_method: 'CASH' });
  const after = service.getExpenseSummary('all');
  approx(after.totalSpend, before.totalSpend + 23500, 'totalSpend should increase by 20000+3500=23500');
  assert.strictEqual(after.expenseCount, before.expenseCount + 2, 'expenseCount should increase by 2');
  const rentRow = after.byCategory.find((c) => c.category === 'RENT');
  approx(rentRow.spend, 20000, 'RENT category total');
});

test('getProfitAndLoss = Revenue - Purchases - Expenses, with a worked example', () => {
  // Use a fresh throwaway period marker isn't possible (all tests share the
  // same 'all' period), so instead verify the *equation itself* holds against
  // whatever revenue/purchases/expenses exist at this point in the run —
  // this is the real correctness check (not tied to absolute totals which
  // depend on test execution order).
  const pnl = service.getProfitAndLoss('all');
  const sales = service.getSummary('all');
  const purchases = service.getPurchaseSummary('all');
  const expenses = service.getExpenseSummary('all');
  approx(pnl.revenue, sales.revenue, 'P&L revenue must match getSummary revenue exactly');
  approx(pnl.totalPurchases, purchases.totalSpend, 'P&L totalPurchases must match getPurchaseSummary');
  approx(pnl.totalExpenses, expenses.totalSpend, 'P&L totalExpenses must match getExpenseSummary');
  approx(pnl.netProfit, pnl.revenue - pnl.totalPurchases - pnl.totalExpenses, 'netProfit must equal revenue - purchases - expenses');
});

test('getProfitAndLoss worked example with known numbers (isolated raw material + expense)', () => {
  // Concrete numeric example a human can verify by hand:
  //   Food revenue added:      1 item, price 500, qty 1, tax 0%  => +500 revenue
  //   Purchase added:          10 units @ 30/unit               => +300 purchases
  //   Expense added:           MAINTENANCE                       => +150 expenses
  //   Expected netProfit delta = 500 - 300 - 150 = +50
  const before = service.getProfitAndLoss('all');

  service.createBill({ items: [{ name: 'Test P&L Item', price: 500, quantity: 1 }], paymentMethod: 'CASH', taxPercent: 0, source: 'FOOD' });

  const materialId = service.saveRawMaterial({ name: 'Test P&L Material', unit: 'kg' });
  service.recordPurchase({ raw_material_id: materialId, quantity: 10, cost_per_unit: 30, supplier: 'Test Supplier' });

  service.recordExpense({ category: 'MAINTENANCE', paid_to: 'AC Repair', amount: 150, payment_method: 'CASH' });

  const after = service.getProfitAndLoss('all');
  approx(after.revenue, before.revenue + 500, 'revenue should increase by exactly 500');
  approx(after.totalPurchases, before.totalPurchases + 300, 'purchases should increase by exactly 10*30=300');
  approx(after.totalExpenses, before.totalExpenses + 150, 'expenses should increase by exactly 150');
  approx(after.netProfit, before.netProfit + 50, 'netProfit should increase by exactly 500-300-150=50');
});

console.log('\n== 7. Booking lifecycle edge cases: check-in/checkout date guards, maintenance guard, cancel-with-refund, and Sales History integrity ==');

function futureDate(daysAhead) {
  return new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
}

test('Check-in is BLOCKED for a future-dated booking (check-in date not yet arrived)', () => {
  roomService.saveRoom({ room_number: 'TEST-EDGE-1', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-EDGE-1');
  const booking = roomService.createBooking({
    roomId: room.id, guestName: 'Future CheckIn Guest',
    checkInDate: futureDate(5), checkOutDate: futureDate(6), paymentMethod: 'CASH',
  });
  assert.throws(() => roomService.checkIn(booking.id), /future/i);
  assert.strictEqual(roomService.getBookingById(booking.id).status, 'BOOKED', 'status must stay BOOKED after the blocked attempt');
});

test('Check-in is ALLOWED for a same-day (today) booking', () => {
  roomService.saveRoom({ room_number: 'TEST-EDGE-2', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-EDGE-2');
  const booking = roomService.createBooking({
    roomId: room.id, guestName: 'Today Guest',
    checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH',
  });
  const checkedIn = roomService.checkIn(booking.id);
  assert.strictEqual(checkedIn.status, 'CHECKED_IN', 'same-day check-in must be allowed');
});

test('Check-in is BLOCKED when status is not BOOKED (already CHECKED_IN / CANCELLED / CHECKED_OUT)', () => {
  roomService.saveRoom({ room_number: 'TEST-EDGE-3', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-EDGE-3');
  const alreadyIn = roomService.createBooking({ roomId: room.id, guestName: 'Already In', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH' });
  roomService.checkIn(alreadyIn.id);
  assert.throws(() => roomService.checkIn(alreadyIn.id), /only a booked reservation/i);

  roomService.saveRoom({ room_number: 'TEST-EDGE-3B', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room2 = roomService.getRooms().find((r) => r.room_number === 'TEST-EDGE-3B');
  const cancelled = roomService.createBooking({ roomId: room2.id, guestName: 'Cancelled Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH' });
  roomService.cancelBooking(cancelled.id, 'test');
  assert.throws(() => roomService.checkIn(cancelled.id), /only a booked reservation/i);
});

test('Check-in is BLOCKED when the room was set to MAINTENANCE after the booking was made', () => {
  roomService.saveRoom({ room_number: 'TEST-EDGE-4', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-EDGE-4');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Maintenance Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH' });
  roomService.toggleRoomMaintenance(room.id, true);
  assert.throws(() => roomService.checkIn(booking.id), /maintenance/i);
  // Restore so it doesn't affect any later availability-based tests.
  roomService.toggleRoomMaintenance(room.id, false);
});

test('Checkout is BLOCKED for a future-dated booking, even directly from BOOKED (cannot skip check-in into the future)', () => {
  roomService.saveRoom({ room_number: 'TEST-EDGE-5', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-EDGE-5');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Future Checkout Guest', checkInDate: futureDate(3), checkOutDate: futureDate(4), paymentMethod: 'CASH' });
  assert.throws(() => roomService.checkOut(booking.id), /future/i);
  assert.strictEqual(roomService.getBookingById(booking.id).status, 'BOOKED', 'status must stay BOOKED after the blocked checkout attempt');
});

test('Checkout is BLOCKED on an already-cancelled or already-checked-out booking', () => {
  roomService.saveRoom({ room_number: 'TEST-EDGE-6', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-EDGE-6');
  const cancelled = roomService.createBooking({ roomId: room.id, guestName: 'Cancel then Checkout', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH' });
  roomService.cancelBooking(cancelled.id, 'test');
  assert.throws(() => roomService.checkOut(cancelled.id), /already checked out or cancelled/i);

  roomService.saveRoom({ room_number: 'TEST-EDGE-6B', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room2 = roomService.getRooms().find((r) => r.room_number === 'TEST-EDGE-6B');
  const done = roomService.createBooking({ roomId: room2.id, guestName: 'Double Checkout', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH' });
  roomService.checkOut(done.id);
  assert.throws(() => roomService.checkOut(done.id), /already checked out or cancelled/i);
});

test('Cancel is now ALLOWED for a CHECKED_IN guest (e.g. emergency/dislikes the room and leaves early)', () => {
  roomService.saveRoom({ room_number: 'TEST-EDGE-7', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-EDGE-7');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Early Leaver', checkInDate: futureDate(0), checkOutDate: futureDate(2), paymentMethod: 'CASH', advancePayment: 500 });
  roomService.checkIn(booking.id);
  const cancelled = roomService.cancelBooking(booking.id, 'Family emergency');
  assert.strictEqual(cancelled.status, 'CANCELLED');
  assert.strictEqual(cancelled.billId, null, 'a cancelled-while-checked-in stay must never generate a bill');
});

test('Cancel is BLOCKED on an already-cancelled or an already-checked-out booking', () => {
  roomService.saveRoom({ room_number: 'TEST-EDGE-8', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-EDGE-8');
  const cancelled = roomService.createBooking({ roomId: room.id, guestName: 'Twice Cancelled', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH' });
  roomService.cancelBooking(cancelled.id, 'first cancel');
  assert.throws(() => roomService.cancelBooking(cancelled.id, 'second cancel'), /already cancelled/i);

  roomService.saveRoom({ room_number: 'TEST-EDGE-8B', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room2 = roomService.getRooms().find((r) => r.room_number === 'TEST-EDGE-8B');
  const done = roomService.createBooking({ roomId: room2.id, guestName: 'Cancel after Checkout', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH' });
  roomService.checkOut(done.id);
  assert.throws(() => roomService.cancelBooking(done.id, 'too late'), /already been checked out/i);
});

console.log('\n== 8. Cancellation refund: amount rollback correctness & Sales History / cross-source integrity ==');

test('Cancelling with no explicit refund amount defaults to a FULL refund of the advance', () => {
  roomService.saveRoom({ room_number: 'TEST-REFUND-1', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-REFUND-1');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Full Refund Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH', advancePayment: 1000, advancePaymentMethod: 'CASH' });
  const cancelled = roomService.cancelBooking(booking.id, 'Guest changed mind');
  approx(cancelled.refundAmount, 1000, 'default refund should equal the full advance collected');
  assert.strictEqual(cancelled.refundMethod, 'CASH', 'default refund method should fall back to the advance payment method');
});

test('Cancelling with refund=0 forfeits the advance as a cancellation fee (refundAmount stored as 0, not null)', () => {
  roomService.saveRoom({ room_number: 'TEST-REFUND-2', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-REFUND-2');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Forfeit Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH', advancePayment: 800 });
  const cancelled = roomService.cancelBooking(booking.id, 'Non-refundable policy', 0);
  approx(cancelled.refundAmount, 0, 'refundAmount should be exactly 0 when forfeited');
  assert.strictEqual(cancelled.refundMethod, null, 'refundMethod should be null when nothing was actually refunded');
});

test('Cancelling with a partial refund stores exactly that amount', () => {
  roomService.saveRoom({ room_number: 'TEST-REFUND-3', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-REFUND-3');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Partial Refund Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH', advancePayment: 1000 });
  const cancelled = roomService.cancelBooking(booking.id, 'Partial policy', 400, 'ONLINE');
  approx(cancelled.refundAmount, 400, 'partial refund amount should be stored exactly');
  assert.strictEqual(cancelled.refundMethod, 'ONLINE', 'refund method should be whatever staff selected, not the original advance method');
});

test('Refund amount is CLAMPED to the advance actually collected — cannot refund more than was paid', () => {
  roomService.saveRoom({ room_number: 'TEST-REFUND-4', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-REFUND-4');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Overclaim Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH', advancePayment: 500 });
  const cancelled = roomService.cancelBooking(booking.id, 'Overclaim attempt', 999999);
  approx(cancelled.refundAmount, 500, 'refund must be clamped to the ₹500 advance, never exceed it');
});

test('Refund amount is CLAMPED to zero — a negative refund input cannot go below 0', () => {
  roomService.saveRoom({ room_number: 'TEST-REFUND-5', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-REFUND-5');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Negative Refund Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH', advancePayment: 500 });
  const cancelled = roomService.cancelBooking(booking.id, 'Negative attempt', -200);
  approx(cancelled.refundAmount, 0, 'refund must be clamped to 0, never negative');
});

test('Cancelling a booking with NO advance payment leaves refundAmount as null (refund is not applicable)', () => {
  roomService.saveRoom({ room_number: 'TEST-REFUND-6', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-REFUND-6');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'No Advance Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH' });
  const cancelled = roomService.cancelBooking(booking.id, 'no advance to refund');
  assert.strictEqual(cancelled.refundAmount, null, 'refundAmount should stay null when there was never an advance to refund');
});

test('A cancellation + refund NEVER creates a bill and NEVER touches ROOM revenue in Sales History/Reporting', () => {
  roomService.saveRoom({ room_number: 'TEST-REFUND-7', room_type: 'Standard', base_price: 2200, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-REFUND-7');
  const beforeRoom = service.getSummary({ period: 'all', source: 'ROOM' });
  const beforeFood = service.getSummary({ period: 'all', source: 'FOOD' });
  const beforeBillCount = service.getBills({ source: 'ROOM' }).length;

  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Revenue Isolation Guest', checkInDate: futureDate(0), checkOutDate: futureDate(3), paymentMethod: 'CASH', advancePayment: 1500 });
  roomService.checkIn(booking.id);
  roomService.cancelBooking(booking.id, 'Emergency', 1500); // full refund

  const afterRoom = service.getSummary({ period: 'all', source: 'ROOM' });
  const afterFood = service.getSummary({ period: 'all', source: 'FOOD' });
  const afterBillCount = service.getBills({ source: 'ROOM' }).length;

  approx(afterRoom.revenue, beforeRoom.revenue, 'ROOM revenue must be completely unchanged by a cancellation, refunded or not — no bill was ever generated');
  approx(afterFood.revenue, beforeFood.revenue, 'FOOD revenue must never be touched by a room booking cancellation (cross-source isolation)');
  assert.strictEqual(afterBillCount, beforeBillCount, 'no new bill row should exist in Sales History for a cancelled booking, refunded or not');
});

test('A checked-out booking (not cancelled) DOES correctly appear in ROOM revenue at the FULL bill total, with the advance tracked separately (not folded into discount)', () => {
  roomService.saveRoom({ room_number: 'TEST-REFUND-8', room_type: 'Standard', base_price: 2000, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-REFUND-8');
  const beforeRoom = service.getSummary({ period: 'all', source: 'ROOM' });
  const beforeAdvance = beforeRoom.advanceCollected ?? 0;

  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Real Checkout Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH', advancePayment: 500, taxPercent: 0 });
  const { bill } = roomService.checkOut(booking.id);
  // 1 night @ 2000. The ₹500 advance already paid is tracked as advance_payment/balanceDue,
  // NOT folded into discount — the bill total is the true full charge.
  approx(bill.subtotal, 2000, 'bill subtotal should be the full room charge');
  approx(bill.total, 2000, 'bill total should be the FULL room charge, not net of advance');
  approx(bill.advancePayment, 500, 'advance payment should be tracked separately on the bill');
  approx(bill.balanceDue, 1500, 'balance due should be total minus advance (2000 - 500)');

  const afterRoom = service.getSummary({ period: 'all', source: 'ROOM' });
  approx(afterRoom.revenue, beforeRoom.revenue + 2000, 'ROOM revenue should increase by the FULL bill total, not the post-advance-deduction net amount');
  approx((afterRoom.advanceCollected ?? 0) - beforeAdvance, 500, 'getSummary should also report the ₹500 advance collected for this bill');
});

test('Multi-room group: cancelling ONE room (with refund) does not affect the other rooms\' status, totals, or revenue', () => {
  roomService.saveRoom({ room_number: 'TEST-REFUND-GRP-1', room_type: 'Standard', base_price: 1600, max_occupancy: 2 });
  roomService.saveRoom({ room_number: 'TEST-REFUND-GRP-2', room_type: 'Deluxe', base_price: 2400, max_occupancy: 2 });
  const r1 = roomService.getRooms().find((r) => r.room_number === 'TEST-REFUND-GRP-1');
  const r2 = roomService.getRooms().find((r) => r.room_number === 'TEST-REFUND-GRP-2');

  const [b1, b2] = roomService.createBooking({
    checkInDate: futureDate(0), checkOutDate: futureDate(1),
    rooms: [{ roomId: r1.id, roomRate: 1600 }, { roomId: r2.id, roomRate: 2400 }],
    contacts: [{ name: 'Group Refund Guest', phone: '9999900099' }],
    paymentMethod: 'CASH',
    advancePayment: 1000,
  });

  roomService.cancelBooking(b1.id, 'Room 1 no longer needed', 1000);

  const b1After = roomService.getBookingById(b1.id);
  const b2After = roomService.getBookingById(b2.id);
  assert.strictEqual(b1After.status, 'CANCELLED');
  approx(b1After.refundAmount, 1000, 'cancelled room should record its refund');
  assert.strictEqual(b2After.status, 'BOOKED', 'the OTHER room in the same group must remain untouched (still BOOKED)');
  approx(b2After.advancePayment, 0, 'the other room never carried the advance in the first place (only room #1 of the group did) — must stay 0, not altered by the cancellation');

  // The still-active room can still be checked in/out normally and bill correctly.
  roomService.checkIn(b2.id);
  const { bill } = roomService.checkOut(b2.id, 'CASH');
  approx(bill.subtotal, 2400, 'the untouched room\'s own checkout must bill its own correct rate, unaffected by its sibling\'s cancellation');
});

test('getBookingById reflects refundAmount/refundMethod correctly for both refunded and non-refunded cancellations', () => {
  roomService.saveRoom({ room_number: 'TEST-REFUND-9', room_type: 'Standard', base_price: 1800, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-REFUND-9');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Reflection Check Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH', advancePayment: 700 });
  roomService.cancelBooking(booking.id, 'test reflection', 700, 'ONLINE');
  const fetched = roomService.getBookingById(booking.id);
  approx(fetched.refundAmount, 700, 'refundAmount must be readable via a fresh getBookingById fetch, not just the cancel() return value');
  assert.strictEqual(fetched.refundMethod, 'ONLINE');
  assert.strictEqual(fetched.status, 'CANCELLED');
});

console.log('\n== 9. Room-bill Token/Booking-No display fields + Group Invoice numbering ==');

test('A checked-out ROOM bill carries its own booking_number (matches the booking, not just an internal Bill No)', () => {
  roomService.saveRoom({ room_number: 'TEST-BOOKINGNO-1', room_type: 'Standard', base_price: 1500, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-BOOKINGNO-1');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Booking No Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH' });
  const { bill } = roomService.checkOut(booking.id);
  assert.strictEqual(bill.bookingNumber, booking.bookingNumber, 'the bill returned by checkOut should carry the booking\'s own booking_number');
  const fetched = service.getBillById(bill.id);
  assert.strictEqual(fetched.booking_number, booking.bookingNumber, 're-fetching the bill from the DB must also expose booking_number (not just the in-memory checkOut return value)');
});

test('A FOOD/counter bill has NO booking_number (a token/counter concept has no booking, and vice versa)', () => {
  const bill = service.createBill({ items: [{ name: 'Tea', price: 20, quantity: 1 }], paymentMethod: 'CASH', source: 'FOOD' });
  const fetched = service.getBillById(bill.id);
  assert.strictEqual(fetched.booking_number, null, 'a FOOD bill should never have a booking_number');
  assert.ok(fetched.token, 'a FOOD bill SHOULD still have a token (used for kitchen/counter calling — unlike ROOM bills)');
});

test('Multi-room group checkout: every room\'s bill shares ONE overall Group Invoice Number derived from the shared master booking number', () => {
  roomService.saveRoom({ room_number: 'TEST-GRPINV-1', room_type: 'Standard', base_price: 1200, max_occupancy: 2 });
  roomService.saveRoom({ room_number: 'TEST-GRPINV-2', room_type: 'Deluxe', base_price: 2200, max_occupancy: 2 });
  const r1 = roomService.getRooms().find((r) => r.room_number === 'TEST-GRPINV-1');
  const r2 = roomService.getRooms().find((r) => r.room_number === 'TEST-GRPINV-2');

  const [b1, b2] = roomService.createBooking({
    checkInDate: futureDate(0), checkOutDate: futureDate(1),
    rooms: [{ roomId: r1.id, roomRate: 1200 }, { roomId: r2.id, roomRate: 2200 }],
    contacts: [{ name: 'Group Invoice Guest', phone: '9999911111' }],
    paymentMethod: 'CASH',
  });
  // Room 2's booking_number is expected to be "<master>-R2" (see createBooking).
  assert.ok(b2.bookingNumber.endsWith('-R2'), 'the 2nd room in a group should get a "-R2" suffixed booking number sharing the master prefix');
  assert.strictEqual(b2.bookingNumber.replace(/-R\d+$/, ''), b1.bookingNumber, 'room 2\'s master prefix must match room 1\'s (bare) booking number');

  roomService.checkIn(b1.id);
  roomService.checkIn(b2.id);
  roomService.checkOut(b1.id, 'CASH');
  roomService.checkOut(b2.id, 'CASH');

  const groupId = roomService.getBookingById(b1.id).bookingGroupId;
  const invoice = roomService.getGroupInvoiceData(groupId);
  assert.strictEqual(invoice.rooms.length, 2, 'combined invoice should include both rooms');
  assert.ok(invoice.groupInvoiceNumber, 'the combined invoice must expose a single overall groupInvoiceNumber');
  assert.strictEqual(invoice.groupInvoiceNumber, `${b1.bookingNumber}-GRP`, 'the group invoice number should be derived from the shared master booking number, not either room\'s individual number');
});

test('Legacy repair: an old ROOM bill (advance folded into discount, no booking_number/biz_* snapshot) is correctly split and backfilled by the startup migration routines', () => {
  const { getDb } = require('../db/database.cjs');
  const database = require('../db/database.cjs');
  const db = getDb();

  roomService.saveRoom({ room_number: 'TEST-LEGACY-1', room_type: 'Standard', base_price: 2000, max_occupancy: 2 });
  const room = roomService.getRooms().find((r) => r.room_number === 'TEST-LEGACY-1');
  const booking = roomService.createBooking({ roomId: room.id, guestName: 'Legacy Guest', checkInDate: futureDate(0), checkOutDate: futureDate(1), paymentMethod: 'CASH' });

  // Hand-craft a pre-fix bill row exactly as the OLD (buggy) checkOut would
  // have produced it: subtotal 2000, no tax, a ₹500 advance folded straight
  // into `discount` (so total = 1500, advance_payment = 0), and no
  // booking_number / biz_* snapshot columns populated (simulating a bill
  // created before those columns/migrations existed).
  const info = db.prepare(`
    INSERT INTO bills (bill_number, token, payment_method, customer_name, subtotal, tax_percent, tax_amount, discount, advance_payment, balance_due, total, status, source)
    VALUES ('LEGACY-0001', 'B999', 'CASH', 'Legacy Guest', 2000, 0, 0, 500, 0, NULL, 1500, 'COMPLETED', 'ROOM')
  `).run();
  const legacyBillId = info.lastInsertRowid;
  db.prepare("UPDATE room_bookings SET status='CHECKED_OUT', bill_id=?, advance_applied=500 WHERE id=?").run(legacyBillId, booking.id);

  database.repairLegacyAdvanceBills();
  database.backfillBillBookingNumbers();
  database.backfillBillProfileSnapshots();

  const repaired = service.getBillById(legacyBillId);
  approx(repaired.discount, 0, 'legacy discount (500) minus the recovered advance (500) should now be 0 — pure manual discount only');
  approx(repaired.advance_payment, 500, 'the folded-in advance should now be split out into advance_payment');
  approx(repaired.total, 2000, 'total should be recomputed to the FULL charge (subtotal 2000 + tax 0 - new discount 0)');
  approx(repaired.balance_due, 1500, 'balance_due should be total (2000) minus advance (500)');
  assert.strictEqual(repaired.booking_number, booking.bookingNumber, 'booking_number should be backfilled from the linked room_bookings row');
  assert.ok(repaired.biz_name, 'biz_name (and the other biz_* snapshot columns) should be backfilled from current Settings for this old, pre-snapshot bill');

  // Idempotency: running the same three migration routines again must be a
  // no-op (must NOT re-apply the advance a second time, e.g. discount going
  // negative or advance_payment doubling).
  database.repairLegacyAdvanceBills();
  database.backfillBillBookingNumbers();
  database.backfillBillProfileSnapshots();
  const repairedAgain = service.getBillById(legacyBillId);
  approx(repairedAgain.discount, 0, 'idempotency: discount must stay 0, not go negative on a 2nd run');
  approx(repairedAgain.advance_payment, 500, 'idempotency: advance_payment must stay 500, not double on a 2nd run');
  approx(repairedAgain.total, 2000, 'idempotency: total must stay 2000 on a 2nd run');
});

// Section 9 uses `await` (accept/reject are async), so it's wrapped in an
// async IIFE — everything above this point already ran synchronously and
// finished logging before this starts.
(async () => {
  console.log('\n== 10. Zomato/Swiggy/MMT integration polling engine (framework, no real API yet) ==');

  const integrations = require('../electron/integrations/pollingService.cjs');

  test('simulateTestOrder adds a food order to the incoming queue and it is retrievable', () => {
    const before = integrations.listIncoming().length;
    const order = integrations.simulateTestOrder('ZOMATO');
    assert.strictEqual(order.platform, 'ZOMATO');
    assert.strictEqual(order.kind, 'FOOD_ORDER');
    assert.strictEqual(integrations.listIncoming().length, before + 1, 'queue should grow by exactly 1');
  });

  await test('acceptIncoming(food order) creates a real bill tagged with the platform in the order note', async () => {
    const order = integrations.simulateTestOrder('SWIGGY');
    const beforeBills = service.getSummary('all').orderCount;
    const bill = await integrations.acceptIncoming(order.externalId);
    assert.ok(bill.id, 'accepted order should return a created bill with an id');
    assert.ok(bill.customerName.includes('SWIGGY'), 'bill customer name should be tagged with the platform');
    const afterBills = service.getSummary('all').orderCount;
    assert.strictEqual(afterBills, beforeBills + 1, 'accepting should create exactly one new completed bill');
    assert.strictEqual(integrations.listIncoming().find((q) => q.externalId === order.externalId), undefined, 'accepted order must be removed from the incoming queue');
  });

  await test('rejectIncoming(food order) removes it from the queue without creating a bill', async () => {
    const order = integrations.simulateTestOrder('ZOMATO');
    const beforeBills = service.getSummary('all').orderCount;
    const result = await integrations.rejectIncoming(order.externalId, 'Kitchen closed');
    assert.strictEqual(result, true);
    const afterBills = service.getSummary('all').orderCount;
    assert.strictEqual(afterBills, beforeBills, 'rejecting must NOT create a bill');
    assert.strictEqual(integrations.listIncoming().find((q) => q.externalId === order.externalId), undefined, 'rejected order must be removed from the incoming queue');
  });

  await test('simulateTestOrder(MMT) produces a ROOM_BOOKING shape, and accepting auto-assigns an available room', async () => {
    // Make sure at least one ACTIVE room with no bookings exists for "today" so
    // auto-assignment has somewhere to go.
    roomService.saveRoom({ room_number: 'MMT-TEST-1', room_type: 'Standard', base_price: 2000, max_occupancy: 2 });

    const order = integrations.simulateTestOrder('MMT');
    assert.strictEqual(order.kind, 'ROOM_BOOKING');
    assert.strictEqual(order.platform, 'MMT');

    const booking = await integrations.acceptIncoming(order.externalId);
    assert.ok(booking.id, 'accepting an MMT booking should create a real booking with an id');
    assert.ok(booking.guestName.includes('MMT'), 'booking guest name should be tagged with the platform');
    assert.strictEqual(booking.status, 'BOOKED');
  });

  await test('acceptIncoming throws a clear error for an unknown/already-handled order id', async () => {
    await assert.rejects(() => integrations.acceptIncoming('NOT-A-REAL-ID'), /not found/i);
  });

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed (of ${passed + failed} total)`);
  console.log('='.repeat(50));

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  }

  // Clean up the throwaway temp DB directory.
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}

  process.exit(failed > 0 ? 1 : 0);
})();
