// Validation script: exercises every "this should be REJECTED" path in the
// Room Booking business logic and confirms (a) it actually throws instead of
// silently succeeding/corrupting data, and (b) the error message is specific
// and useful to front-desk staff (names the room/guest/dates, not just a
// generic "Error"). Runs against the LIVE app database, using its own
// dedicated throwaway test rooms (created + deleted here) so it never
// clashes with real or seeded bookings.
const path = require('path');
const os = require('os');
const { initDatabase, getDb } = require('../db/database.cjs');
initDatabase(path.join(os.homedir(), 'AppData', 'Roaming', 'billnest'));
const roomService = require('../db/roomService.cjs');

let passCount = 0;
function expectError(label, fn, mustInclude) {
  try {
    fn();
    console.log(`  FAIL: ${label} — expected an error but it SUCCEEDED (silent failure!)`);
    process.exitCode = 1;
  } catch (err) {
    if (mustInclude && !err.message.includes(mustInclude)) {
      console.log(`  FAIL: ${label} — error thrown, but message doesn't match.\n        expected to include: "${mustInclude}"\n        actual: "${err.message}"`);
      process.exitCode = 1;
    } else {
      passCount++;
      console.log(`  PASS: ${label}\n        -> "${err.message}"`);
    }
  }
}
function expectOk(label, fn) {
  try {
    const result = fn();
    passCount++;
    console.log(`  PASS: ${label}`);
    return result;
  } catch (err) {
    console.log(`  FAIL: ${label} — unexpectedly threw: "${err.message}"`);
    process.exitCode = 1;
    throw err;
  }
}

const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const today = new Date();

// --- Dedicated throwaway test rooms (won't clash with real/seeded data) ---
const testRoomIds = [];
function makeTestRoom(label, status = 'ACTIVE') {
  const id = roomService.saveRoom({ room_number: label, room_type: 'Test', base_price: 2000, max_occupancy: 2, status });
  testRoomIds.push(id);
  return roomService.getRooms().find((r) => r.id === id);
}

console.log('== NEGATIVE SCENARIO VALIDATION (every case below must correctly ERROR) ==\n');

console.log('-- Setup: dedicated test rooms --');
const roomR = expectOk('create test room R (ACTIVE)', () => makeTestRoom('NEG-TEST-R'));
const roomMaint = expectOk('create test room M (MAINTENANCE)', () => makeTestRoom('NEG-TEST-M', 'MAINTENANCE'));
const roomS = expectOk('create test room S (ACTIVE, for clash/update tests)', () => makeTestRoom('NEG-TEST-S'));

console.log('\n-- 1. Double-booking the same room on overlapping dates --');
const pastIn = fmt(addDays(today, -20));
const pastOut = fmt(addDays(today, -18));
const booking1 = expectOk('create the FIRST booking on Room R (past stay, so it can be checked in/out later)', () =>
  roomService.createBooking({ guestName: 'NEG Guest 1', guestPhone: '9000000001', roomId: roomR.id, checkInDate: pastIn, checkOutDate: pastOut, taxPercent: 5 })
);
expectError(
  'creating a SECOND, overlapping booking on the same Room R is rejected',
  () => roomService.createBooking({ guestName: 'NEG Guest 2 (clash)', roomId: roomR.id, checkInDate: pastIn, checkOutDate: pastOut }),
  'is not available'
);

console.log('\n-- 2. Invalid date range (checkout on/before checkin) --');
expectError(
  'checkout date <= checkin date is rejected',
  () => roomService.createBooking({ guestName: 'NEG Guest', roomId: roomS.id, checkInDate: '2026-01-10', checkOutDate: '2026-01-10' }),
  'Check-out date must be after check-in date.'
);

console.log('\n-- 3. Missing required fields --');
expectError(
  'booking with no guest name is rejected',
  () => roomService.createBooking({ roomId: roomS.id, checkInDate: '2026-01-10', checkOutDate: '2026-01-12' }),
  'Guest name is required.'
);
expectError(
  'booking with no room selected is rejected',
  () => roomService.createBooking({ guestName: 'NEG No Room', rooms: [] }),
  'At least one room must be selected.'
);

console.log('\n-- 4. Booking a room that is under maintenance --');
expectError(
  'booking Room M (MAINTENANCE) is rejected',
  () => roomService.createBooking({ guestName: 'NEG Guest', roomId: roomMaint.id, checkInDate: '2026-01-10', checkOutDate: '2026-01-12' }),
  'is under maintenance and cannot be booked.'
);

