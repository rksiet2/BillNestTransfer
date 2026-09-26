import { APP_NAME } from '../constants/brand.js';
import { getRemoteConfig, saveRemoteConfig } from './remoteConfig.js';
import { getCloudApiStatus, configureCloudApi, clearCloudApi, sendCloudText, createInvoicePdf, sendCloudPdf } from './cloudApi.js';
import { parseMobileDb, serializeMobileDb } from './mobileDbStorage.js';

// Browser/mobile fallback for the Electron `window.api` bridge.
//
// BillNest's desktop app talks to a real SQLite database (better-sqlite3)
// through Electron's preload script. That native module can't run inside an
// Android WebView (Capacitor) or a plain browser tab — there's no Node.js
// backend there. So for the mobile/demo build, this file re-implements the
// same `window.api` surface using the browser's own localStorage as the
// "database", with the exact same business rules (billing math, room
// booking lifecycle, PIN auth) ported over from db/service.cjs,
// db/roomService.cjs and db/userService.cjs.
//
// IMPORTANT — this is the "demo/local" mobile build: everything lives only
// on this one phone's local storage. It does NOT sync with the desktop app
// or across devices. That's planned separately as the Phase 2 cloud-sync
// roadmap item.
//
// This file is only ever loaded when `window.api` doesn't already exist
// (i.e. we're not running inside Electron) — see the bootstrap in main.jsx.

const STORAGE_KEY = 'billnest_mobile_db_v1';

function loadDb() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    let db;
    try {
      db = parseMobileDb(raw);
    } catch (_) {
      // fall through to fresh DB below
    }
    if (db) return backfillMissingCollections(db);
  }
  return seedFreshDb();
}

function saveDb(db) {
  try {
    localStorage.setItem(STORAGE_KEY, serializeMobileDb(db));
  } catch (error) {
    if (error?.name === 'QuotaExceededError' || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error?.code === 22 || error?.code === 1014) {
      throw new Error('This device is out of storage space for BillNest data. Export a backup, then remove unused menu photos or free space on the device before retrying.');
    }
    throw error;
  }
}

function nextId(list) {
  return list.length ? Math.max(...list.map((x) => x.id)) + 1 : 1;
}

const DEFAULT_CATEGORIES = ['Starters', 'Main Course', 'Breads', 'Rice & Biryani', 'Desserts', 'Beverages'];
const DEFAULT_FOOD = [
  { name: 'Paneer Tikka', category: 'Starters', price: 220 },
  { name: 'Chicken 65', category: 'Starters', price: 260 },
  { name: 'Veg Spring Roll', category: 'Starters', price: 180 },
  { name: 'Butter Chicken', category: 'Main Course', price: 320 },
  { name: 'Paneer Butter Masala', category: 'Main Course', price: 280 },
  { name: 'Dal Makhani', category: 'Main Course', price: 210 },
  { name: 'Tandoori Roti', category: 'Breads', price: 25 },
  { name: 'Butter Naan', category: 'Breads', price: 45 },
  { name: 'Veg Biryani', category: 'Rice & Biryani', price: 240 },
  { name: 'Chicken Biryani', category: 'Rice & Biryani', price: 300 },
  { name: 'Gulab Jamun', category: 'Desserts', price: 80 },
  { name: 'Ice Cream', category: 'Desserts', price: 90 },
  { name: 'Masala Chai', category: 'Beverages', price: 30 },
  { name: 'Cold Coffee', category: 'Beverages', price: 110 },
];

function seedFreshDb() {
  const categories = DEFAULT_CATEGORIES.map((name, i) => ({ id: i + 1, name, sort_order: i }));
  const catByName = Object.fromEntries(categories.map((c) => [c.name, c.id]));
  const foodItems = DEFAULT_FOOD.map((f, i) => ({
    id: i + 1,
    name: f.name,
    category_id: catByName[f.category],
    category_name: f.category,
    price: f.price,
    image_path: null,
    is_veg: 1,
    available: 1,
  }));

  const db = {
    settings: {
      hotel_name: 'Your Hotel Name',
      hotel_address: 'Your Hotel Address',
      hotel_phone: '',
      hotel_gstin: '',
      upi_id: '',
      tax_percent: '5',
      tax_percent_cash: '5',
      tax_percent_online: '5',
      bill_footer: 'Thank you! Visit again.',
      room_biz_name: 'Your Hotel Name',
      room_biz_address: 'Your Hotel Address',
      room_biz_phone: '',
      room_biz_gstin: '',
      room_upi_id: '',
      room_bill_footer: 'Thank you! Visit again.',
      room_biz_logo_path: '',
      room_tax_percent_cash: '0',
      room_tax_percent_online: '0',
      setup_completed: 'false',
      feature_table_management: 'false',
      feature_captain_app: 'false',
      feature_multi_terminal_sync: 'false',
      whatsapp_provider: 'BAILEYS',
      food_printer_name: '',
      room_printer_name: '',
      kot_printer_name: '',
      printer_paper_width: '80',
      printer_scale_percent: '100',
      room_invoice_format: 'A4',
      whatsapp_cloud_template_name: '',
      whatsapp_cloud_template_language: 'en_US',
      whatsapp_room_booking_template: '✅ Hi {guest_name}, Your Booking is Confirmed at {hotel_name} 🎉\n\n📅 Your Booking Details:\n\nBooking ID: {booking_number}\nCheck-in: {check_in}\nCheck-out: {check_out}\nRoom/Bed: {room}\n\nTotal Amount: {total}\nAmount Paid: {advance}\n\n📞 For any queries, please contact the property: {hotel_phone}. You can reply to this message to chat with hotel team directly!\n📍 Location: {hotel_address}\n\nLooking forward to hosting you!\n{hotel_name} Team',
      whatsapp_room_checkin_template: '✅ Welcome {guest_name} to {hotel_name}! 🎉\n\nBooking ID: {booking_number}\nRoom/Bed: {room}\nCheck-out: {check_out}\n\n📞 For queries: {hotel_phone}\n📍 Location: {hotel_address}\n\nWe hope you have a pleasant stay!\n{hotel_name} Team',
      whatsapp_room_checkout_template: '✅ Thank you for staying with {hotel_name}, {guest_name}!\n\nBooking ID: {booking_number}\nRoom/Bed: {room}\nTotal Amount: {total}\nAmount Paid: {advance}\n\n📞 For queries: {hotel_phone}\n📍 Location: {hotel_address}\n\nWe look forward to hosting you again!\n{hotel_name} Team',
      whatsapp_send_room_booking: 'true',
      whatsapp_send_room_checkin: 'true',
      whatsapp_send_room_checkout: 'true',
      whatsapp_mobile_manual_handoff: 'true',
      whatsapp_send_food_bill: 'true',
      whatsapp_food_bill_template: 'Hi {customer_name}, please find bill {bill_number} from {business_name}. Total: {total}. Thank you!',
      whatsapp_checkout_review_request: 'false',
      whatsapp_room_review_link: '',
    },
    categories,
    foodItems,
    bills: [],
    billItems: [],
    tables: [],
    tableOrders: {},
    rooms: [
      { id: 1, room_number: '101', room_type: 'Standard', base_price: 1800, max_occupancy: 2, status: 'ACTIVE', notes: null },
      { id: 2, room_number: '102', room_type: 'Deluxe', base_price: 2600, max_occupancy: 3, status: 'ACTIVE', notes: null },
    ],
    bookings: [],
    bookingAddons: [],
    bookingContacts: [],
    users: [],
    rawMaterials: [],
    purchases: [],
    expenses: [],
    counters: { bill: 0, kot: 0, booking: 0, tokenCash: 0, tokenOnline: 0 },
  };
  saveDb(db);
  return db;
}

// Older saved localStorage DBs (created before Inventory/Purchases/Expenses
// existed on mobile) won't have these arrays — backfill them in place so
// existing installs don't crash/silently no-op when the user opens those
// screens after an app update.
function backfillMissingCollections(db) {
  let changed = false;
  for (const key of ['rawMaterials', 'purchases', 'expenses', 'bookingContacts', 'tables']) {
    if (!Array.isArray(db[key])) { db[key] = []; changed = true; }
  }
  if (!db.tableOrders || typeof db.tableOrders !== 'object') { db.tableOrders = {}; changed = true; }
  if (db.settings && db.settings.whatsapp_mobile_manual_handoff === undefined) {
    db.settings.whatsapp_mobile_manual_handoff = 'true';
    db.settings.whatsapp_send_food_bill = 'true';
    db.settings.whatsapp_send_room_booking = 'true';
    db.settings.whatsapp_send_room_checkin = 'true';
    db.settings.whatsapp_send_room_checkout = 'true';
    changed = true;
  }
  const settingDefaults = {
    feature_table_management: 'false',
    feature_captain_app: 'false',
    feature_multi_terminal_sync: 'false',
    room_biz_logo_path: '',
    whatsapp_room_booking_template: '',
    whatsapp_room_checkin_template: '',
    whatsapp_room_checkout_template: '',
    whatsapp_send_room_booking: 'true',
    whatsapp_send_room_checkin: 'true',
    whatsapp_send_room_checkout: 'true',
    whatsapp_mobile_manual_handoff: 'true',
    whatsapp_send_food_bill: 'true',
    whatsapp_food_bill_template: 'Hi {customer_name}, please find bill {bill_number} from {business_name}. Total: {total}. Thank you!',
  };
  for (const [key, value] of Object.entries(settingDefaults)) {
    if (db.settings && db.settings[key] === undefined) { db.settings[key] = value; changed = true; }
  }
  if (changed) saveDb(db);
  return db;
}

function nowLocal() {
  return new Date().toLocaleString('en-IN');
}

function round2(n) {
  return +Number(n).toFixed(2);
}

// Picks the right business identity (name/address/phone/GSTIN/footer/UPI)
// to print on a bill, depending on whether it's a Food Billing bill or a
// Room Booking one — mirrors db/service.cjs's getBillIdentity() on the
// desktop side. These are two separate, independently-editable identities
// in Settings (a restaurant and a hotel can legally be different
// businesses, with their own GSTIN/footer/UPI).
function getBillIdentity(settings, source) {
  if (source === 'ROOM') {
    return {
      hotelName: settings.room_biz_name || 'Hotel',
      hotelAddress: settings.room_biz_address || '',
      hotelPhone: settings.room_biz_phone || '',
      hotelGstin: settings.room_biz_gstin || '',
      billFooter: settings.room_bill_footer || 'Thank you! Visit again.',
      upiId: settings.room_upi_id || '',
      hotelLogo: settings.room_biz_logo_path || '',
    };
  }
  return {
    hotelName: settings.hotel_name || 'Hotel',
    hotelAddress: settings.hotel_address || '',
    hotelPhone: settings.hotel_phone || '',
    hotelGstin: settings.hotel_gstin || '',
    billFooter: settings.bill_footer || 'Thank you! Visit again.',
    upiId: settings.upi_id || '',
    hotelLogo: '',
  };
}

// `from`/`to` throughout this file arrive as plain 'YYYY-MM-DD' strings (see
// dateRange.js's periodToRange/todayStr, which both use the LOCAL date).
// `new Date('YYYY-MM-DD')` parses that as UTC midnight per the ISO-8601 spec,
// not local midnight — so in any timezone ahead of UTC (e.g. IST, UTC+5:30),
// "today"'s own bills (created after local midnight but still before UTC
// midnight rolls over) were being excluded by the `to` upper bound, making
// the "Today" filter appear empty while "All Time" still showed them. Adding
// an explicit local time-of-day component forces JS to parse it as local
// time instead of UTC, fixing the boundary for every timezone.
function startOfDayLocal(dateStr) {
  return new Date(`${dateStr}T00:00:00`);
}
function endOfDayLocal(dateStr) {
  return new Date(`${dateStr}T23:59:59.999`);
}

