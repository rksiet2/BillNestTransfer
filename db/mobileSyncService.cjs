// One-way desktop -> mobile data export.
//
// Reads the live SQLite database and reshapes it into the exact JSON
// structure the mobile/web build's src/mobile/webApi.js (localStorage-backed)
// expects, so a phone (or a browser tab) can import it via its existing
// "Import Backup" button and resume with the desktop's real menu, rooms,
// bills, bookings, staff — and critically the SAME Owner/Staff PIN logins,
// since both platforms hash PINs identically: sha256hex(`${salt}:${pin}`).
// No PIN reset is needed after importing.
//
// This is intentionally ONE-WAY (desktop -> mobile). Pushing changes made on
// mobile back into the desktop SQLite database is a separate, more involved
// feature (needs real SQL writes + conflict handling) and is out of scope
// here — mobile stays a read/append snapshot copy, not a live two-way sync.
const { getDb } = require('./database.cjs');

// SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" (local time, no
// timezone marker). Converting the space to "T" makes JS's Date parser treat
// it as local time (matching how it was written), then we re-serialize as
// ISO so mobile's `new Date(created_at)` period filters (today/week/month/
// year) work exactly like they do for bills created directly on mobile.
function toIso(sqliteLocalStr) {
  if (!sqliteLocalStr) return new Date().toISOString();
  const s = sqliteLocalStr.includes('T') ? sqliteLocalStr : sqliteLocalStr.replace(' ', 'T');
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// Recovery-email/App-password/OTP secrets and local backup-folder bookkeeping
// are desktop-only concerns — never leak them into a file meant to be
// carried around on a phone or shared via Drive/WhatsApp/etc.
const SETTINGS_EXCLUDE_PREFIX = /^(recovery_|backup_)/;

function exportForMobile() {
  const db = getDb();

  // ---- settings ----
  const settings = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    if (SETTINGS_EXCLUDE_PREFIX.test(row.key)) continue;
    settings[row.key] = row.value;
  }

  // ---- categories & food ----
  const categories = db.prepare('SELECT id, name, sort_order FROM categories ORDER BY sort_order, name').all();
  const catNameById = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const foodItems = db.prepare('SELECT * FROM food_items').all().map((f) => ({
    id: f.id,
    name: f.name,
    category_id: f.category_id,
    category_name: catNameById[f.category_id] || '',
    price: f.price,
    image_path: f.image_path,
    is_veg: f.is_veg,
    available: f.available,
  }));

  // ---- bills (flatten bill_items into each bill's inline `items`, matching
  // how mobile's createBill stores line-items) ----
  const billItemsByBill = {};
  for (const it of db.prepare('SELECT * FROM bill_items ORDER BY id').all()) {
    (billItemsByBill[it.bill_id] = billItemsByBill[it.bill_id] || []).push({
      id: it.id,
      name: it.name,
      price: it.price,
      quantity: it.quantity,
      total: it.total,
    });
  }
  const bills = db.prepare('SELECT * FROM bills ORDER BY id').all().map((b) => ({
    id: b.id,
    bill_number: b.bill_number,
    billNumber: b.bill_number,
    kot_number: b.kot_number,
    kotNumber: b.kot_number,
    token: b.token,
    payment_method: b.payment_method,
    customer_name: b.customer_name,
    subtotal: b.subtotal,
    tax_percent: b.tax_percent,
    tax_amount: b.tax_amount,
    discount: b.discount,
    total: b.total,
    status: b.status,
    cancel_reason: b.cancel_reason,
    source: b.source,
    order_note: b.order_note,
    created_at: toIso(b.created_at),
    items: billItemsByBill[b.id] || [],
    ...(b.source === 'ROOM' ? {
      hotelName: settings.room_biz_name || 'Hotel',
      hotelAddress: settings.room_biz_address || '',
      hotelPhone: settings.room_biz_phone || '',
      hotelGstin: settings.room_biz_gstin || '',
      billFooter: settings.room_bill_footer || 'Thank you! Visit again.',
      upiId: settings.room_upi_id || '',
    } : {
      hotelName: settings.hotel_name || 'Hotel',
      hotelAddress: settings.hotel_address || '',
      hotelPhone: settings.hotel_phone || '',
      hotelGstin: settings.hotel_gstin || '',
      billFooter: settings.bill_footer || 'Thank you! Visit again.',
      upiId: settings.upi_id || '',
    }),
  }));

  // ---- rooms ----
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY id').all().map((r) => ({
    id: r.id,
    room_number: r.room_number,
    room_type: r.room_type,
    base_price: r.base_price,
    max_occupancy: r.max_occupancy,
    status: r.status,
    notes: r.notes,
  }));

  // ---- bookings + addons + contacts ----
  const bookings = db.prepare('SELECT * FROM room_bookings ORDER BY id').all().map((b) => ({
    id: b.id,
    bookingNumber: b.booking_number,
    bookingGroupId: b.booking_group_id || `BG${b.id}`,
    roomId: b.room_id,
    guestName: b.guest_name,
    guestPhone: b.guest_phone,
    guestIdType: b.guest_id_type,
    guestIdNumber: b.guest_id_number,
    guestGstin: b.guest_gstin,
    numGuests: b.num_guests,
    checkInDate: b.check_in_date,
    checkOutDate: b.check_out_date,
    actualCheckIn: b.actual_check_in,
    actualCheckOut: b.actual_check_out,
    roomRate: b.room_rate,
    touristTax: b.tourist_tax,
    discount: b.discount,
    taxPercent: b.tax_percent,
    paymentMethod: b.payment_method,
    advancePayment: b.advance_payment || 0,
    advancePaymentMethod: b.advance_payment_method,
    status: b.status,
    cancelReason: b.cancel_reason,
    notes: b.notes,
    billId: b.bill_id,
    createdAt: toIso(b.created_at),
  }));

  const bookingAddons = db.prepare('SELECT * FROM booking_addons ORDER BY id').all().map((a) => ({
    id: a.id,
    bookingId: a.booking_id,
    name: a.name,
    price: a.price,
    quantity: a.quantity,
    total: a.total,
  }));

  const bookingContacts = db.prepare('SELECT * FROM booking_contacts ORDER BY id').all().map((c) => ({
    id: c.id,
    bookingGroupId: c.booking_group_id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    specialRequest: c.special_request,
  }));

  // ---- users (PIN hash/salt copy directly — both platforms hash identically) ----
  const users = db.prepare('SELECT * FROM users ORDER BY id').all().map((u) => ({
    id: u.id,
    name: u.name,
    role: u.role,
    access: u.access,
    pinHash: u.pin_hash,
    pinSalt: u.pin_salt,
    active: !!u.active,
    createdAt: toIso(u.created_at),
  }));

  // ---- inventory / purchases / expenses ----
  const rawMaterials = db.prepare('SELECT * FROM raw_materials ORDER BY id').all().map((r) => ({
    id: r.id,
    name: r.name,
    unit: r.unit,
    current_stock: r.current_stock,
    low_stock_threshold: r.low_stock_threshold,
    cost_per_unit: r.cost_per_unit,
  }));

  const purchases = db.prepare('SELECT * FROM purchase_orders ORDER BY id').all().map((p) => ({
    id: p.id,
    raw_material_id: p.raw_material_id,
    quantity: p.quantity,
    cost_per_unit: p.cost_per_unit,
    total_cost: p.total_cost,
    supplier: p.supplier,
    notes: p.notes,
    created_at: toIso(p.created_at),
  }));

  const expenses = db.prepare('SELECT * FROM expenses ORDER BY id').all().map((e) => ({
    id: e.id,
    category: e.category,
    paid_to: e.paid_to,
    amount: e.amount,
    payment_method: e.payment_method,
    notes: e.notes,
    created_at: toIso(e.created_at),
  }));

  // ---- counters ----
  // Desktop resets bill/KOT/booking/token sequences daily (see nextBillNumber
  // etc. in database.cjs) while mobile's counters are simple running totals
  // (see webApi.js's createBill/createBooking). There's no exact equivalent
  // to carry over, so seed mobile's counters just high enough that its next
  // auto-generated number/token can't collide with an imported one.
  const counters = {
    bill: bills.length,
    kot: bills.filter((b) => b.kot_number).length,
    booking: bookings.length,
    tokenCash: 0,
    tokenOnline: 0,
  };

  return {
    settings: {
      hotel_name: 'Your Hotel Name',
      hotel_address: 'Your Hotel Address',
      hotel_phone: '',
      hotel_gstin: '',
      upi_id: '',
      tax_percent: '5',
      bill_footer: 'Thank you! Visit again.',
      room_biz_name: 'Your Hotel Name',
      room_biz_address: 'Your Hotel Address',
      room_biz_phone: '',
      room_biz_gstin: '',
      room_upi_id: '',
      room_bill_footer: 'Thank you! Visit again.',
      setup_completed: 'false',
      ...settings,
    },
    categories,
    foodItems,
    bills,
    billItems: [],
    rooms,
    bookings,
    bookingAddons,
    bookingContacts,
    users,
    rawMaterials,
    purchases,
    expenses,
    counters,
  };
}

module.exports = { exportForMobile };