console.log('\n-- 5. Check-in guards --');
const futureIn = fmt(addDays(today, 30));
const futureOut = fmt(addDays(today, 32));
const futureBooking = expectOk('create a FUTURE booking on Room S (for future-check-in-date test)', () =>
  roomService.createBooking({ guestName: 'NEG Future Guest', roomId: roomS.id, checkInDate: futureIn, checkOutDate: futureOut })
);
expectError(
  "checking in a booking whose check-in date hasn't arrived yet is rejected",
  () => roomService.checkIn(futureBooking.id),
  "It can't be checked in yet."
);

expectOk('check IN the legitimate past booking (Room R, booking1)', () => roomService.checkIn(booking1.id));
expectError(
  'checking in the SAME booking a second time (already CHECKED_IN) is rejected',
  () => roomService.checkIn(booking1.id),
  'Only a booked reservation can be checked in.'
);

console.log('\n-- 6. Room flagged under maintenance AFTER being booked (blocks check-in) --');
const roomT = expectOk('create test room T (ACTIVE)', () => makeTestRoom('NEG-TEST-T'));
const bookingT = expectOk('book Room T for a past stay', () =>
  roomService.createBooking({ guestName: 'NEG Guest T', roomId: roomT.id, checkInDate: pastIn, checkOutDate: pastOut })
);
expectOk('flip Room T to MAINTENANCE after the booking was made', () => roomService.toggleRoomMaintenance(roomT.id, true));
expectError(
  'checking in Room T (now under maintenance) is rejected even though the booking itself is valid',
  () => roomService.checkIn(bookingT.id),
  'is currently under maintenance and cannot be checked into.'
);
roomService.toggleRoomMaintenance(roomT.id, false); // restore for cleanup

console.log('\n-- 7. Check-out guards --');
expectError(
  "checking out a booking whose check-in date hasn't arrived yet is rejected",
  () => roomService.checkOut(futureBooking.id, 'CASH'),
  "It can't be checked out yet."
);

const roomU = expectOk('create test room U (ACTIVE, for no-payment-method test)', () => makeTestRoom('NEG-TEST-U'));
const bookingNoPM = expectOk('book Room U with NO payment method set', () =>
  roomService.createBooking({ guestName: 'NEG No PM Guest', roomId: roomU.id, checkInDate: pastIn, checkOutDate: pastOut })
);
expectOk('check IN Room U booking', () => roomService.checkIn(bookingNoPM.id));
expectError(
  'checking out with no payment method (none on booking, none passed in) is rejected',
  () => roomService.checkOut(bookingNoPM.id),
  'Please select a payment method before checkout.'
);
roomService.checkOut(bookingNoPM.id, 'CASH'); // clear it out for cleanup

expectOk('check OUT Room R booking1 (valid, with payment method)', () => roomService.checkOut(booking1.id, 'CASH'));
expectError(
  'checking out the SAME booking a second time (already CHECKED_OUT) is rejected',
  () => roomService.checkOut(booking1.id, 'CASH'),
  'Booking is already checked out or cancelled.'
);

console.log('\n-- 8. Cancellation guards --');
expectError(
  'cancelling an already-CHECKED_OUT booking is rejected',
  () => roomService.cancelBooking(booking1.id, 'test'),
  'Cannot cancel a booking that has already been checked out.'
);
const roomV = expectOk('create test room V (ACTIVE, for double-cancel test)', () => makeTestRoom('NEG-TEST-V'));
const bookingV = expectOk('book Room V (to be cancelled)', () =>
  roomService.createBooking({ guestName: 'NEG Cancel Guest', roomId: roomV.id, checkInDate: futureIn, checkOutDate: futureOut })
);
expectOk('cancel Room V booking', () => roomService.cancelBooking(bookingV.id, 'test cancel'));
expectError(
  'cancelling the SAME booking a second time is rejected',
  () => roomService.cancelBooking(bookingV.id, 'test again'),
  'This booking is already cancelled.'
);