// ---------------- Settings ----------------
function getSettings() {
  const db = loadDb();
  return { ...db.settings };
}

function saveSettings(partial) {
  const db = loadDb();
  // Back-compat: `tax_percent` is the legacy single global rate that
  // pre-dates the Cash/Online split (see db/service.cjs's saveSettings for
  // the same rule) — mirror it into both new keys if the caller isn't
  // setting them itself in the same call.
  const entries = { ...partial };
  if (entries.tax_percent != null) {
    if (entries.tax_percent_cash == null) entries.tax_percent_cash = entries.tax_percent;
    if (entries.tax_percent_online == null) entries.tax_percent_online = entries.tax_percent;
  }
  db.settings = { ...db.settings, ...Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, String(v)])) };
  saveDb(db);
  return { ...db.settings };
}

// ---------------- Restaurant Tables (Table/Area Management — opt-in) ----------------
function listTables() {
  return loadDb().tables;
}

function saveTable(table) {
  const db = loadDb();
  if (table.id) {
    const idx = db.tables.findIndex((t) => t.id === table.id);
    if (idx !== -1) db.tables[idx] = { ...db.tables[idx], ...table };
  } else {
    db.tables.push({
      id: nextId(db.tables),
      name: table.name,
      area: table.area || null,
      capacity: table.capacity || 4,
      status: 'EMPTY',
      sort_order: table.sort_order || 0,
    });
  }
  saveDb(db);
  return true;
}

function deleteTable(id) {
  const db = loadDb();
  const table = db.tables.find((t) => t.id === id);
  if (table && table.status === 'OCCUPIED') {
    throw new Error('Cannot delete a table that currently has an active order. Bill or clear it first.');
  }
  db.tables = db.tables.filter((t) => t.id !== id);
  saveDb(db);
  return true;
}

function updateTableStatus(id, status) {
  const db = loadDb();
  const table = db.tables.find((t) => t.id === id);
  if (table) table.status = status;
  saveDb(db);
  return table;
}

// Attaches (or clears, with `waiterName = null`) the name of whichever
// staff/captain is serving a table — see db/service.cjs's assignTableWaiter
// for the desktop equivalent.
function assignTableWaiter(id, waiterName) {
  const db = loadDb();
  const table = db.tables.find((t) => t.id === id);
  if (table) table.waiter_name = waiterName || null;
  saveDb(db);
  return table;
}

// Persists a table's live (not-yet-billed) cart so re-opening the same
// table later on this device restores it — see db/service.cjs's
// getTableOrder/saveTableOrder/clearTableOrder for the desktop equivalent.
// Note: standalone mobile is single-device by design (see file header), so
// this only protects against navigating away/back on the SAME phone.
function getTableOrder(id) {
  const db = loadDb();
  return db.tableOrders[id] || null;
}

function saveTableOrder(id, { items, customerName, customerPhone } = {}) {
  const db = loadDb();
  db.tableOrders[id] = {
    items: items || [],
    customerName: customerName || '',
    customerPhone: customerPhone || '',
    updatedAt: new Date().toISOString(),
  };
  saveDb(db);
  return true;
}

function clearTableOrder(id) {
  const db = loadDb();
  delete db.tableOrders[id];
  saveDb(db);
  return true;
}

// ---------------- Categories & Food ----------------
function listCategories() {
  return loadDb().categories;
}

function addCategory(name) {
  const db = loadDb();
  const cat = { id: nextId(db.categories), name, sort_order: 999 };
  db.categories.push(cat);
  saveDb(db);
  return cat;
}

function listFood({ categoryId, search } = {}) {
  const db = loadDb();
  let items = db.foodItems;
  if (categoryId) items = items.filter((f) => String(f.category_id) === String(categoryId));
  if (search) items = items.filter((f) => f.name.toLowerCase().includes(search.toLowerCase()));
  return items;
}

function getPopularFood(limit = 8) {
  const db = loadDb();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const quantities = new Map();
  for (const bill of db.bills) {
    if (bill.source !== 'FOOD' || bill.status !== 'COMPLETED' || new Date(bill.created_at).getTime() < cutoff) continue;
    for (const item of bill.items || []) {
      const foodId = item.food_id ?? item.foodId;
      if (foodId == null) continue;
      quantities.set(foodId, (quantities.get(foodId) || 0) + Number(item.quantity || 0));
    }
  }
  const safeLimit = Math.max(1, Math.min(20, Number.isInteger(Number(limit)) ? Number(limit) : 8));
  return db.foodItems
    .filter((food) => food.available && quantities.has(food.id))
    .map((food) => ({ ...food, units_sold: quantities.get(food.id) }))
    .sort((a, b) => b.units_sold - a.units_sold || a.name.localeCompare(b.name))
    .slice(0, safeLimit);
}

function saveFood(item) {
  const db = loadDb();
  const category = db.categories.find((c) => c.id === item.category_id);
  if (item.id) {
    const idx = db.foodItems.findIndex((f) => f.id === item.id);
    if (idx !== -1) {
      db.foodItems[idx] = { ...db.foodItems[idx], ...item, category_name: category?.name || '' };
    }
  } else {
    db.foodItems.push({ ...item, id: nextId(db.foodItems), category_name: category?.name || '' });
  }
  saveDb(db);
  return true;
}

function deleteFood(id) {
  const db = loadDb();
  db.foodItems = db.foodItems.filter((f) => f.id !== id);
  saveDb(db);
  return true;
}

// Native-equivalent food image picker — see pickFileAsDataUrl above for how
// this works without a real filesystem (previously a no-op stub, which is
// why adding a photo to a menu item silently did nothing on mobile).
function pickImage() {
  return pickFileAsDataUrl('image/png,image/jpeg,image/webp');
}

// ---------------- Billing ----------------
function nextToken(paymentMethod, db) {
  const prefix = paymentMethod === 'ONLINE' ? 'G' : 'B';
  const key = paymentMethod === 'ONLINE' ? 'tokenOnline' : 'tokenCash';
  db.counters[key] = (db.counters[key] || 0) + 1;
  const n = db.counters[key] > 99 ? 1 : db.counters[key];
  if (db.counters[key] > 99) db.counters[key] = 1;
  return `${prefix}${String(n).padStart(2, '0')}`;
}

function createBill({ items, paymentMethod, customerName, customerPhone, discount = 0, advancePayment = 0, taxPercent, orderNote, skipKot = false, source = 'FOOD', tableId = null, bookingNumber = null }) {
  if (!items || items.length === 0) throw new Error('At least one item is required to generate a bill.');
  const db = loadDb();
  // Mirrors db/service.cjs's autoTaxPercent() fallback: if the caller didn't
  // resolve a rate already, pick the Cash vs Online slab for this bill's
  // business (Food vs Room) from Settings.
  const isRoom = source === 'ROOM';
  const autoKey = paymentMethod === 'ONLINE'
    ? (isRoom ? 'room_tax_percent_online' : 'tax_percent_online')
    : (isRoom ? 'room_tax_percent_cash' : 'tax_percent_cash');
  const tax = taxPercent != null
    ? taxPercent
    : parseFloat(db.settings[autoKey] ?? db.settings.tax_percent ?? 5);

  const subtotal = items.reduce((sum, it) => sum + it.price * it.quantity, 0);
  const taxAmount = round2(subtotal * (tax / 100));
  // `discount` is a genuine price reduction; `advancePayment` (room-booking
  // advances only) is money already received upfront and must never reduce
  // `total` — see db/roomService.cjs's checkOut for the desktop-side fix
  // this mirrors. `balance_due` is what's actually collected at this
  // checkout (total - advancePayment).
  const total = Math.max(0, round2(subtotal + taxAmount - discount));
  const balanceDue = round2(total - advancePayment);

  db.counters.bill += 1;
  const seq = String(db.counters.bill).padStart(4, '0');
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const billNumber = `INV-${dateStamp}-${seq}`;
  const kotNumber = skipKot ? null : `KOT-${dateStamp}-${seq}`;
  const token = nextToken(paymentMethod, db);

  // Desktop stores each bill item as its own bill_items row (id, name, price,
  // quantity, total) — BillWindow/KotWindow read `it.id` (React key) and
  // `it.total` directly. The raw cart items passed in only have
  // name/price/quantity, so normalize them into that same shape here;
  // previously this was skipped, which is why totals/line-items rendered
  // blank on the mobile invoice/KOT screens.
  let itemSeq = (db.counters.billItem = db.counters.billItem || 0);
  const normalizedItems = items.map((it) => {
    itemSeq += 1;
    return {
      id: itemSeq,
      food_id: it.food_id ?? it.id ?? null,
      name: it.name,
      price: it.price,
      quantity: it.quantity,
      total: round2(it.price * it.quantity),
    };
  });
  db.counters.billItem = itemSeq;

  // Field names below are snake_case to match the desktop app's real SQLite
  // schema (db/service.cjs), which the UI (BillWindow, KotWindow, Reporting)
  // reads directly without any camelCase mapping for bills. We also mirror
  // the camelCase `billNumber`/`kotNumber`/`token` keys that the desktop
  // `createBill` IPC response carries, since BillingPage/Cart's post-generate
  // toast reads those camelCase names off the object this function returns.
  const bill = {
    id: nextId(db.bills),
    bill_number: billNumber,
    billNumber,
    kot_number: kotNumber,
    kotNumber,
    token,
    payment_method: paymentMethod,
    customer_name: customerName || null,
    customer_phone: customerPhone || null,
    customerPhone: customerPhone || '',
    subtotal,
    tax_percent: tax,
    tax_amount: taxAmount,
    discount,
    advance_payment: advancePayment,
    advancePayment,
    balance_due: balanceDue,
    balanceDue,
    total,
    status: 'COMPLETED',
    source: source === 'ROOM' ? 'ROOM' : 'FOOD',
    table_id: tableId || null,
    order_note: orderNote || '',
    booking_number: bookingNumber || null,
    bookingNumber: bookingNumber || null,
    // Store as ISO so `new Date(created_at)` (used throughout reporting/date
    // filtering) parses reliably; formatDate() converts to a readable string
    // for display. A locale string here (e.g. toLocaleString) previously broke
    // every period-based revenue filter (today/week/month/year always = 0).
    created_at: new Date().toISOString(),
    items: normalizedItems,
    ...getBillIdentity(db.settings, source === 'ROOM' ? 'ROOM' : 'FOOD'),
  };
  db.bills.push(bill);
  saveDb(db);
  return bill;
}

function getBillById(id) {
  const db = loadDb();
  const bill = db.bills.find((b) => b.id === id);
  if (!bill) return null;
  // Mirrors desktop's db/service.cjs getBillById: ROOM bills need the
  // full stay/guest details (for the A4 room invoice) looked up at read
  // time via the bill's own booking_number, not baked in at creation time.
  let stay = {};
  if (bill.source === 'ROOM' && bill.bookingNumber) {
    const booking = db.bookings.find((b) => b.bookingNumber === bill.bookingNumber);
    if (booking) {
      const room = db.rooms.find((r) => r.id === booking.roomId);
      stay = {
        guestName: booking.guestName,
        guestPhone: booking.guestPhone || '',
        guestGstin: booking.guestGstin || '',
        guestIdType: booking.guestIdType || '',
        guestIdNumber: booking.guestIdNumber || '',
        numGuests: booking.numGuests,
        checkInDate: booking.checkInDate,
        checkOutDate: booking.checkOutDate,
        actualCheckIn: booking.actualCheckIn || '',
        actualCheckOut: booking.actualCheckOut || '',
        roomNumber: room?.room_number,
        roomType: room?.room_type,
      };
    }
  }
  return { ...bill, ...stay };
}

