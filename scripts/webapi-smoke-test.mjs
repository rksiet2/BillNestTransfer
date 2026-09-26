// Runtime smoke test for src/mobile/webApi.js (the browser/Capacitor fallback
// for window.api). Exercises the adapter directly under Node (which has the
// same Web Crypto `crypto.subtle` API as a browser) using an in-memory
// localStorage shim, so we don't need a real browser/Puppeteer to validate
// end-to-end correctness before scaffolding the Capacitor/Android project.
//
// Run with: node scripts/webapi-smoke-test.mjs

// --- minimal localStorage shim (Node has no `localStorage` global by default) ---
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.window = globalThis; // webApi.js references `window.print`, etc.
globalThis.print = () => {};
globalThis.alert = () => {};

let failures = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL: ${msg}`);
  }
}
function approxEq(a, b, eps = 0.01) {
  return Math.abs(a - b) < eps;
}

const { createWebApi } = await import('../src/mobile/webApi.js');
const api = createWebApi();

console.log('\n=== Setup / Settings ===');
const settings = await api.getSettings();
assert(settings && typeof settings === 'object', 'getSettings returns an object');
assert(settings.whatsapp_mobile_manual_handoff === 'true', 'mobile WhatsApp messages use manual handoff by default');
assert(settings.whatsapp_send_room_booking === 'true', 'room booking WhatsApp handoff is enabled by default');
assert(settings.whatsapp_send_room_checkin === 'true', 'check-in WhatsApp handoff is enabled by default');
assert(settings.whatsapp_send_room_checkout === 'true', 'room checkout WhatsApp handoff is enabled by default');
assert(settings.whatsapp_food_bill_template.includes('{bill_number}'), 'mobile food bill WhatsApp template has editable placeholder defaults');
await api.saveSettings({ hotel_name: 'Smoke Test Inn', hotel_gstin: '00AAAAA0000A1Z5', tax_percent: 12 });
const settings2 = await api.getSettings();
assert(settings2.hotel_name === 'Smoke Test Inn', 'saveSettings persists hotel_name');

console.log('\n=== Owner Account / Auth ===');
const hasOwnerBefore = await api.hasOwnerAccount();
assert(hasOwnerBefore === false, 'no owner account exists initially');
await api.createOwnerAccount({ name: 'Owner', pin: '1234' });
const hasOwnerAfter = await api.hasOwnerAccount();
assert(hasOwnerAfter === true, 'owner account created');
const loginOk = await api.loginWithPin('1234');
assert(loginOk && loginOk.role === 'OWNER', `owner can login with correct PIN (got role=${loginOk?.role})`);
const loginBad = await api.loginWithPin('9999');
assert(loginBad === null, 'wrong PIN rejected');

console.log('\n=== Food & Categories ===');
const categories = await api.listCategories();
assert(Array.isArray(categories) && categories.length > 0, 'default categories seeded');
const foodListBefore = await api.listFood();
assert(Array.isArray(foodListBefore) && foodListBefore.length > 0, 'default food items seeded');
const testFood = { name: 'Smoke Test Dish', category_id: categories[0].id, price: 100, available: 1 };
await api.saveFood(testFood);
const foodList = await api.listFood();
const savedFood = foodList.find((f) => f.name === 'Smoke Test Dish');
assert(!!savedFood, 'saveFood adds a new item findable via listFood');

console.log('\n=== Billing math ===');
const bill = await api.createBill({
  items: [{ id: savedFood.id, name: 'Smoke Test Dish', price: 100, quantity: 3 }],
  paymentMethod: 'CASH',
  customerName: 'Walk-in',
  customerPhone: '9876543210',
});
assert(bill && bill.id, 'createBill returns a bill with an id');
assert(bill.customer_phone === '9876543210', 'mobile bill preserves the customer phone');
const savedPhoneBill = await api.getBillById(bill.id);
assert(savedPhoneBill.customerPhone === '9876543210', 'customer phone remains available after reloading the bill');
assert(approxEq(bill.subtotal, 300), `subtotal is 300 (got ${bill.subtotal})`);
assert(approxEq(bill.tax_amount, 36), `tax is 12% of 300 = 36 (got ${bill.tax_amount})`);
assert(approxEq(bill.total, 336), `total is 336 (got ${bill.total})`);
assert(bill.token && /^[BG]\d{2}$/.test(bill.token), `token uses B/G prefix format (got ${bill.token})`);

const billWithDiscount = await api.createBill({
  items: [{ id: savedFood.id, name: 'Smoke Test Dish', price: 100, quantity: 2 }],
  paymentMethod: 'ONLINE',
  discount: 20,
});
// 200 subtotal, tax 12% of 200 = 24, total = 200 + 24 - 20 = 204
assert(approxEq(billWithDiscount.subtotal, 200), `discount bill subtotal 200 (got ${billWithDiscount.subtotal})`);
assert(approxEq(billWithDiscount.total, 204), `discount bill total 204 (got ${billWithDiscount.total})`);
assert(billWithDiscount.token.startsWith('G'), `online bill token uses G prefix (got ${billWithDiscount.token})`);
const quickPicks = await api.getPopularFood(1);
assert(quickPicks[0]?.name === 'Smoke Test Dish', 'best sellers include recently sold menu items');
assert(quickPicks[0]?.units_sold === 5, 'best sellers rank by completed units sold');

console.log('\n=== Cancellation excluded from revenue ===');
const cancelBill = await api.createBill({
  items: [{ name: 'Smoke Test Dish', price: 100, quantity: 5 }],
  paymentMethod: 'CASH',
});
await api.cancelBill(cancelBill.id, 'smoke test cancellation');
const bills = await api.listBills();
const cancelledEntry = bills.find((b) => b.id === cancelBill.id);
assert(cancelledEntry && cancelledEntry.status === 'CANCELLED', 'bill marked cancelled');
const summary = await api.getSummary({ period: 'today' });
assert(summary && typeof summary.revenue === 'number', 'getSummary returns revenue');
// revenue should reflect the two non-cancelled bills (336 + 204 = 540), not the cancelled 560
assert(approxEq(summary.revenue, 540, 0.5), `revenue excludes cancelled bill (got ${summary.revenue})`);
assert(summary.cancelledCount === 1, `cancelledCount tracked separately (got ${summary.cancelledCount})`);

console.log('\n=== Room booking lifecycle ===');
const rooms = await api.listRooms();
assert(Array.isArray(rooms) && rooms.length > 0, 'default rooms seeded');
const room = rooms[0];
const checkIn = '2026-01-10';
const checkOut = '2026-01-12';
const booking = await api.createBooking({
  roomId: room.id,
  guestName: 'Smoke Guest',
  checkInDate: checkIn,
  checkOutDate: checkOut,
  roomRate: 1500,
});
assert(booking && booking.id, 'createBooking returns a booking with id');
assert(booking.status === 'BOOKED', `new booking status is BOOKED (got ${booking.status})`);

// Overlapping booking on same room/dates should be rejected
let conflictCaught = false;
try {
  await api.createBooking({
    roomId: room.id,
    guestName: 'Conflict Guest',
    checkInDate: checkIn,
    checkOutDate: checkOut,
    roomRate: 1500,
  });
} catch (e) {
  conflictCaught = true;
}
assert(conflictCaught, 'double-booking same room/dates is rejected');

const checkedIn = await api.checkInBooking(booking.id);
assert(checkedIn && checkedIn.status === 'CHECKED_IN', `checkInBooking transitions status (got ${checkedIn?.status})`);

let checkoutBlocked = false;
try {
  await api.checkOutBooking(booking.id);
} catch (e) {
  checkoutBlocked = true;
}
assert(checkoutBlocked, 'checkout blocked without a payment method selected');

await api.updateBooking(booking.id, { paymentMethod: 'CASH' });
const { booking: checkedOutBooking, bill: roomBill } = await api.checkOutBooking(booking.id);
assert(checkedOutBooking.status === 'CHECKED_OUT', `checkOutBooking transitions status (got ${checkedOutBooking.status})`);
assert(roomBill && roomBill.source === 'ROOM', `checkout creates a bill tagged source=ROOM (got ${roomBill?.source})`);
assert(approxEq(roomBill.subtotal, 3000), `2-night booking bills 2x1500=3000 (got ${roomBill.subtotal})`);
assert(roomBill.bookingNumber === checkedOutBooking.bookingNumber, `room bill carries its own booking_number (got ${roomBill.bookingNumber} vs booking ${checkedOutBooking.bookingNumber})`);
const refetchedRoomBill = await api.getBillById(roomBill.id);
assert(refetchedRoomBill.booking_number === checkedOutBooking.bookingNumber, 're-fetching the bill from storage still exposes booking_number');

let cancelAfterCheckoutBlocked = false;
try {
  await api.cancelBooking(booking.id, 'test');
} catch (e) {
  cancelAfterCheckoutBlocked = true;
}
assert(cancelAfterCheckoutBlocked, 'a checked-out booking cannot be cancelled');

console.log('\n=== Staff account + role rules ===');
const staff = await api.createStaffAccount({ name: 'Staff One', pin: '4321' });
assert(staff && staff.id, 'createStaffAccount creates a staff user');
const staffLogin = await api.loginWithPin('4321');
assert(staffLogin && staffLogin.role === 'STAFF', `staff can login with their PIN (got role=${staffLogin?.role})`);
await api.deactivateUser(staff.id);
const staffLoginAfterDeactivate = await api.loginWithPin('4321');
assert(staffLoginAfterDeactivate === null, 'deactivated staff cannot login');

let ownerDeactivateBlocked = false;
try {
  const owner = (await api.listUsers()).find((u) => u.role === 'OWNER');
  await api.deactivateUser(owner.id);
} catch (e) {
  ownerDeactivateBlocked = true;
}
assert(ownerDeactivateBlocked, 'owner account cannot be deactivated');

console.log('\n=== Group booking combined invoice (Group Invoice Number) ===');
await api.saveRoom({ room_number: 'GRP-A', room_type: 'Standard', base_price: 1200, max_occupancy: 2 });
await api.saveRoom({ room_number: 'GRP-B', room_type: 'Deluxe', base_price: 2200, max_occupancy: 2 });
const grpRoomA = (await api.listRooms()).find((r) => r.room_number === 'GRP-A');
const grpRoomB = (await api.listRooms()).find((r) => r.room_number === 'GRP-B');
const groupBookings = await api.createBooking({
  checkInDate: checkIn,
  checkOutDate: checkOut,
  rooms: [{ roomId: grpRoomA.id, roomRate: 1200 }, { roomId: grpRoomB.id, roomRate: 2200 }],
  contacts: [{ name: 'Group Invoice Guest', phone: '9998887777' }],
  paymentMethod: 'CASH',
});
assert(Array.isArray(groupBookings) && groupBookings.length === 2, 'a 2-room booking submission creates 2 bookings');
for (const b of groupBookings) {
  await api.checkInBooking(b.id);
  await api.checkOutBooking(b.id);
}
const groupInvoice = await api.getGroupInvoice(groupBookings[0].bookingGroupId);
assert(groupInvoice && groupInvoice.rooms.length === 2, 'combined group invoice includes both rooms');
assert(!!groupInvoice.groupInvoiceNumber, 'combined group invoice exposes a single overall groupInvoiceNumber');
assert(groupInvoice.groupInvoiceNumber === `GRP-${groupBookings[0].bookingGroupId}`, `groupInvoiceNumber is derived from the shared bookingGroupId (got ${groupInvoice.groupInvoiceNumber})`);

console.log('\n=== Mobile Factory Reset ===');
const foodCountBeforeReset = (await api.listFood()).length;
const categoriesCountBeforeReset = (await api.listCategories()).length;
const roomsCountBeforeReset = (await api.listRooms()).length;

let wrongPinBlocked = false;
try {
  await api.factoryReset({ confirmText: 'RESET', ownerPin: '0000' });
} catch (e) {
  wrongPinBlocked = true;
}
assert(wrongPinBlocked, 'factoryReset rejects a wrong Owner PIN');

let badConfirmBlocked = false;
try {
  await api.factoryReset({ confirmText: 'nope', ownerPin: '1234' });
} catch (e) {
  badConfirmBlocked = true;
}
assert(badConfirmBlocked, 'factoryReset rejects a confirm text other than RESET');

await api.factoryReset({ confirmText: 'RESET', ownerPin: '1234' });
assert((await api.listFood()).length === foodCountBeforeReset, 'factoryReset keeps the food menu');
assert((await api.listCategories()).length === categoriesCountBeforeReset, 'factoryReset keeps categories');
const roomsAfterReset = await api.listRooms();
assert(roomsAfterReset.length === roomsCountBeforeReset, 'factoryReset keeps the rooms list');
assert(roomsAfterReset.every((r) => r.status === 'ACTIVE'), 'factoryReset resets room status');
assert((await api.listBills()).length === 0, 'factoryReset clears bills');
assert((await api.listBookings()).length === 0, 'factoryReset clears bookings');
assert((await api.listUsers()).length === 0, 'factoryReset clears all users');
assert((await api.hasOwnerAccount()) === false, 'factoryReset requires a fresh Owner PIN setup afterward');
const settingsAfterReset = await api.getSettings();
assert(settingsAfterReset.hotel_name === 'Your Hotel Name', 'factoryReset resets hotel settings to defaults');

console.log(`\n=== RESULT: ${passed} passed, ${failures} failed ===`);
process.exit(failures > 0 ? 1 : 0);