console.log('\n-- 9. Group invoice requires ALL rooms checked out first --');
const roomW1 = expectOk('create test room W1', () => makeTestRoom('NEG-TEST-W1'));
const roomW2 = expectOk('create test room W2', () => makeTestRoom('NEG-TEST-W2'));
const groupBooking = expectOk('create a 2-room group booking (W1 + W2)', () =>
  roomService.createBooking({
    guestName: 'NEG Group Guest',
    rooms: [
      { roomId: roomW1.id, checkInDate: pastIn, checkOutDate: pastOut },
      { roomId: roomW2.id, checkInDate: pastIn, checkOutDate: pastOut },
    ],
  })
);
const [bW1, bW2] = groupBooking;
expectOk('check in + check out Room W1 ONLY (leave W2 still BOOKED)', () => {
  roomService.checkIn(bW1.id);
  return roomService.checkOut(bW1.id, 'CASH');
});
expectError(
  'requesting the combined group invoice while Room W2 is still pending is rejected',
  () => roomService.getGroupInvoiceData(bW1.bookingGroupId),
  'All rooms in this booking must be checked out before a combined invoice can be generated.'
);
roomService.checkIn(bW2.id);
roomService.checkOut(bW2.id, 'CASH'); // finish it off so cleanup can proceed

console.log('\n-- 10. Update guards --');
const roomX = expectOk('create test room X (ACTIVE, for update-after-checkout test)', () => makeTestRoom('NEG-TEST-X'));
const bookingX = expectOk('book + check in + check out Room X', () => {
  const b = roomService.createBooking({ guestName: 'NEG Update Guest', roomId: roomX.id, checkInDate: pastIn, checkOutDate: pastOut, paymentMethod: 'CASH' });
  roomService.checkIn(b.id);
  roomService.checkOut(b.id, 'CASH');
  return b;
});
expectError(
  'updating an already-CHECKED_OUT booking is rejected',
  () => roomService.updateBooking(bookingX.id, { guestName: 'Changed Name' }),
  'Cannot modify a booking that is already checked out or cancelled.'
);

const roomY = expectOk('create test room Y (ACTIVE, for update-clash test)', () => makeTestRoom('NEG-TEST-Y'));
expectOk('book Room R again for a fresh future range (clash target)', () =>
  roomService.createBooking({ guestName: 'NEG Clash Target', roomId: roomR.id, checkInDate: futureIn, checkOutDate: futureOut })
);
const bookingOnY = expectOk('book Room Y for the SAME future range (separate room, no clash yet)', () =>
  roomService.createBooking({ guestName: 'NEG Update Clash Guest', roomId: roomY.id, checkInDate: futureIn, checkOutDate: futureOut })
);
expectError(
  "updating Room Y's booking to move it onto Room R (already booked for those dates) is rejected",
  () => roomService.updateBooking(bookingOnY.id, { roomId: roomR.id }),
  'is not available'
);

console.log('\n-- 11. Deleting a room with active bookings --');
expectError(
  'deleting Room R while it still has an active (BOOKED) reservation is rejected',
  () => roomService.deleteRoom(roomR.id),
  'Cannot delete a room with active bookings.'
);

console.log('\n-- 12. Adding a room to a booking group --');
expectError(
  'adding a room to a NON-EXISTENT booking group is rejected',
  () => roomService.addRoomToBookingGroup('BOGUS-GROUP-ID', { roomId: roomS.id }),
  'Original booking not found.'
);
expectError(
  'adding a MAINTENANCE room to a valid group is rejected',
  () => roomService.addRoomToBookingGroup(groupBooking[0].bookingGroupId, { roomId: roomMaint.id }),
  'is under maintenance and cannot be booked.'
);

// ---------------- Cleanup ----------------
console.log('\n-- Cleanup: cancel any still-active test bookings, then delete test rooms --');
const db = getDb();
for (const roomId of testRoomIds) {
  const active = db.prepare("SELECT id FROM room_bookings WHERE room_id = ? AND status IN ('BOOKED','CHECKED_IN')").all(roomId);
  for (const row of active) {
    try { roomService.cancelBooking(row.id, 'negative-test cleanup'); } catch (e) { /* ignore */ }
  }
}
for (const roomId of testRoomIds) {
  try {
    roomService.deleteRoom(roomId);
    console.log(`  removed test room id=${roomId}`);
  } catch (e) {
    console.log(`  WARN: could not remove test room id=${roomId}: ${e.message}`);
  }
}

console.log(`\n${passCount} checks passed.`);
if (process.exitCode === 1) {
  console.log('SOME NEGATIVE-SCENARIO CHECKS FAILED — see FAIL lines above.');
} else {
  console.log('All negative scenarios correctly rejected with proper error messages.');
}