function cancelBill(id, reason) {
  const db = loadDb();
  const bill = db.bills.find((b) => b.id === id);
  if (bill) {
    bill.status = 'CANCELLED';
    bill.cancel_reason = reason || 'Cancelled by user';
  }
  saveDb(db);
  return bill;
}

function listBills({ from, to, status, source } = {}) {
  let bills = loadDb().bills;
  if (status) bills = bills.filter((b) => b.status === status);
  if (source === 'FOOD' || source === 'ROOM') bills = bills.filter((b) => b.source === source);
  if (from) bills = bills.filter((b) => new Date(b.created_at) >= startOfDayLocal(from));
  if (to) bills = bills.filter((b) => new Date(b.created_at) <= endOfDayLocal(to));
  return [...bills].sort((a, b) => b.id - a.id);
}

// ---------------- Reporting ----------------
function withinPeriod(bill, period, from, to) {
  const created = new Date(bill.created_at);
  const now = new Date();
  switch (period) {
    case 'today':
      return created.toDateString() === now.toDateString();
    case 'week': {
      const weekAgo = new Date(now.getTime() - 6 * 86400000);
      return created >= weekAgo;
    }
    case 'month':
      return created.getFullYear() === now.getFullYear() && created.getMonth() === now.getMonth();
    case 'year':
      return created.getFullYear() === now.getFullYear();
    case 'custom':
      return (!from || created >= startOfDayLocal(from)) && (!to || created <= endOfDayLocal(to));
    default:
      return true;
  }
}

function getSummary(periodOrOptions) {
  const { period, from, to, source } = typeof periodOrOptions === 'string' ? { period: periodOrOptions } : (periodOrOptions || {});
  const db = loadDb();
  let bills = db.bills.filter((b) => withinPeriod(b, period, from, to));
  if (source === 'FOOD' || source === 'ROOM') bills = bills.filter((b) => b.source === source);

  const completed = bills.filter((b) => b.status === 'COMPLETED');
  const cancelled = bills.filter((b) => b.status === 'CANCELLED');
  const revenue = round2(completed.reduce((s, b) => s + b.total, 0));
  const cashRevenue = round2(completed.filter((b) => b.payment_method === 'CASH').reduce((s, b) => s + b.total, 0));
  const onlineRevenue = round2(completed.filter((b) => b.payment_method === 'ONLINE').reduce((s, b) => s + b.total, 0));
  const avgBill = completed.length ? round2(revenue / completed.length) : 0;

  const itemTotals = {};
  for (const b of completed) {
    for (const it of b.items || []) {
      itemTotals[it.name] = itemTotals[it.name] || { name: it.name, qty: 0, revenue: 0 };
      itemTotals[it.name].qty += it.quantity;
      itemTotals[it.name].revenue += it.price * it.quantity;
    }
  }
  const topItems = Object.values(itemTotals).sort((a, b) => b.qty - a.qty).slice(0, 5);

  return { orderCount: completed.length, revenue, cancelledCount: cancelled.length, cashRevenue, onlineRevenue, avgBill, topItems };
}

// Field names (day/revenue/orders) must mirror the Electron service's
// getSalesTrend() shape, since Reporting/TrendChart.jsx renders both.
function getSalesTrend(periodOrOptions = 'today') {
  const { period } = typeof periodOrOptions === 'string' ? { period: periodOrOptions } : (periodOrOptions || {});
  const db = loadDb();
  const days = period === 'year' ? 365 : period === 'month' ? 30 : 14;
  const buckets = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    buckets[d.toISOString().slice(0, 10)] = { revenue: 0, orders: 0 };
  }
  for (const b of db.bills) {
    if (b.status !== 'COMPLETED') continue;
    const key = new Date(b.created_at).toISOString().slice(0, 10);
    if (key in buckets) {
      buckets[key].revenue += b.total;
      buckets[key].orders += 1;
    }
  }
  return Object.entries(buckets).map(([day, v]) => ({ day, revenue: round2(v.revenue), orders: v.orders }));
}

// ---------------- Inventory: Raw Materials ----------------
function listRawMaterials() {
  return loadDb().rawMaterials;
}

function saveRawMaterial(item) {
  const db = loadDb();
  if (item.id) {
    const idx = db.rawMaterials.findIndex((r) => r.id === item.id);
    if (idx !== -1) db.rawMaterials[idx] = { ...db.rawMaterials[idx], name: item.name, unit: item.unit };
    saveDb(db);
    return item.id;
  }
  const material = { id: nextId(db.rawMaterials), name: item.name, unit: item.unit, current_stock: 0, low_stock_threshold: 0, cost_per_unit: 0 };
  db.rawMaterials.push(material);
  saveDb(db);
  return material.id;
}

function deleteRawMaterial(id) {
  const db = loadDb();
  const hasPurchases = db.purchases.some((p) => p.raw_material_id === id);
  if (hasPurchases) {
    throw new Error('This raw material has purchase history and cannot be deleted. Remove its purchase records first, or keep it for reporting accuracy.');
  }
  db.rawMaterials = db.rawMaterials.filter((r) => r.id !== id);
  saveDb(db);
  return true;
}

// ---------------- Purchases (money spent on stock/supplies) ----------------
function recordPurchase({ raw_material_id, quantity, cost_per_unit, supplier, notes }) {
  if (!(quantity > 0)) throw new Error('Purchase quantity must be a positive number greater than 0.');
  if (!(cost_per_unit > 0)) throw new Error('Purchase cost per unit must be a positive number greater than 0.');
  const db = loadDb();
  const material = db.rawMaterials.find((r) => r.id === raw_material_id);
  if (!material) throw new Error('Raw material not found.');
  const purchase = {
    id: nextId(db.purchases),
    raw_material_id,
    quantity,
    cost_per_unit,
    total_cost: round2(quantity * cost_per_unit),
    supplier: supplier || null,
    notes: notes || null,
    created_at: new Date().toISOString(),
  };
  db.purchases.push(purchase);
  material.cost_per_unit = cost_per_unit;
  saveDb(db);
  return { ...purchase, material_name: material.name, unit: material.unit };
}

function getPurchaseHistory({ from, to } = {}) {
  const db = loadDb();
  let purchases = db.purchases;
  if (from) purchases = purchases.filter((p) => new Date(p.created_at) >= startOfDayLocal(from));
  if (to) purchases = purchases.filter((p) => new Date(p.created_at) <= endOfDayLocal(to));
  return [...purchases]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((p) => {
      const material = db.rawMaterials.find((r) => r.id === p.raw_material_id);
      return { ...p, material_name: material?.name || 'Unknown', unit: material?.unit || '' };
    });
}

// Total spend, purchase count, avg purchase and top items by spend for a period —
// the purchase-side mirror of getSummary() for sales. `withinPeriod` (defined
// above for bills) works fine here too since it only reads `.created_at`.
function getPurchaseSummary(periodOrOptions) {
  const { period, from, to } = typeof periodOrOptions === 'string' ? { period: periodOrOptions } : (periodOrOptions || {});
  const db = loadDb();
  const purchases = db.purchases.filter((p) => withinPeriod(p, period, from, to));
  const purchaseCount = purchases.length;
  const totalSpend = round2(purchases.reduce((s, p) => s + p.total_cost, 0));
  const avgPurchase = purchaseCount > 0 ? round2(totalSpend / purchaseCount) : 0;

  const itemTotals = {};
  for (const p of purchases) {
    const name = db.rawMaterials.find((r) => r.id === p.raw_material_id)?.name || 'Unknown';
    itemTotals[name] = itemTotals[name] || { name, qty: 0, spend: 0 };
    itemTotals[name].qty += p.quantity;
    itemTotals[name].spend += p.total_cost;
  }
  const topItems = Object.values(itemTotals).sort((a, b) => b.spend - a.spend).slice(0, 5);

  return { purchaseCount, totalSpend, avgPurchase, topItems };
}

// Shared daily-bucket trend builder for both Purchases and Expenses, mirroring
// getSalesTrend()'s bucketing rules. `amountKey` picks which field to sum
// (purchase_orders use total_cost, expenses use amount).
function getSpendTrend(records, amountKey, periodOrOptions = 'today') {
  const { period } = typeof periodOrOptions === 'string' ? { period: periodOrOptions } : (periodOrOptions || {});
  const days = period === 'year' ? 365 : period === 'month' ? 30 : 14;
  const buckets = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    buckets[d.toISOString().slice(0, 10)] = { revenue: 0, orders: 0 };
  }
  for (const r of records) {
    const key = new Date(r.created_at).toISOString().slice(0, 10);
    if (key in buckets) {
      buckets[key].revenue += r[amountKey] || 0;
      buckets[key].orders += 1;
    }
  }
  return Object.entries(buckets).map(([day, v]) => ({ day, revenue: round2(v.revenue), orders: v.orders }));
}

function getPurchaseTrend(periodOrOptions = 'today') {
  return getSpendTrend(loadDb().purchases, 'total_cost', periodOrOptions);
}

// ---------------- Expenses (salary, rent, utilities, etc. — not stock purchases) ----------------
function recordExpense({ category, paid_to, amount, payment_method, notes }) {
  if (!(amount > 0)) throw new Error('Expense amount must be a positive number greater than 0.');
  const db = loadDb();
  const expense = {
    id: nextId(db.expenses),
    category: category || 'OTHER',
    paid_to: paid_to || null,
    amount,
    payment_method: payment_method || 'CASH',
    notes: notes || null,
    created_at: new Date().toISOString(),
  };
  db.expenses.push(expense);
  saveDb(db);
  return expense;
}

function getExpenseHistory({ from, to } = {}) {
  const db = loadDb();
  let expenses = db.expenses;
  if (from) expenses = expenses.filter((e) => new Date(e.created_at) >= startOfDayLocal(from));
  if (to) expenses = expenses.filter((e) => new Date(e.created_at) <= endOfDayLocal(to));
  return [...expenses].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// mirror of getPurchaseSummary()/getSummary().
function getExpenseSummary(periodOrOptions) {
  const { period, from, to } = typeof periodOrOptions === 'string' ? { period: periodOrOptions } : (periodOrOptions || {});
  const db = loadDb();
  const expenses = db.expenses.filter((e) => withinPeriod(e, period, from, to));
  const expenseCount = expenses.length;
  const totalSpend = round2(expenses.reduce((s, e) => s + e.amount, 0));
  const avgExpense = expenseCount > 0 ? round2(totalSpend / expenseCount) : 0;

  const catTotals = {};
  for (const e of expenses) {
    catTotals[e.category] = catTotals[e.category] || { category: e.category, spend: 0, count: 0 };
    catTotals[e.category].spend += e.amount;
    catTotals[e.category].count += 1;
  }
  const byCategory = Object.values(catTotals).sort((a, b) => b.spend - a.spend);

  return { expenseCount, totalSpend, avgExpense, byCategory };
}

function getExpenseTrend(periodOrOptions = 'today') {
  return getSpendTrend(loadDb().expenses, 'amount', periodOrOptions);
}

// ---------------- Profit & Loss (combines Sales revenue vs Purchases + Expenses) ----------------
function getProfitAndLoss(periodOrOptions) {
  const sales = getSummary(periodOrOptions);
  const purchases = getPurchaseSummary(periodOrOptions);
  const expenses = getExpenseSummary(periodOrOptions);
  const revenue = sales.revenue || 0;
  const totalPurchases = purchases.totalSpend || 0;
  const totalExpenses = expenses.totalSpend || 0;
  const netProfit = round2(revenue - totalPurchases - totalExpenses);
  return { revenue, totalPurchases, totalExpenses, netProfit, expensesByCategory: expenses.byCategory };
}

// ---------------- Rooms ----------------
function listRooms() {
  return loadDb().rooms;
}

function saveRoom(room) {
  const db = loadDb();
  if (room.id) {
    const idx = db.rooms.findIndex((r) => r.id === room.id);
    if (idx !== -1) db.rooms[idx] = { ...db.rooms[idx], ...room };
  } else {
    if (db.rooms.some((r) => r.room_number === room.room_number)) {
      throw new Error('A room with this number already exists.');
    }
    db.rooms.push({ status: 'ACTIVE', max_occupancy: 2, ...room, id: nextId(db.rooms) });
  }
  saveDb(db);
  return true;
}

function deleteRoom(id) {
  const db = loadDb();
  const activeBookings = db.bookings.some((b) => b.roomId === id && ['BOOKED', 'CHECKED_IN'].includes(b.status));
  if (activeBookings) throw new Error('Cannot delete a room with active bookings.');
  db.rooms = db.rooms.filter((r) => r.id !== id);
  saveDb(db);
  return true;
}

function toggleRoomMaintenance({ id, underMaintenance }) {
  const db = loadDb();
  const room = db.rooms.find((r) => r.id === id);
  if (room) room.status = underMaintenance ? 'MAINTENANCE' : 'ACTIVE';
  saveDb(db);
  return true;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  // Calendar windows are date-only, while bookings are stored as local
  // datetime strings. Compare the same date granularity on both sides so
  // historical completed stays render consistently with the desktop chart.
  const start = (value) => (value || '').slice(0, 10);
  return !(start(aEnd) <= start(bStart) || start(aStart) >= start(bEnd));
}

// Merged availability + front-desk status view: for the given date range,
// each room gets isAvailable (drives the "Book This Room" button) as well as
// todayStatus/guestName/isCheckedIn for whichever booking overlaps that range
// — combining what used to be two separate views into one. Color coding:
// AVAILABLE (green), RESERVED (blue - booked, not arrived), OCCUPIED (red -
// checked in), MAINTENANCE (yellow). CHECKED_IN wins over BOOKED if a room
// somehow matches both.
function getRoomAvailability({ from, to } = {}) {
  const db = loadDb();
  const range = from && to ? { from, to } : { from: new Date().toISOString().slice(0, 10), to: null };

  const bookingByRoom = new Map();
  for (const b of db.bookings) {
    if (!['BOOKED', 'CHECKED_IN'].includes(b.status)) continue;
    const inRange = range.to
      ? overlaps(b.checkInDate, b.checkOutDate, range.from, range.to)
      : b.checkOutDate > range.from;
    if (!inRange) continue;
    const existing = bookingByRoom.get(b.roomId);
    if (!existing || (b.status === 'CHECKED_IN' && existing.status !== 'CHECKED_IN')) bookingByRoom.set(b.roomId, b);
  }

  return db.rooms.map((r) => {
    const booking = bookingByRoom.get(r.id) || null;
    let todayStatus = 'AVAILABLE';
    if (r.status === 'MAINTENANCE') todayStatus = 'MAINTENANCE';
    else if (booking?.status === 'CHECKED_IN') todayStatus = 'OCCUPIED';
    else if (booking?.status === 'BOOKED') todayStatus = 'RESERVED';
    return {
      ...r,
      isAvailable: r.status === 'ACTIVE' && !booking,
      todayStatus,
      guestName: booking?.guestName || null,
      isCheckedIn: booking?.status === 'CHECKED_IN',
      bookingId: booking?.id || null,
      checkInDate: booking?.checkInDate || null,
      checkOutDate: booking?.checkOutDate || null,
    };
  });
}

// Mobile/standalone equivalent of roomService.cjs's getRoomCalendar — same
// tape-chart data shape (rooms with their overlapping bookings list) so the
// same <RoomCalendarView> component works unmodified against localStorage.
function getRoomCalendar({ from, to } = {}) {
  const db = loadDb();
  // Same rationale as roomService.cjs's getRoomCalendar: compute each
  // group's total (non-cancelled) distinct-room count across ALL of its
  // bookings, not just the ones inside this date window.
  const groupCounts = new Map();
  for (const b of db.bookings) {
    if (!b.bookingGroupId || b.status === 'CANCELLED') continue;
    if (!groupCounts.has(b.bookingGroupId)) groupCounts.set(b.bookingGroupId, new Set());
    groupCounts.get(b.bookingGroupId).add(b.roomId);
  }
  const byRoom = new Map();
  for (const b of db.bookings) {
    if (!['BOOKED', 'CHECKED_IN', 'CHECKED_OUT'].includes(b.status)) continue;
    const calendarCheckOut = b.checkOutDate;
    if (!overlaps(b.checkInDate, calendarCheckOut, from, to)) continue;
    if (!byRoom.has(b.roomId)) byRoom.set(b.roomId, []);
    const groupRoomCount = b.bookingGroupId ? (groupCounts.get(b.bookingGroupId)?.size || 1) : 1;
    byRoom.get(b.roomId).push({
      id: b.id,
      guestName: b.guestName,
      checkInDate: b.checkInDate,
      checkOutDate: calendarCheckOut,
      actualCheckOut: b.actualCheckOut || '',
      status: b.status,
      bookingGroupId: b.bookingGroupId || null,
      isGroupBooking: groupRoomCount > 1,
      groupRoomCount,
    });
  }
  return db.rooms.map((r) => ({
    ...r,
    roomNumber: r.room_number,
    roomType: r.room_type,
    bookings: byRoom.get(r.id) || [],
  }));
}

// Opens the device's native file/camera chooser via a hidden <input
// type="file">, then reads the chosen file as a base64 data: URL — this is
// the mobile-safe equivalent of Electron's native "Choose File" dialog +
// filesystem path (there's no real filesystem path to store in a WebView).
// The resulting data: URL is stored directly wherever a desktop file path
// would normally go (food image_path / guestIdDocumentPath) and both
// FoodImage.jsx and <img>/window.open consumers render it correctly as-is.
function pickFileAsDataUrl(accept) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') { resolve(null); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const image = new Image();
        image.onload = () => {
          const maxDimension = 900;
          const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext('2d');
          if (!context) { resolve(reader.result); return; }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.78));
        };
        image.onerror = () => resolve(reader.result);
        image.src = String(reader.result || '');
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    // Some Android WebViews only fire the file picker reliably when the
    // input is briefly attached to the document.
    document.body.appendChild(input);
    input.click();
    setTimeout(() => document.body.removeChild(input), 1000);
  });
}

const ID_DOCUMENT_DB_NAME = 'billnest_id_documents';
const ID_DOCUMENT_STORE = 'documents';

function openIdDocumentDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ID_DOCUMENT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(ID_DOCUMENT_STORE, { keyPath: 'id', autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open attachment storage.'));
  });
}

async function storeIdDocument(file) {
  const db = await openIdDocumentDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(ID_DOCUMENT_STORE, 'readwrite')
      .objectStore(ID_DOCUMENT_STORE)
      .add({ blob: file, name: file.name, type: file.type, createdAt: Date.now() });
    request.onsuccess = () => resolve(`idb://${request.result}`);
    request.onerror = () => reject(request.error || new Error('Could not save attachment.'));
  });
}

function pickIdDocument() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/png,image/jpeg,image/webp,application/pdf';
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (!files.length) { resolve([]); return; }
      try {
        resolve(await Promise.all(files.map(storeIdDocument)));
      } catch (error) {
        console.error('Could not store ID attachment:', error);
        resolve([]);
      }
    };
    document.body.appendChild(input);
    input.click();
    setTimeout(() => { if (input.parentNode) input.parentNode.removeChild(input); }, 1000);
  });
}

async function openIdDocument(fileRef) {
  if (!fileRef) return Promise.resolve(false);
  if (fileRef.startsWith('idb://')) {
    try {
      const db = await openIdDocumentDb();
      const id = Number(fileRef.slice('idb://'.length));
      const record = await new Promise((resolve, reject) => {
        const request = db.transaction(ID_DOCUMENT_STORE, 'readonly').objectStore(ID_DOCUMENT_STORE).get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!record?.blob) return false;
      const url = URL.createObjectURL(record.blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return true;
    } catch (error) {
      console.error('Could not open ID attachment:', error);
      return false;
    }
  }
  if (typeof window !== 'undefined' && window.open) window.open(fileRef, '_blank');
  return Promise.resolve(true);
}

// ---------------- Bookings ----------------
function nights(checkIn, checkOut) {
  // Slice to date-only before constructing Date objects so that any time
  // component doesn't shift the result — matches db/roomService.cjs exactly.
  const d1 = new Date(String(checkIn).slice(0, 10));
  const d2 = new Date(String(checkOut).slice(0, 10));
  const n = Math.round((d2 - d1) / 86400000);
  return Math.max(1, n);
}

function assertRoomAvailable(db, roomId, checkIn, checkOut, excludeId) {
  const clash = db.bookings.some(
    (b) =>
      b.roomId === roomId &&
      b.id !== excludeId &&
      ['BOOKED', 'CHECKED_IN'].includes(b.status) &&
      overlaps(
        b.checkInDate,
        b.actualCheckOut || b.checkOutDate,
        checkIn,
        checkOut
      )
  );
  if (clash) throw new Error('Selected room is not available for the chosen dates.');
}

function mapBooking(db, b) {
  const room = db.rooms.find((r) => r.id === b.roomId);
  const contacts = b.bookingGroupId ? db.bookingContacts.filter((c) => c.bookingGroupId === b.bookingGroupId) : [];
  const groupRooms = b.bookingGroupId
    ? db.bookings
        .filter((x) => x.bookingGroupId === b.bookingGroupId && x.id !== b.id)
        .map((x) => {
          const r = db.rooms.find((rm) => rm.id === x.roomId);
          return { id: x.id, roomId: x.roomId, roomNumber: r?.room_number, roomType: r?.room_type, roomRate: x.roomRate, guestName: x.guestName, status: x.status, checkInDate: x.checkInDate, checkOutDate: x.checkOutDate };
        })
    : [];
  return {
    ...b,
    roomNumber: room?.room_number,
    roomType: room?.room_type,
    addons: db.bookingAddons.filter((a) => a.bookingId === b.id),
    contacts,
    groupRooms,
    advancePayment: b.advancePayment || 0,
  };
}

function makeBookingGroupId() {
  return `BG${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

function fillCloudTemplate(template, booking, settings, bill) {
  const values = {
    guest_name: booking.guestName || '',
    hotel_name: settings.room_biz_name || settings.hotel_name || 'Hotel',
    booking_number: booking.bookingNumber || '',
    check_in: booking.checkInDate || '',
    check_out: booking.checkOutDate || '',
    room: booking.roomNumber || '',
    total: bill?.total ?? booking.total ?? '',
    advance: bill?.advance_payment ?? booking.advancePayment ?? 0,
    hotel_phone: settings.room_biz_phone || settings.hotel_phone || '',
    hotel_address: settings.room_biz_address || settings.hotel_address || '',
  };
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => values[key] == null ? '' : String(values[key]));
}

const CLOUD_OUTBOX_KEY = 'billnest_whatsapp_cloud_outbox_v1';
let cloudOutboxFlush = null;

function readCloudOutbox() {
  try {
    const value = JSON.parse(localStorage.getItem(CLOUD_OUTBOX_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function writeCloudOutbox(entries) {
  localStorage.setItem(CLOUD_OUTBOX_KEY, JSON.stringify(entries.slice(-100)));
}

function enqueueCloudMessage(entry) {
  const entries = readCloudOutbox();
  entries.push({
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    attempts: 0,
    nextAttemptAt: 0,
  });
  writeCloudOutbox(entries);
  void flushCloudOutbox();
}

async function flushCloudOutbox() {
  if (getSettings().whatsapp_mobile_manual_handoff !== 'false') return;
  if (cloudOutboxFlush) return cloudOutboxFlush;
  cloudOutboxFlush = (async () => {
    const entries = readCloudOutbox();
    if (!entries.length) return;
    const now = Date.now();
    let changed = false;
    for (const entry of entries) {
      if (entry.nextAttemptAt > now) continue;
      try {
        if (entry.kind === 'PDF') {
          let pdf = entry.pdfBase64;
          if (!pdf) {
            const generated = await createInvoicePdf(entry.bill);
            pdf = generated.pdfBase64;
            entry.fileName = generated.fileName || entry.fileName;
          }
          await sendCloudPdf(entry.to, pdf, entry.fileName, entry.caption, entry.cloudOptions);
        } else {
          await sendCloudText(entry.to, entry.body, entry.cloudOptions);
        }
        entry.done = true;
        changed = true;
      } catch (err) {
        entry.attempts = (entry.attempts || 0) + 1;
        entry.nextAttemptAt = Date.now() + Math.min(30 * 60 * 1000, 5000 * (2 ** Math.min(entry.attempts, 8)));
        entry.lastError = String(err?.message || err);
        changed = true;
      }
    }
    if (changed) writeCloudOutbox(entries.filter((entry) => !entry.done));
  })().finally(() => {
    cloudOutboxFlush = null;
  });
  return cloudOutboxFlush;
}

export async function flushCloudWhatsAppOutbox() {
  return flushCloudOutbox();
}

function sendCloudRoomMessage(booking, kind, bill) {
  if (getSettings().whatsapp_mobile_manual_handoff !== 'false') return;
  if (Array.isArray(booking)) {
    booking.forEach((item) => sendCloudRoomMessage(item, kind, bill));
    return;
  }
  if (!booking?.guestPhone) return;
  const settings = getSettings();
  if (settings.whatsapp_provider !== 'CLOUD_API') return;
  const triggerKey = kind === 'booking'
    ? 'whatsapp_send_room_booking'
    : kind === 'checkin' ? 'whatsapp_send_room_checkin' : 'whatsapp_send_room_checkout';
  if (settings[triggerKey] === 'false') return;
  const key = kind === 'booking'
    ? 'whatsapp_room_booking_template'
    : kind === 'checkin' ? 'whatsapp_room_checkin_template' : 'whatsapp_room_checkout_template';
  const text = fillCloudTemplate(settings[key], booking, settings, bill);
  const cloudOptions = settings.whatsapp_cloud_template_name
    ? {
      templateName: settings.whatsapp_cloud_template_name,
      templateLanguage: settings.whatsapp_cloud_template_language || 'en_US',
      templateParams: [text],
    }
    : {};
  if (kind === 'checkout') {
    enqueueCloudMessage({
      kind: 'PDF',
      to: booking.guestPhone,
      bill,
      fileName: `Invoice-${bill?.bill_number || booking.bookingNumber || 'Bill'}.pdf`,
      caption: text,
      cloudOptions,
    });
  } else {
    enqueueCloudMessage({ kind: 'TEXT', to: booking.guestPhone, body: text, cloudOptions });
  }
}

// Accepts either the modern shape — payload.rooms: [{roomId, roomRate,
// numGuests}, ...] and payload.contacts: [{name, phone, email,
// specialRequest}, ...] (multi-room + multi-contact bookings) — or the
// original flat single-room shape, normalized into 1-item arrays so existing
// callers keep working. Mirrors db/roomService.cjs's createBooking.
function createBooking(payload) {
  const db = loadDb();
  const rooms = Array.isArray(payload.rooms) && payload.rooms.length
    ? payload.rooms
    : [{ roomId: payload.roomId, roomRate: payload.roomRate, numGuests: payload.numGuests }];
  const contacts = Array.isArray(payload.contacts) && payload.contacts.length
    ? payload.contacts.filter((c) => c && c.name)
    : [{ name: payload.guestName, phone: payload.guestPhone, email: payload.guestEmail, specialRequest: payload.specialRequest }];

  const primaryContact = contacts[0];
  if (!primaryContact?.name) throw new Error('Guest name is required.');
  if (!payload.checkInDate || !payload.checkOutDate) throw new Error('Check-in and check-out dates are required.');
  if (payload.checkOutDate <= payload.checkInDate) throw new Error('Check-out date must be after check-in date.');
  if (!rooms.length || !rooms[0].roomId) throw new Error('At least one room must be selected.');

  const groupId = makeBookingGroupId();
  const created = [];

  rooms.forEach((r, idx) => {
    const room = db.rooms.find((x) => x.id === r.roomId);
    if (!room) throw new Error('Room not found.');
    if (room.status !== 'ACTIVE') throw new Error(`Room ${room.room_number} is under maintenance and cannot be booked.`);
    assertRoomAvailable(db, room.id, payload.checkInDate, payload.checkOutDate);

    db.counters.booking += 1;
    const booking = {
      id: nextId(db.bookings),
      bookingNumber: `BKG-${String(db.counters.booking).padStart(5, '0')}`,
      bookingGroupId: groupId,
      roomId: room.id,
      guestName: primaryContact.name,
      guestPhone: primaryContact.phone || null,
      guestIdType: payload.guestIdType || null,
      guestIdNumber: payload.guestIdNumber || null,
      guestIdDocumentPath: payload.guestIdDocumentPaths?.[0] || payload.guestIdDocumentPath || null,
      guestIdDocumentPaths: payload.guestIdDocumentPaths || (payload.guestIdDocumentPath ? [payload.guestIdDocumentPath] : []),
      guestGstin: payload.guestGstin || null,
      numGuests: r.numGuests || payload.numGuests || 1,
      checkInDate: payload.checkInDate,
      checkOutDate: payload.checkOutDate,
      roomRate: r.roomRate != null ? r.roomRate : room.base_price,
      touristTax: payload.touristTax || 0,
      discount: idx === 0 ? payload.discount || 0 : 0,
      taxPercent: payload.taxPercent != null ? payload.taxPercent : 0,
      paymentMethod: payload.paymentMethod || null,
      advancePayment: idx === 0 ? payload.advancePayment || 0 : 0,
      advancePaymentMethod: payload.advancePaymentMethod || null,
      status: 'BOOKED',
      notes: payload.notes || null,
      billId: null,
      createdAt: nowLocal(),
    };
    db.bookings.push(booking);
    if (idx === 0 && Array.isArray(payload.addons)) {
      for (const a of payload.addons) {
        const total = round2((a.price || 0) * (a.quantity || 1));
        db.bookingAddons.push({ id: nextId(db.bookingAddons), bookingId: booking.id, name: a.name, price: a.price, quantity: a.quantity || 1, total });
      }
    }
    created.push(booking);
  });

  for (const c of contacts) {
    if (!c?.name) continue;
    db.bookingContacts.push({ id: nextId(db.bookingContacts), bookingGroupId: groupId, name: c.name, phone: c.phone || null, email: c.email || null, specialRequest: c.specialRequest || null });
  }

  saveDb(db);
  const result = created.length > 1 ? created.map((b) => mapBooking(db, b)) : mapBooking(db, created[0]);
  sendCloudRoomMessage(result, 'booking');
  return result;
}

// Mobile equivalent of roomService.cjs's addRoomToBookingGroup — adds one
// more room to an existing multi-room reservation, reusing the group's
// guest details and stay dates.
function addRoomToBookingGroup({ groupId, room }) {
  const db = loadDb();
  if (!groupId) throw new Error('This booking is not part of a group.');
  const reference = db.bookings.find((b) => b.bookingGroupId === groupId);
  if (!reference) throw new Error('Original booking not found.');
  if (!room || !room.roomId) throw new Error('Please select a room to add.');

  const target = db.rooms.find((x) => x.id === room.roomId);
  if (!target) throw new Error('Room not found.');
  if (target.status !== 'ACTIVE') throw new Error(`Room ${target.room_number} is under maintenance and cannot be booked.`);
  assertRoomAvailable(db, target.id, reference.checkInDate, reference.checkOutDate);

  db.counters.booking += 1;
  const booking = {
    id: nextId(db.bookings),
    bookingNumber: `BKG-${String(db.counters.booking).padStart(5, '0')}`,
    bookingGroupId: groupId,
    roomId: target.id,
    guestName: reference.guestName,
    guestPhone: reference.guestPhone || null,
    guestIdType: reference.guestIdType || null,
    guestIdNumber: reference.guestIdNumber || null,
    guestIdDocumentPath: reference.guestIdDocumentPaths?.[0] || reference.guestIdDocumentPath || null,
    guestIdDocumentPaths: reference.guestIdDocumentPaths || (reference.guestIdDocumentPath ? [reference.guestIdDocumentPath] : []),
    guestGstin: reference.guestGstin || null,
    numGuests: room.numGuests || 1,
    checkInDate: reference.checkInDate,
    checkOutDate: reference.checkOutDate,
    roomRate: room.roomRate != null ? room.roomRate : target.base_price,
    touristTax: 0,
    discount: 0,
    taxPercent: reference.taxPercent || 0,
    paymentMethod: reference.paymentMethod || null,
    advancePayment: 0,
    advancePaymentMethod: reference.advancePaymentMethod || null,
    status: 'BOOKED',
    notes: null,
    billId: null,
    createdAt: nowLocal(),
  };
  db.bookings.push(booking);
  saveDb(db);
  return mapBooking(db, booking);
}

function updateBooking({ id, payload }) {
  const db = loadDb();
  const existing = db.bookings.find((b) => b.id === id);
  if (!existing) throw new Error('Booking not found.');
  if (['CHECKED_OUT', 'CANCELLED'].includes(existing.status)) {
    throw new Error('Cannot modify a booking that is already checked out or cancelled.');
  }
  const roomId = payload.roomId != null ? payload.roomId : existing.roomId;
  const checkInDate = payload.checkInDate || existing.checkInDate;
  const checkOutDate = payload.checkOutDate || existing.checkOutDate;
  if (checkOutDate <= checkInDate) throw new Error('Check-out date must be after check-in date.');
  assertRoomAvailable(db, roomId, checkInDate, checkOutDate, id);
  Object.assign(existing, payload, { roomId, checkInDate, checkOutDate });
  saveDb(db);
  return mapBooking(db, existing);
}

function checkInBooking(id) {
  const db = loadDb();
  const booking = db.bookings.find((b) => b.id === id);
  if (!booking) throw new Error('Booking not found.');
  if (booking.status !== 'BOOKED') throw new Error('Only a booked reservation can be checked in.');
  // Same guards as the Electron/host backend (db/roomService.cjs): block
  // checking in ahead of the actual check-in date, and block check-in into
  // a room that's since been put under maintenance.
  // Exception: if this room is part of a group and at least one sibling is
  // already CHECKED_IN or CHECKED_OUT, allow early check-in and advance the
  // check-in date to today so billing computes correctly.
  const todayStr = new Date().toLocaleDateString('en-CA');
  const checkInDateOnly = (booking.checkInDate || '').slice(0, 10);
  if (checkInDateOnly > todayStr) {
    let allowEarly = false;
    if (booking.bookingGroupId) {
      allowEarly = db.bookings.some(
        (b) => b.bookingGroupId === booking.bookingGroupId && b.id !== id &&
               (b.status === 'CHECKED_IN' || b.status === 'CHECKED_OUT')
      );
    }
    if (!allowEarly) {
      throw new Error(`This booking's check-in date is ${checkInDateOnly}, which is in the future. It can't be checked in yet.`);
    }
    const timeComponent = (booking.checkInDate || '').slice(11) || '14:00';
    booking.checkInDate = `${todayStr}T${timeComponent}`;
  }
  const room = (db.rooms || []).find((r) => r.id === booking.roomId);
  if (room && room.status !== 'ACTIVE') {
    throw new Error(`Room ${room.roomNumber || room.room_number} is currently under maintenance and cannot be checked into.`);
  }
  booking.status = 'CHECKED_IN';
  booking.actualCheckIn = nowLocal();
  saveDb(db);
  const result = mapBooking(db, booking);
  sendCloudRoomMessage(result, 'checkin');
  return result;
}

function checkOutBooking(id, paymentMethod) {
  const db = loadDb();
  const booking = db.bookings.find((b) => b.id === id);
  if (!booking) throw new Error('Booking not found.');
  if (!['CHECKED_IN', 'BOOKED'].includes(booking.status)) throw new Error('Booking is already checked out or cancelled.');
  // Same guard as check-in: a stay can't be checked out before it has even
  // started (also closes the gap where a BOOKED reservation could skip
  // check-in entirely and jump straight to CHECKED_OUT for a future date).
  const todayStr = new Date().toLocaleDateString('en-CA');
  const checkInDateOnly = (booking.checkInDate || '').slice(0, 10);
  if (checkInDateOnly > todayStr) {
    let allowEarly = false;
    if (booking.bookingGroupId) {
      allowEarly = db.bookings.some(
        (b) => b.bookingGroupId === booking.bookingGroupId && b.id !== id &&
               (b.status === 'CHECKED_IN' || b.status === 'CHECKED_OUT')
      );
    }
    if (!allowEarly) {
      throw new Error(`This booking's check-in date is ${checkInDateOnly}, which is in the future. It can't be checked out yet.`);
    }
    const timeComponent = (booking.checkInDate || '').slice(11) || '14:00';
    booking.checkInDate = `${todayStr}T${timeComponent}`;
  }
  const finalPaymentMethod = paymentMethod || booking.paymentMethod;
  if (!finalPaymentMethod) throw new Error('Please select a payment method before checkout.');

  const mapped = mapBooking(db, booking);
  const numNights = nights(booking.checkInDate, booking.checkOutDate);
  const items = [
    { name: `Room ${mapped.roomNumber} (${mapped.roomType}) x ${numNights} night${numNights > 1 ? 's' : ''}`, price: booking.roomRate, quantity: numNights },
  ];
  for (const a of mapped.addons) items.push({ name: a.name, price: a.price, quantity: a.quantity });
  if (booking.touristTax > 0) items.push({ name: 'Tourist Tax', price: booking.touristTax, quantity: 1 });

  const orderNoteParts = [`Room Booking ${booking.bookingNumber} - Room ${mapped.roomNumber}`];
  if (booking.guestGstin) orderNoteParts.push(`Guest GSTIN: ${booking.guestGstin}`);
  if (booking.advancePayment > 0) orderNoteParts.push(`Less: Advance Payment Received ₹${booking.advancePayment}`);

  // createBill() does its own loadDb()/saveDb() round-trip on a separate in-
  // memory copy of the "database", so the `db` snapshot loaded at the top of
  // this function is now stale (missing the bill it just persisted). Saving
  // that stale snapshot afterwards would silently overwrite/erase the newly
  // created bill from storage — which is exactly what was happening here,
  // making every room-booking invoice disappear right after checkout (shown
  // to the user as "Bill not found. It may have been removed."). Re-load a
  // fresh copy after createBill() returns and apply the checkout updates to
  // that instead.
  const bill = createBill({
    items,
    paymentMethod: finalPaymentMethod,
    customerName: booking.guestName,
    customerPhone: booking.guestPhone,
    discount: booking.discount || 0,
    advancePayment: booking.advancePayment || 0,
    taxPercent: booking.taxPercent || 0,
    orderNote: orderNoteParts.join(' | '),
    skipKot: true,
    source: 'ROOM',
    bookingNumber: booking.bookingNumber,
  });

  const freshDb = loadDb();
  const freshBooking = freshDb.bookings.find((b) => b.id === id);
  freshBooking.status = 'CHECKED_OUT';
  freshBooking.actualCheckOut = nowLocal();
  freshBooking.billId = bill.id;
  saveDb(freshDb);
  const result = { booking: mapBooking(freshDb, freshBooking), bill };
  sendCloudRoomMessage(result.booking, 'checkout', bill);
  return result;
}

function cancelBooking({ id, reason, refund, refundMethod }) {
  const db = loadDb();
  const booking = db.bookings.find((b) => b.id === id);
  if (!booking) throw new Error('Booking not found.');
  if (booking.status === 'CHECKED_OUT') throw new Error('Cannot cancel a booking that has already been checked out.');
  if (booking.status === 'CANCELLED') throw new Error('This booking is already cancelled.');
  const advance = booking.advancePayment || 0;
  let refundAmount = null;
  if (advance > 0) {
    refundAmount = refund != null ? Math.max(0, Math.min(parseFloat(refund) || 0, advance)) : advance;
  }
  booking.status = 'CANCELLED';
  booking.cancelReason = reason || null;
  booking.refundAmount = refundAmount;
  booking.refundMethod = refundAmount > 0 ? (refundMethod || booking.advancePaymentMethod || 'CASH') : null;
  saveDb(db);
  return mapBooking(db, booking);
}

function cancelGroupBooking({ groupId, reason, refund, refundMethod }) {
  const db = loadDb();
  const groupBookings = db.bookings.filter((b) => b.bookingGroupId === groupId);
  if (!groupBookings.length) throw new Error('Group booking not found.');
  const cancellable = groupBookings.filter((b) => b.status !== 'CHECKED_OUT' && b.status !== 'CANCELLED');
  if (!cancellable.length) throw new Error('All rooms in this group are already checked out or cancelled.');
  const masterBooking = groupBookings.find((b) => !/-R\d+$/.test(b.bookingNumber || '')) || groupBookings[0];
  const groupAdvance = masterBooking.advancePayment || 0;
  for (const booking of cancellable) {
    const isMaster = booking.id === masterBooking.id;
    let rowRefundAmount = null;
    if (isMaster && groupAdvance > 0) {
      rowRefundAmount = refund != null ? Math.max(0, Math.min(parseFloat(refund) || 0, groupAdvance)) : groupAdvance;
    }
    booking.status = 'CANCELLED';
    booking.cancelReason = reason || null;
    booking.refundAmount = rowRefundAmount;
    booking.refundMethod = rowRefundAmount > 0 ? (refundMethod || booking.advancePaymentMethod || 'CASH') : null;
  }
  saveDb(db);
  return groupBookings.map((b) => mapBooking(db, b));
}

function addBookingAddon({ bookingId, addon }) {
  const db = loadDb();
  const total = round2((addon.price || 0) * (addon.quantity || 1));
  const record = { id: nextId(db.bookingAddons), bookingId, name: addon.name, price: addon.price, quantity: addon.quantity || 1, total };
  db.bookingAddons.push(record);
  saveDb(db);
  return record.id;
}

function removeBookingAddon(addonId) {
  const db = loadDb();
  db.bookingAddons = db.bookingAddons.filter((a) => a.id !== addonId);
  saveDb(db);
  return true;
}

function listBookings({ status, from, to, search } = {}) {
  const db = loadDb();
  let bookings = db.bookings;
  if (status) bookings = bookings.filter((b) => b.status === status);
  if (from) bookings = bookings.filter((b) => b.checkOutDate >= from);
  if (to) bookings = bookings.filter((b) => b.checkInDate <= to);
  if (search && search.trim()) {
    const term = search.trim().toLowerCase();
    bookings = bookings.filter((b) => {
      if ((b.guestName || '').toLowerCase().includes(term)) return true;
      if ((b.guestPhone || '').toLowerCase().includes(term)) return true;
      if ((b.bookingNumber || '').toLowerCase().includes(term)) return true;
      const hasMatchingBill = db.bills.some(
        (bl) => bl.booking_number === b.bookingNumber && (bl.bill_number || '').toLowerCase().includes(term)
      );
      return hasMatchingBill;
    });
  }

  // Pull in sibling rooms that share the same group booking but whose own
  // check-in/out dates fall outside the current filter window — same logic
  // as db/roomService.cjs. E.g. a group books Room A (Sep 14) and Room B
  // (Sep 16): filtering by "Today" (Sep 14) should still show Room B so
  // the front desk can manage the whole reservation in one place.
  // Date filter is intentionally dropped for siblings; status filter kept.
  const knownIds = new Set(bookings.map((b) => b.id));
  const groupIds = [...new Set(bookings.map((b) => b.bookingGroupId).filter(Boolean))];
  if (groupIds.length) {
    const siblings = db.bookings.filter(
      (b) => groupIds.includes(b.bookingGroupId) && !knownIds.has(b.id) && (!status || b.status === status)
    );
    bookings = [...bookings, ...siblings];
  }

  return [...bookings].sort((a, b) => b.id - a.id).map((b) => mapBooking(db, b));
}

function getBookingById(id) {
  const db = loadDb();
  const booking = db.bookings.find((b) => b.id === id);
  return booking ? mapBooking(db, booking) : null;
}

// Combined Group Invoice (mobile/offline mirror of roomService.getGroupInvoiceData):
// merges every already-generated per-room bill in a booking group into one
// read-only view. Never creates a new bill — each room's revenue was already
// recorded correctly on its own bill at its own checkout.
function getGroupInvoiceData(groupId) {
  const db = loadDb();
  const rows = db.bookings.filter((b) => b.bookingGroupId === groupId);
  if (!rows.length) return null;

  const pending = rows.filter((r) => !['CHECKED_OUT', 'CANCELLED'].includes(r.status));
  if (pending.length > 0) {
    throw new Error('All rooms in this booking must be checked out before a combined invoice can be generated.');
  }

  const billedRows = rows.filter((r) => r.billId);
  if (!billedRows.length) return null;

  const rooms = [];
  let subtotal = 0;
  let taxAmount = 0;
  let discount = 0;
  let total = 0;
  let advancePayment = 0;
  let guestName = null;
  let latestCreatedAt = null;
  const paymentMethods = new Set();

  for (const row of billedRows) {
    const bill = db.bills.find((b) => b.id === row.billId);
    if (!bill) continue;
    const mapped = mapBooking(db, row);
    rooms.push({
      bookingId: row.id,
      bookingNumber: row.bookingNumber,
      roomNumber: mapped.roomNumber,
      roomType: mapped.roomType,
      guestName: row.guestName,
      guestPhone: row.guestPhone || '',
      numGuests: row.numGuests,
      checkInDate: row.actualCheckIn || row.checkInDate,
      checkOutDate: row.actualCheckOut || row.checkOutDate,
      billId: bill.id,
      billNumber: bill.bill_number,
      items: bill.items || [],
      subtotal: bill.subtotal || 0,
      taxAmount: bill.tax_amount || 0,
      discount: bill.discount || 0,
      advancePayment: bill.advance_payment || 0,
      balanceDue: bill.balance_due != null ? bill.balance_due : bill.total || 0,
      total: bill.total || 0,
      paymentMethod: bill.payment_method,
    });
    subtotal += bill.subtotal || 0;
    taxAmount += bill.tax_amount || 0;
    discount += bill.discount || 0;
    total += bill.total || 0;
    advancePayment += bill.advance_payment || 0;
    if (!guestName) guestName = row.guestName;
    if (!latestCreatedAt || bill.created_at > latestCreatedAt) latestCreatedAt = bill.created_at;
    paymentMethods.add(bill.payment_method);
  }

  if (!rooms.length) return null;

  return {
    groupId,
    groupInvoiceNumber: `GRP-${groupId}`,
    guestName,
    createdAt: latestCreatedAt,
    paymentMethod: paymentMethods.size === 1 ? [...paymentMethods][0] : 'MIXED',
    rooms,
    subtotal,
    taxAmount,
    discount,
    advancePayment,
    balanceDue: round2(total - advancePayment),
    total,
    ...getBillIdentity(db.settings, 'ROOM'),
  };
}

// ---------------- Users / PIN login ----------------
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function genSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sanitizeUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, role: u.role, access: u.role === 'OWNER' ? 'BOTH' : (u.access || 'BOTH'), active: !!u.active, createdAt: u.createdAt };
}

function normalizeAccess(access) {
  return ['FOOD', 'ROOMS', 'BOTH'].includes(access) ? access : 'BOTH';
}

function hasOwnerAccount() {
  const db = loadDb();
  return db.users.some((u) => u.role === 'OWNER' && u.active);
}

// A short, easy-to-copy recovery code (e.g. "B7K4-9QXP") generated once at
// Owner account creation, shown to the owner exactly once, and stored only
// as a salted hash — this is the mobile-demo fallback for "Forgot PIN" since
// there's no backend here to send a real email OTP from.
function genRecoveryCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function createOwnerAccount({ name, pin }) {
  if (hasOwnerAccount()) throw new Error('An owner account already exists.');
  if (!pin || !/^\d{4,6}$/.test(pin)) throw new Error('PIN must be 4 to 6 digits.');
  const db = loadDb();
  const salt = genSalt();
  const recoveryCode = genRecoveryCode();
  const recoverySalt = genSalt();
  const user = {
    id: nextId(db.users),
    name: name || 'Owner',
    role: 'OWNER',
    pinHash: await sha256Hex(`${salt}:${pin}`),
    pinSalt: salt,
    recoveryCodeHash: await sha256Hex(`${recoverySalt}:${recoveryCode}`),
    recoveryCodeSalt: recoverySalt,
    active: true,
    createdAt: nowLocal(),
  };
  db.users.push(user);
  saveDb(db);
  // Only ever returned this one time — the caller (Setup Wizard) must show
  // it to the owner and tell them to save it somewhere safe.
  return { ...sanitizeUser(user), recoveryCode };
}

async function createStaffAccount({ name, pin, access }) {
  if (!name) throw new Error('Staff name is required.');
  if (!pin || !/^\d{4,6}$/.test(pin)) throw new Error('PIN must be 4 to 6 digits.');
  const db = loadDb();
  const salt = genSalt();
  const user = { id: nextId(db.users), name, role: 'STAFF', access: normalizeAccess(access), pinHash: await sha256Hex(`${salt}:${pin}`), pinSalt: salt, active: true, createdAt: nowLocal() };
  db.users.push(user);
  saveDb(db);
  return sanitizeUser(user);
}

function updateUserAccess(id, access) {
  const db = loadDb();
  const user = db.users.find((u) => u.id === id);
  if (!user) throw new Error('User not found.');
  if (user.role === 'OWNER') throw new Error('The Owner account always has full access.');
  user.access = normalizeAccess(access);
  saveDb(db);
  return sanitizeUser(user);
}

function listUsers() {
  const db = loadDb();
  return [...db.users].sort((a, b) => (b.role === 'OWNER') - (a.role === 'OWNER')).map(sanitizeUser);
}

function deactivateUser(id) {
  const db = loadDb();
  const user = db.users.find((u) => u.id === id);
  if (!user) throw new Error('User not found.');
  if (user.role === 'OWNER') throw new Error('Cannot deactivate the Owner account.');
  user.active = false;
  saveDb(db);
  return true;
}

async function resetUserPin({ id, newPin }) {
  if (!newPin || !/^\d{4,6}$/.test(newPin)) throw new Error('PIN must be 4 to 6 digits.');
  const db = loadDb();
  const user = db.users.find((u) => u.id === id);
  if (!user) throw new Error('User not found.');
  const salt = genSalt();
  user.pinHash = await sha256Hex(`${salt}:${newPin}`);
  user.pinSalt = salt;
  saveDb(db);
  return true;
}

async function loginWithPin(pin) {
  const db = loadDb();
  for (const u of db.users) {
    if (!u.active) continue;
    if ((await sha256Hex(`${u.pinSalt}:${pin}`)) === u.pinHash) return sanitizeUser(u);
  }
  return null;
}

// Self-service PIN change (Owner or Staff), re-proving the current PIN first.
async function changeMyPin({ id, currentPin, newPin }) {
  if (!newPin || !/^\d{4,6}$/.test(newPin)) throw new Error('New PIN must be 4 to 6 digits.');
  const db = loadDb();
  const user = db.users.find((u) => u.id === id);
  if (!user) throw new Error('User not found.');
  if ((await sha256Hex(`${user.pinSalt}:${currentPin}`)) !== user.pinHash) throw new Error('Current PIN is incorrect.');
  const salt = genSalt();
  user.pinHash = await sha256Hex(`${salt}:${newPin}`);
  user.pinSalt = salt;
  saveDb(db);
  return true;
}

// Forgot PIN (mobile fallback): verify the one-time recovery code shown at
// setup instead of an email OTP (no backend here to send real email from).
async function verifyRecoveryCodeAndResetPin(code, newPin) {
  if (!newPin || !/^\d{4,6}$/.test(newPin)) throw new Error('New PIN must be 4 to 6 digits.');
  const db = loadDb();
  const owner = db.users.find((u) => u.role === 'OWNER' && u.active);
  if (!owner || !owner.recoveryCodeHash) throw new Error('No recovery code was set up for this account.');
  const attemptHash = await sha256Hex(`${owner.recoveryCodeSalt}:${(code || '').trim().toUpperCase()}`);
  if (attemptHash !== owner.recoveryCodeHash) throw new Error('Incorrect recovery code.');
  const salt = genSalt();
  owner.pinHash = await sha256Hex(`${salt}:${newPin}`);
  owner.pinSalt = salt;
  saveDb(db);
  return true;
}

// ---------------- Data continuity: export/import the whole local "database" ----------------
// There's no OS-level filesystem/Google-Drive-API integration bundled here —
// instead we lean on two Web APIs the Android WebView already supports, so
// this needs zero new native plugins:
//  - Export uses navigator.share() with a File, which opens Android's native
//    share sheet (Google Drive is offered there automatically if installed).
//  - Import uses a hidden <input type="file">, which opens Android's native
//    document picker (Storage Access Framework) — Google Drive shows up
//    there too as a document source. The picked file never needs an API key
//    because Android (not us) is brokering access to Drive.
function exportAllData() {
  return JSON.stringify(loadDb(), null, 2);
}

// Mobile-standalone counterpart to the desktop "BillNest Reset" tool
// (electron/factoryReset.cjs). Only meaningful when this phone holds its own
// local data (Settings > Connect to a Counter > Standalone) — a phone
// connected to a Host has nothing local to wipe, that reset happens on the
// Host itself. Same keep/wipe policy as desktop for parity:
//   KEEP  — food menu/categories, raw materials catalog (stock zeroed, not
//           deleted), rooms & tables lists (status reset, not deleted).
//   WIPE  — hotel settings (back to blank/defaults), all owner/staff
//           accounts (next launch requires a fresh Owner PIN setup), and all
//           bills/bookings/purchases/expenses history.
async function factoryReset({ confirmText, ownerPin } = {}) {
  if ((confirmText || '').trim().toUpperCase() !== 'RESET') {
    throw new Error('Please type RESET exactly to confirm.');
  }
  const db = loadDb();
  if (hasOwnerAccount()) {
    const user = await loginWithPin((ownerPin || '').trim());
    if (!user || user.role !== 'OWNER') {
      throw new Error('Incorrect Owner PIN.');
    }
  }
  const resetDb = {
    settings: {
      hotel_name: 'Your Hotel Name',
      hotel_address: 'Your Hotel Address',
      hotel_phone: '',
      hotel_gstin: '',
      upi_id: '',
      tax_percent: '5',
      tax_percent_cash: '5',
      tax_percent_online: '5',
      bill_footer: 'Thank you! Visit again.',
      room_biz_name: 'Your Hotel Name',
      room_biz_address: 'Your Hotel Address',
      room_biz_phone: '',
      room_biz_gstin: '',
      room_upi_id: '',
      room_bill_footer: 'Thank you! Visit again.',
      room_biz_logo_path: '',
      room_tax_percent_cash: '0',
      room_tax_percent_online: '0',
      setup_completed: 'false',
      feature_table_management: 'false',
      feature_captain_app: 'false',
      feature_multi_terminal_sync: 'false',
      whatsapp_room_booking_template: '',
      whatsapp_room_checkin_template: '',
      whatsapp_room_checkout_template: '',
    },
    categories: db.categories,
    foodItems: db.foodItems,
    bills: [],
    billItems: [],
    tables: (db.tables || []).map((t) => ({ ...t, status: 'EMPTY' })),
    rooms: (db.rooms || []).map((r) => ({ ...r, status: 'ACTIVE' })),
    bookings: [],
    bookingAddons: [],
    bookingContacts: [],
    users: [],
    rawMaterials: (db.rawMaterials || []).map((m) => ({ ...m, current_stock: 0 })),
    purchases: [],
    expenses: [],
    counters: { bill: 0, kot: 0, booking: 0, tokenCash: 0, tokenOnline: 0 },
  };
  saveDb(resetDb);
  return true;
}

function importAllData(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`That file is not a valid ${APP_NAME} backup (not valid JSON).`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.bills) || !Array.isArray(parsed.users)) {
    throw new Error(`That file is not a valid ${APP_NAME} backup.`);
  }
  saveDb(parsed);
  return true;
}

// ---------------- Desktop-only no-ops (graceful degrade on mobile) ----------------
function noop() { return Promise.resolve(null); }
function openRecordsFolder() {
  alert('Bill Records are stored on this device only in the mobile demo build.');
  return Promise.resolve(true);
}

// ---------------- Bill / KOT display (single-webview equivalent of the ----------------
// desktop's separate popup windows). There's no OS-level "new window" on
// Android/browser, so we navigate this same app to the #/bill/:id or
// #/kot/:id hash route (already handled globally in App.jsx) instead. A
// cache-busting query string forces BillWindow/KotWindow to remount and
// refetch even when re-opening the same id — see App.jsx's key={hash}.
function navigateTo(hashRoute) {
  if (typeof window === 'undefined' || !window.location) return;
  window.location.hash = `${hashRoute}?_=${Date.now()}`;
}

async function openBillWindow(id) {
  navigateTo(`#/bill/${id}`);
  return true;
}

async function printBill(id) {
  navigateTo(`#/bill/${id}`);
  // Give the route time to mount and fetch the bill before invoking the
  // browser's print dialog (mirrors the 350ms the desktop app waits for the
  // receipt to render before calling webContents.print()).
  await new Promise((r) => setTimeout(r, 400));
  if (typeof window !== 'undefined' && window.print) window.print();
  return true;
}

async function openKotWindow(id) {
  navigateTo(`#/kot/${id}`);
  return true;
}

async function printKot(id) {
  navigateTo(`#/kot/${id}`);
  await new Promise((r) => setTimeout(r, 400));
  if (typeof window !== 'undefined' && window.print) window.print();
  return true;
}

export function createWebApi() {
  flushCloudOutbox();
  if (typeof window !== 'undefined') {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', flushCloudOutbox);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') flushCloudOutbox();
      });
    }
  }
  return {
    getSettings: async () => getSettings(),
    saveSettings: async (partial) => saveSettings(partial),
    getWhatsAppStatus: async () => {
      const settings = getSettings();
      if (settings.whatsapp_provider !== 'CLOUD_API') return { status: 'DISCONNECTED', provider: 'BAILEYS' };
      const status = await getCloudApiStatus();
      return { status: status.configured ? 'CONNECTED' : 'DISCONNECTED', provider: 'CLOUD_API', configured: !!status.configured, phoneNumberId: status.phoneNumberId || '' };
    },
    configureWhatsAppCloudApi: async (accessToken, phoneNumberId) => configureCloudApi(accessToken, phoneNumberId),
    clearWhatsAppCloudApi: async () => clearCloudApi(),
    sendWhatsAppTest: async (phone) => {
      const settings = getSettings();
      const body = `This is a test message from ${APP_NAME} ✅`;
      return sendCloudText(phone, body, settings.whatsapp_cloud_template_name ? {
        templateName: settings.whatsapp_cloud_template_name,
        templateLanguage: settings.whatsapp_cloud_template_language || 'en_US',
        templateParams: [body],
      } : {});
    },
    onWhatsAppStatusChanged: () => () => {},
    listCategories: async () => listCategories(),
    addCategory: async (name) => addCategory(name),
    listTables: async () => listTables(),
    saveTable: async (table) => saveTable(table),
    deleteTable: async (id) => deleteTable(id),
    updateTableStatus: async (id, status) => updateTableStatus(id, status),
    assignTableWaiter: async (id, waiterName) => assignTableWaiter(id, waiterName),
    getTableOrder: async (id) => getTableOrder(id),
    saveTableOrder: async (id, payload) => saveTableOrder(id, payload),
    clearTableOrder: async (id) => clearTableOrder(id),
    // Multi-Terminal Sync config — backed by remoteConfig localStorage so the
    // FeaturesSection can read/write role (HOST_DEVICE / CLIENT / LOCAL) on
    // Android the same way it does on desktop via electron/syncConfig.cjs.
    // getSyncConfig being defined (not undefined) is what tells FeaturesSection
    // to show the Host/Client role picker instead of the "configure from desktop" notice.
    getSyncConfig: async () => {
      const cfg = getRemoteConfig();
      // Map mobile modes to the role names FeaturesSection expects
      const role = cfg.mode === 'HOST_DEVICE' ? 'HOST' : cfg.mode === 'CLIENT' ? 'CLIENT' : 'HOST';
      return { role, hostIp: cfg.hostIp || '', port: cfg.hostPort || '4001', authToken: cfg.authToken || '' };
    },
    saveSyncConfig: async (partial) => {
      const cfg = getRemoteConfig();
      // Map FeaturesSection's role names back to mobile mode values
      const modeMap = { HOST: 'HOST_DEVICE', CLIENT: 'CLIENT' };
      const mode = partial.role ? (modeMap[partial.role] || cfg.mode) : cfg.mode;
      const saved = saveRemoteConfig({
        mode,
        hostIp: partial.hostIp !== undefined ? partial.hostIp : cfg.hostIp,
        hostPort: partial.port !== undefined ? partial.port : cfg.hostPort,
        authToken: partial.authToken !== undefined ? partial.authToken : cfg.authToken,
      });
      const role = saved.mode === 'HOST_DEVICE' ? 'HOST' : saved.mode === 'CLIENT' ? 'CLIENT' : 'HOST';
      return { role, hostIp: saved.hostIp, port: saved.hostPort };
    },
    getSyncStatus: async () => {
      const cfg = getRemoteConfig();
      const isHost = cfg.mode === 'HOST_DEVICE';
      if (!isHost) return { running: false, ip: '', port: 4001, supported: true };
      // Ask the host server for real running state + actual device IP
      try {
        const { getHostServerStatus, getDeviceLocalIp } = await import('./hostServer.js');
        const [status, ip] = await Promise.all([getHostServerStatus(), getDeviceLocalIp()]);
        return { running: status.running, ip, port: cfg.hostPort || 4001, supported: true };
      } catch {
        return { running: false, ip: '(this device)', port: cfg.hostPort || 4001, supported: true };
      }
    },
    restartSync: async () => {
      const cfg = getRemoteConfig();
      const isHost = cfg.mode === 'HOST_DEVICE';
      if (!isHost) return { running: false, ip: '', supported: true };
      try {
        const { startHostServer, getHostServerStatus, getDeviceLocalIp } = await import('./hostServer.js');
        const port = Number(cfg.hostPort) || 4001;
        await startHostServer(port, cfg.authToken);
        const [status, ip] = await Promise.all([getHostServerStatus(), getDeviceLocalIp()]);
        return { running: status.running, ip, supported: true };
      } catch (err) {
        return { running: false, ip: '', supported: true, error: err?.message };
      }
    },
    listFood: async (filters) => listFood(filters),
    getPopularFood: async (limit) => getPopularFood(limit),
    saveFood: async (item) => saveFood(item),
    deleteFood: async (id) => deleteFood(id),
    pickImage,
    createBill: async (payload) => {
      // Deliberately does NOT navigate anywhere itself. Which window (Bill or
      // KOT) should be shown depends entirely on which "Generate" button the
      // cashier pressed, and Cart.jsx already knows that (printMode). Forcing
      // a navigateTo('#/bill/...') here used to race against the caller's own
      // openBillWindow/printBill/printKot navigation right after, and — since
      // this single-webview app has only one active route at a time — the
      // loser of that race silently never showed up (the "KOT never opens"
      // bug). Let the caller be the single source of truth for navigation.
      return createBill(payload);
    },
    getBillById: async (id) => getBillById(id),
    cancelBill: async (id, reason) => cancelBill(id, reason),
    listBills: async (filters) => listBills(filters),
    openRecordsFolder,
    openBillWindow,
    printBill,
    openKotWindow,
    openKotRecordsFolder: openRecordsFolder,
    printKot,
    getSummary: async (payload) => getSummary(payload),
    getSalesTrend: async (payload) => getSalesTrend(payload),
    getProfitLoss: async (payload) => getProfitAndLoss(payload),
    listRawMaterials: async () => listRawMaterials(),
    saveRawMaterial: async (item) => saveRawMaterial(item),
    deleteRawMaterial: async (id) => deleteRawMaterial(id),
    recordPurchase: async (payload) => recordPurchase(payload),
    getPurchaseHistory: async (filters) => getPurchaseHistory(filters),
    getPurchaseSummary: async (payload) => getPurchaseSummary(payload),
    getPurchaseTrend: async (payload) => getPurchaseTrend(payload),
    recordExpense: async (payload) => recordExpense(payload),
    getExpenseHistory: async (filters) => getExpenseHistory(filters),
    getExpenseSummary: async (payload) => getExpenseSummary(payload),
    getExpenseTrend: async (payload) => getExpenseTrend(payload),
    listRooms: async () => listRooms(),
    saveRoom: async (room) => saveRoom(room),
    deleteRoom: async (id) => deleteRoom(id),
    toggleRoomMaintenance: async (id, underMaintenance) => toggleRoomMaintenance({ id, underMaintenance }),
    getRoomAvailability: async (payload) => getRoomAvailability(payload),
    getRoomCalendar: async (payload) => getRoomCalendar(payload),
    pickIdDocument,
    openIdDocument,
    createBooking: async (payload) => createBooking(payload),
    addRoomToBookingGroup: async (groupId, room) => addRoomToBookingGroup({ groupId, room }),
    updateBooking: async (id, payload) => updateBooking({ id, payload }),
    checkInBooking: async (id) => checkInBooking(id),
    checkOutBooking: async (id, paymentMethod) => checkOutBooking(id, paymentMethod),
    cancelBooking: async (id, reason, refund, refundMethod) => cancelBooking({ id, reason, refund, refundMethod }),
    cancelGroupBooking: async (groupId, reason, refund, refundMethod) => cancelGroupBooking({ groupId, reason, refund, refundMethod }),
    addBookingAddon: async (bookingId, addon) => addBookingAddon({ bookingId, addon }),
    removeBookingAddon: async (addonId) => removeBookingAddon(addonId),
    listBookings: async (filters) => listBookings(filters),
    getBookingById: async (id) => getBookingById(id),
    getGroupInvoice: async (groupId) => getGroupInvoiceData(groupId),
    openGroupBillWindow: async (groupId) => { navigateTo(`#/bill-group/${groupId}`); return true; },
    hasOwnerAccount: async () => hasOwnerAccount(),
    createOwnerAccount: async (payload) => createOwnerAccount(payload),
    createStaffAccount: async (payload) => createStaffAccount(payload),
    listUsers: async () => listUsers(),
    deactivateUser: async (id) => deactivateUser(id),
    resetUserPin: async (id, newPin) => resetUserPin({ id, newPin }),
    updateUserAccess: async (id, access) => updateUserAccess(id, access),
    loginWithPin: async (pin) => loginWithPin(pin),
    changeMyPin: async (id, currentPin, newPin) => changeMyPin({ id, currentPin, newPin }),
    verifyRecoveryCodeAndResetPin: async (code, newPin) => verifyRecoveryCodeAndResetPin(code, newPin),
    exportAllData: async () => exportAllData(),
    importAllData: async (jsonText) => importAllData(jsonText),
    factoryReset: async (payload) => factoryReset(payload),
    // Online-ordering (Zomato/Swiggy/MMT) polling is an Electron-only, cloud-backed
    // feature (electron/integrations/pollingService.cjs) — there's no background
    // process on mobile to poll those platforms. We still expose the API so the
    // bell icon renders (with its existing "no incoming orders" empty state)
    // instead of being hidden outright, matching desktop's UI.
    listIncomingOrders: async () => [],
    acceptIncomingOrder: async () => { throw new Error('Online-order integrations are only available in the desktop app for now.'); },
    rejectIncomingOrder: async () => { throw new Error('Online-order integrations are only available in the desktop app for now.'); },
    onIncomingOrder: () => () => {},
    // Licensing only gates the sellable Electron desktop install (the Host
    // machine that owns the real database) — this standalone mobile/browser
    // fallback is a free companion mode, never a separately-sold copy, so it
    // always reports "licensed".
    shareViaWhatsApp: async (text, phoneNumber) => {
      if (typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform()) {
        try {
          const plugin = window.Capacitor?.Plugins?.MobileHost;
          if (plugin?.shareViaWhatsApp) {
            await plugin.shareViaWhatsApp({ text, phoneNumber: phoneNumber || '' });
            return true;
          }
        } catch (_) { /* fall through to Web Share API */ }
      }
      if (typeof navigator !== 'undefined' && navigator.share) {
        try {
          await navigator.share({ title: 'BillNest', text, url: window.location.href });
          return true;
        } catch (_) { /* user cancelled */ }
      }
      if (typeof window !== 'undefined' && window.location) {
        const encoded = encodeURIComponent(text);
        const url = phoneNumber
          ? `https://api.whatsapp.com/send?phone=${phoneNumber}&text=${encoded}`
          : `https://wa.me/?text=${encoded}`;
        window.open(url, '_blank', 'noopener,noreferrer');
        return true;
      }
      return false;
    },
    getLicenseStatus: async () => ({ valid: true }),
  };
}
