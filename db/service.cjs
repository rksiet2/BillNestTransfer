// Data access + business logic used by Electron IPC handlers.
const fs = require('fs');
const path = require('path');
const { getDb, getBillRecordsDir, getKotRecordsDir, nextToken, nextBillNumber, nextKotNumber } = require('./database.cjs');

// ---------------- Settings (hotel name, address, tax etc.) ----------------
function getSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return obj;
}

function saveSettings(partial) {
  const db = getDb();
  // Back-compat: `tax_percent` is the legacy single global rate that
  // pre-dates the Cash/Online split. Any caller that still sets ONLY this
  // key (old scripts, API callers, mobile sync before it's upgraded) should
  // keep behaving exactly as before — i.e. that one rate applies to both
  // Cash and Online — so mirror it into both new keys unless the caller is
  // also explicitly setting them itself in the same call.
  const entries = { ...partial };
  if (entries.tax_percent != null) {
    if (entries.tax_percent_cash == null) entries.tax_percent_cash = entries.tax_percent;
    if (entries.tax_percent_online == null) entries.tax_percent_online = entries.tax_percent;
  }
  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  const tx = db.transaction((rows) => {
    for (const [key, value] of rows) upsert.run(key, String(value));
  });
  tx(Object.entries(entries));
  return getSettings();
}

// Picks the right business identity (name/address/phone/GSTIN/footer/UPI)
// to print on a bill, depending on whether it's a Food Billing bill or a
// Room Booking one — these are two separate, independently-editable
// identities in Settings (a restaurant and a hotel can legally be different
// businesses, with their own GSTIN/footer/UPI), see db/database.cjs's
// seedDefaults() for where `room_biz_*` is first created.
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

// Resolves the tax/GST rate to use for a bill when the caller didn't pass
// one explicitly, based on the Cash vs Online tax slabs configured in
// Settings for the relevant business (Food or Room). Falls back to the
// legacy single `tax_percent` (pre-dating the Cash/Online split), then 5%.
function autoTaxPercent(settings, source, paymentMethod) {
  const isRoom = source === 'ROOM';
  const key = paymentMethod === 'ONLINE'
    ? (isRoom ? 'room_tax_percent_online' : 'tax_percent_online')
    : (isRoom ? 'room_tax_percent_cash' : 'tax_percent_cash');
  const raw = settings[key] ?? settings.tax_percent ?? 5;
  return parseFloat(raw);
}

// ---------------- Categories & Food ----------------
function getCategories() {
  return getDb().prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
}

function addCategory(name) {
  const info = getDb().prepare('INSERT INTO categories (name, sort_order) VALUES (?, 999)').run(name);
  return { id: info.lastInsertRowid, name };
}

function getFoodItems({ categoryId, search } = {}) {
  let query = `SELECT f.*, c.name as category_name FROM food_items f
               JOIN categories c ON c.id = f.category_id WHERE 1=1`;
  const params = [];
  if (categoryId) {
    query += ' AND f.category_id = ?';
    params.push(categoryId);
  }
  if (search) {
    query += ' AND f.name LIKE ?';
    params.push(`%${search}%`);
  }
  query += ' ORDER BY c.sort_order, f.name';
  return getDb().prepare(query).all(...params);
}

function getPopularFood(limit = 8) {
  const safeLimit = Math.max(1, Math.min(20, Number.isInteger(Number(limit)) ? Number(limit) : 8));
  return getDb().prepare(`
    SELECT f.*, c.name AS category_name, SUM(bi.quantity) AS units_sold
    FROM bill_items bi
    JOIN bills b ON b.id = bi.bill_id
    JOIN food_items f ON f.id = bi.food_id
    JOIN categories c ON c.id = f.category_id
    WHERE b.source = 'FOOD'
      AND b.status = 'COMPLETED'
      AND datetime(b.created_at) >= datetime('now', 'localtime', '-30 days')
      AND f.available = 1
    GROUP BY f.id
    ORDER BY units_sold DESC, f.name COLLATE NOCASE
    LIMIT ?
  `).all(safeLimit);
}

function saveFoodItem(item) {
  if (item.price != null && !(item.price >= 0)) {
    throw new Error('Food item price must be zero or a positive number.');
  }
  const db = getDb();
  if (item.id) {
    db.prepare(
      `UPDATE food_items SET name=?, category_id=?, price=?, image_path=?, is_veg=?, available=? WHERE id=?`
    ).run(item.name, item.category_id, item.price, item.image_path || null, item.is_veg ? 1 : 0, item.available ? 1 : 0, item.id);
    return item.id;
  } else {
    const info = db.prepare(
      `INSERT INTO food_items (name, category_id, price, image_path, is_veg, available) VALUES (?,?,?,?,?,?)`
    ).run(item.name, item.category_id, item.price, item.image_path || null, item.is_veg ? 1 : 0, item.available ? 1 : 0);
    return info.lastInsertRowid;
  }
}

function deleteFoodItem(id) {
  getDb().prepare('DELETE FROM food_items WHERE id = ?').run(id);
  return true;
}

// ---------------- Billing ----------------
function createBill({ items, paymentMethod, customerName, customerPhone, discount = 0, advancePayment = 0, taxPercent, orderNote, skipKot = false, source = 'FOOD', tableId = null, bookingNumber = null }) {
  const db = getDb();
  if (!items || items.length === 0) throw new Error('At least one item is required to generate a bill.');

  // Callers (Cart.jsx, the room booking checkout flow) normally compute and
  // pass an explicit `taxPercent` already resolved for the chosen payment
  // method. This is a safety-net fallback for any caller that doesn't
  // (e.g. programmatic/API/legacy callers): pick the Cash vs Online rate
  // configured in Settings for this bill's business (Food vs Room), falling
  // back further to the legacy single `tax_percent` for very old installs.
  const tax = taxPercent != null ? taxPercent : autoTaxPercent(getSettings(), source, paymentMethod);

  const subtotal = items.reduce((sum, it) => sum + it.price * it.quantity, 0);
  const taxAmount = +(subtotal * (tax / 100)).toFixed(2);
  // `discount` is a genuine price reduction; `advancePayment` is money the
  // guest already paid upfront (a room-booking advance) — it must NEVER
  // reduce `total`, only how much of that total is still being collected
  // right now (`balanceDue`). Folding it into discount used to silently
  // understate both the printed bill and every revenue report.
  const total = Math.max(0, +(subtotal + taxAmount - discount).toFixed(2));
  const balanceDue = +(total - advancePayment).toFixed(2);

  const token = nextToken(paymentMethod);
  const billNumber = nextBillNumber();
  const kotNumber = skipKot ? null : nextKotNumber();

  const settings = getSettings();
  const billSource = source === 'ROOM' ? 'ROOM' : 'FOOD';
  const identity = getBillIdentity(settings, billSource);

  const insertBill = db.prepare(`
    INSERT INTO bills (bill_number, token, payment_method, customer_name, customer_phone, subtotal, tax_percent, tax_amount, discount, advance_payment, balance_due, total, status, kot_number, order_note, source, table_id, biz_name, biz_address, biz_phone, biz_gstin, biz_footer, biz_upi_id, biz_logo_path, booking_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = insertBill.run(
    billNumber, token, paymentMethod, customerName || null, customerPhone || null,
    subtotal, tax, taxAmount, discount, advancePayment, balanceDue, total,
    kotNumber, orderNote || null, billSource, tableId || null,
    identity.hotelName, identity.hotelAddress, identity.hotelPhone, identity.hotelGstin, identity.billFooter, identity.upiId, identity.hotelLogo || null,
    bookingNumber || null
  );
  const billId = info.lastInsertRowid;

  const insertItem = db.prepare(`
    INSERT INTO bill_items (bill_id, food_id, name, price, quantity, total) VALUES (?,?,?,?,?,?)
  `);
  for (const it of items) {
    insertItem.run(billId, it.id || null, it.name, it.price, it.quantity, +(it.price * it.quantity).toFixed(2));
  }

  const bill = {
    id: billId,
    billNumber,
    token,
    kotNumber,
    orderNote: orderNote || '',
    paymentMethod,
    customerName,
    customerPhone: customerPhone || '',
    subtotal,
    taxPercent: tax,
    taxAmount,
    discount,
    advancePayment,
    balanceDue,
    total,
    status: 'COMPLETED',
    createdAt: new Date().toLocaleString('en-IN'),
    bookingNumber: bookingNumber || null,
    items,
    ...identity,
  };

  const filePath = writeBillFile(bill);
  const kotFilePath = skipKot ? null : writeKotFile(bill);
  db.prepare('UPDATE bills SET file_path = ?, kot_file_path = ? WHERE id = ?').run(filePath, kotFilePath, billId);
  bill.filePath = filePath;
  bill.kotFilePath = kotFilePath;

  return bill;
}

function writeBillFile(bill) {
  const dir = getBillRecordsDir();
  const safeName = `${bill.billNumber}_${bill.token}.txt`;
  const filePath = path.join(dir, safeName);

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
  if (bill.paymentMethod === 'ONLINE' && bill.upiId) lines.push(`Pay via UPI: ${bill.upiId}`);
  lines.push(line());
  lines.push(padCols(['Item', 'Qty', 'Price', 'Total'], [18, 5, 8, 9]));
  lines.push(line());
  for (const it of bill.items) {
    lines.push(padCols([it.name, String(it.quantity), it.price.toFixed(2), (it.price * it.quantity).toFixed(2)], [18, 5, 8, 9]));
  }
  lines.push(line());
  lines.push(padCols(['Subtotal', '', '', bill.subtotal.toFixed(2)], [18, 5, 8, 9]));
  if (bill.taxAmount > 0) {
    // Indian GST invoices split tax into two equal halves — CGST (Central)
    // + SGST (State) — instead of one combined "Tax" line.
    const halfPercent = (bill.taxPercent / 2).toFixed(2);
    const cgstAmount = +(bill.taxAmount / 2).toFixed(2);
    const sgstAmount = +(bill.taxAmount - cgstAmount).toFixed(2);
    lines.push(padCols([`CGST (${halfPercent}%)`, '', '', cgstAmount.toFixed(2)], [18, 5, 8, 9]));
    lines.push(padCols([`SGST (${halfPercent}%)`, '', '', sgstAmount.toFixed(2)], [18, 5, 8, 9]));
  } else {
    lines.push(padCols([`Tax (${bill.taxPercent}%)`, '', '', bill.taxAmount.toFixed(2)], [18, 5, 8, 9]));
  }
  if (bill.discount) lines.push(padCols(['Discount', '', '', ('-' + bill.discount.toFixed(2))], [18, 5, 8, 9]));
  lines.push(line());
  lines.push(padCols(['TOTAL', '', '', bill.total.toFixed(2)], [18, 5, 8, 9]));
  lines.push(line('='));
  lines.push(center(bill.billFooter || 'Thank you! Visit again.', width));

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

function center(text, width) {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(pad) + text;
}

function padCols(cols, widths) {
  return cols.map((c, i) => String(c).padEnd(widths[i])).join('');
}

// KOT = Kitchen Order Ticket: a simplified ticket sent to the kitchen with just
// item names, quantities and any special notes - no prices/payment/tax info,
// since the kitchen staff only needs to know what to prepare.
function writeKotFile(bill) {
  const dir = getKotRecordsDir();
  const safeName = `${bill.kotNumber}_${bill.token}.txt`;
  const filePath = path.join(dir, safeName);

  const width = 36;
  const line = (ch = '-') => ch.repeat(width);
  const lines = [];
  lines.push(center('KITCHEN ORDER TICKET', width));
  lines.push(center(`(KOT)`, width));
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
  if (bill.orderNote) {
    lines.push(`Note: ${bill.orderNote}`);
    lines.push(line());
  }
  lines.push(center('*** PREPARE FRESH & FAST ***', width));

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

function getBillById(id) {
  const db = getDb();
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
  if (!bill) return null;
  const items = db.prepare('SELECT * FROM bill_items WHERE bill_id = ?').all(id);
  // Bills created after the biz_* snapshot columns existed carry their own
  // frozen business identity — use that so editing the profile later never
  // rewrites what an already-printed bill shows. Older bills (biz_name is
  // NULL, predating this column / never backfilled) fall back to today's
  // live Settings, same as before.
  const identity = bill.biz_name
    ? {
      hotelName: bill.biz_name,
      hotelAddress: bill.biz_address || '',
      hotelPhone: bill.biz_phone || '',
      hotelGstin: bill.biz_gstin || '',
      billFooter: bill.biz_footer || 'Thank you! Visit again.',
      upiId: bill.biz_upi_id || '',
      hotelLogo: bill.biz_logo_path || '',
    }
    : getBillIdentity(getSettings(), bill.source);
  // ROOM bills print a full A4 stay invoice (guest details, check-in/out,
  // room/nights) instead of the thermal FOOD receipt layout — look up the
  // linked booking + room via the bill's own booking_number so those fields
  // are available on the returned bill object without the frontend needing
  // a second round-trip.
  let stay = {};
  if (bill.source === 'ROOM' && bill.booking_number) {
    const booking = db
      .prepare(
        `SELECT bk.*, r.room_number, r.room_type FROM room_bookings bk
         JOIN rooms r ON r.id = bk.room_id
         WHERE bk.booking_number = ?`
      )
      .get(bill.booking_number);
    if (booking) {
      stay = {
        guestName: booking.guest_name,
        guestPhone: booking.guest_phone || '',
        guestGstin: booking.guest_gstin || '',
        guestIdType: booking.guest_id_type || '',
        guestIdNumber: booking.guest_id_number || '',
        numGuests: booking.num_guests,
        checkInDate: booking.check_in_date,
        checkOutDate: booking.check_out_date,
        actualCheckIn: booking.actual_check_in || '',
        actualCheckOut: booking.actual_check_out || '',
        roomNumber: booking.room_number,
        roomType: booking.room_type,
      };
    }
  }
  return {
    ...bill,
    items,
    ...identity,
    ...stay,
  };
}

function cancelBill(id, reason) {
  const db = getDb();
  db.prepare("UPDATE bills SET status='CANCELLED', cancel_reason=? WHERE id=?").run(reason || 'Cancelled by user', id);
  return getBillById(id);
}

function getBills({ from, to, status, source } = {}) {
  const db = getDb();
  let query = 'SELECT * FROM bills WHERE 1=1';
  const params = [];
  if (from) {
    query += ' AND date(created_at) >= date(?)';
    params.push(from);
  }
  if (to) {
    query += ' AND date(created_at) <= date(?)';
    params.push(to);
  }
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }
  if (source === 'FOOD' || source === 'ROOM') {
    query += ' AND source = ?';
    params.push(source);
  }
  query += ' ORDER BY created_at DESC';
  return db.prepare(query).all(...params);
}

// ---------------- Reporting ----------------
// Only allow strict YYYY-MM-DD strings through into hand-built SQL date literals
// (guards the custom date-range reporting inputs against SQL injection).
function sanitizeDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

// Whitelists the reporting "source" filter to a known-safe value before it gets
// interpolated into hand-built SQL (only 'FOOD' or 'ROOM' are ever valid; anything
// else — including 'ALL'/undefined, meaning "both" — is treated as no filter).
function sanitizeSource(value) {
  return value === 'FOOD' || value === 'ROOM' ? value : null;
}

// Accepts either a period string ('today'/'week'/'month'/'year'/'all') or an object
// { period: 'custom', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', source: 'FOOD'|'ROOM' } for
// an arbitrary date range and/or restricting the report to only Food or only Room
// Booking revenue (omit source, or pass 'ALL', for the combined view).
function getSummary(periodOrOptions) {
  const db = getDb();
  const { period, from, to, source } = typeof periodOrOptions === 'string'
    ? { period: periodOrOptions }
    : (periodOrOptions || {});

  let dateFilter;
  switch (period) {
    case 'today':
      dateFilter = "date(created_at) = date('now','localtime')";
      break;
    case 'week':
      dateFilter = "date(created_at) >= date('now','localtime','-6 days')";
      break;
    case 'month':
      dateFilter = "strftime('%Y-%m', created_at) = strftime('%Y-%m','now','localtime')";
      break;
    case 'year':
      dateFilter = "strftime('%Y', created_at) = strftime('%Y','now','localtime')";
      break;
    case 'custom': {
      const safeFrom = sanitizeDate(from);
      const safeTo = sanitizeDate(to);
      dateFilter = (safeFrom && safeTo)
        ? `date(created_at) >= date('${safeFrom}') AND date(created_at) <= date('${safeTo}')`
        : '1=1';
      break;
    }
    default:
      dateFilter = '1=1';
  }

  const safeSource = sanitizeSource(source);
  if (safeSource) dateFilter += ` AND source = '${safeSource}'`;

  const totals = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status='COMPLETED') as orderCount,
      COALESCE(SUM(total) FILTER (WHERE status='COMPLETED'), 0) as revenue,
      COUNT(*) FILTER (WHERE status='CANCELLED') as cancelledCount,
      COALESCE(SUM(total) FILTER (WHERE status='COMPLETED' AND payment_method='CASH'), 0) as cashRevenue,
      COALESCE(SUM(total) FILTER (WHERE status='COMPLETED' AND payment_method='ONLINE'), 0) as onlineRevenue,
      COALESCE(SUM(advance_payment) FILTER (WHERE status='COMPLETED'), 0) as advanceCollected
    FROM bills WHERE ${dateFilter}
  `).get();

  const topItems = db.prepare(`
    SELECT bi.name, SUM(bi.quantity) as qty, SUM(bi.total) as revenue
    FROM bill_items bi
    JOIN bills b ON b.id = bi.bill_id
    WHERE b.status='COMPLETED' AND ${dateFilter.replace(/created_at/g, 'b.created_at').replace(/(?<!b\.)source/g, 'b.source')}
    GROUP BY bi.name ORDER BY qty DESC LIMIT 5
  `).all();

  const avgBill = totals.orderCount > 0 ? +(totals.revenue / totals.orderCount).toFixed(2) : 0;

  return { ...totals, avgBill, topItems };
}

// Returns sales trend buckets sized appropriately for the given reporting period:
// - today/week: daily buckets, last 14 days
// - month: daily buckets, last 30 days
// - year: monthly buckets, last 12 months
// - all: monthly buckets, since the earliest bill on record
// - custom {from, to}: daily buckets if the range is <= 62 days, else monthly buckets
function getSalesTrend(periodOrOptions = 'today') {
  const db = getDb();
  const { period, from, to, source } = typeof periodOrOptions === 'string'
    ? { period: periodOrOptions }
    : (periodOrOptions || {});

  const safeSource = sanitizeSource(source);
  const sourceFilter = safeSource ? ` AND source = '${safeSource}'` : '';

  if (period === 'custom') {
    const safeFrom = sanitizeDate(from);
    const safeTo = sanitizeDate(to);
    if (!safeFrom || !safeTo) return [];
    const spanDaysRow = db.prepare(`SELECT CAST(julianday(date(?)) - julianday(date(?)) AS INTEGER) as days`).get(safeTo, safeFrom);
    const spanDays = spanDaysRow ? spanDaysRow.days : 0;
    if (spanDays > 62) {
      return db.prepare(`
        SELECT strftime('%Y-%m', created_at) as day, COALESCE(SUM(total),0) as revenue, COUNT(*) as orders
        FROM bills
        WHERE status='COMPLETED' AND date(created_at) >= date(?) AND date(created_at) <= date(?)${sourceFilter}
        GROUP BY strftime('%Y-%m', created_at) ORDER BY day ASC
      `).all(safeFrom, safeTo);
    }
    return db.prepare(`
      SELECT date(created_at) as day, COALESCE(SUM(total),0) as revenue, COUNT(*) as orders
      FROM bills
      WHERE status='COMPLETED' AND date(created_at) >= date(?) AND date(created_at) <= date(?)${sourceFilter}
      GROUP BY date(created_at) ORDER BY day ASC
    `).all(safeFrom, safeTo);
  }

  if (period === 'year' || period === 'all') {
    const monthsBack = period === 'year' ? 11 : null;
    const whereClause = monthsBack !== null
      ? `WHERE status='COMPLETED' AND date(created_at) >= date('now','localtime','start of month','-${monthsBack} months')${sourceFilter}`
      : `WHERE status='COMPLETED'${sourceFilter}`;
    return db.prepare(`
      SELECT strftime('%Y-%m', created_at) as day, COALESCE(SUM(total),0) as revenue, COUNT(*) as orders
      FROM bills
      ${whereClause}
      GROUP BY strftime('%Y-%m', created_at) ORDER BY day ASC
    `).all();
  }
  const days = period === 'month' ? 30 : 14;
  return db.prepare(`
    SELECT date(created_at) as day, COALESCE(SUM(total),0) as revenue, COUNT(*) as orders
    FROM bills
    WHERE status='COMPLETED' AND date(created_at) >= date('now','localtime', ?)${sourceFilter}
    GROUP BY date(created_at) ORDER BY day ASC
  `).all(`-${days - 1} days`);
}

// ---------------- Inventory: Raw Materials ----------------
function getRawMaterials() {
  return getDb().prepare('SELECT * FROM raw_materials ORDER BY name').all();
}

function saveRawMaterial(item) {
  const db = getDb();
  if (item.id) {
    db.prepare(`UPDATE raw_materials SET name=?, unit=? WHERE id=?`).run(item.name, item.unit, item.id);
    return item.id;
  }
  const info = db.prepare(
    `INSERT INTO raw_materials (name, unit, current_stock, low_stock_threshold, cost_per_unit) VALUES (?,?,0,0,0)`
  ).run(item.name, item.unit);
  return info.lastInsertRowid;
}

function deleteRawMaterial(id) {
  const db = getDb();
  const { count } = db.prepare('SELECT COUNT(*) as count FROM purchase_orders WHERE raw_material_id = ?').get(id);
  if (count > 0) {
    throw new Error('This raw material has purchase history and cannot be deleted. Remove its purchase records first, or keep it for reporting accuracy.');
  }
  db.prepare('DELETE FROM raw_materials WHERE id = ?').run(id);
  return true;
}

// ---------------- Purchases (money spent on stock/supplies) ----------------
// This is intentionally simple: just a log of what was purchased and how much it
// cost, with reporting on total spend over time. No stock-level/inventory tracking.
function recordPurchase({ raw_material_id, quantity, cost_per_unit, supplier, notes }) {
  if (!(quantity > 0)) throw new Error('Purchase quantity must be a positive number greater than 0.');
  if (!(cost_per_unit > 0)) throw new Error('Purchase cost per unit must be a positive number greater than 0.');

  const db = getDb();
  const totalCost = +(quantity * cost_per_unit).toFixed(2);

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO purchase_orders (raw_material_id, quantity, cost_per_unit, total_cost, supplier, notes)
       VALUES (?,?,?,?,?,?)`
    ).run(raw_material_id, quantity, cost_per_unit, totalCost, supplier || null, notes || null);

    // Keep the item's last-known cost for convenience when recording future purchases.
    db.prepare('UPDATE raw_materials SET cost_per_unit = ? WHERE id = ?').run(cost_per_unit, raw_material_id);

    return info.lastInsertRowid;
  });
  const id = tx();
  return db.prepare(`
    SELECT po.*, rm.name as material_name, rm.unit
    FROM purchase_orders po JOIN raw_materials rm ON rm.id = po.raw_material_id
    WHERE po.id = ?
  `).get(id);
}

function getPurchaseHistory({ from, to } = {}) {
  const db = getDb();
  let query = `
    SELECT po.*, rm.name as material_name, rm.unit
    FROM purchase_orders po JOIN raw_materials rm ON rm.id = po.raw_material_id
    WHERE 1=1
  `;
  const params = [];
  if (from) {
    query += ' AND date(po.created_at) >= date(?)';
    params.push(from);
  }
  if (to) {
    query += ' AND date(po.created_at) <= date(?)';
    params.push(to);
  }
  query += ' ORDER BY po.created_at DESC';
  return db.prepare(query).all(...params);
}

// Total spend, purchase count, avg purchase and top items by spend for a period —
// the purchase-side mirror of getSummary() for sales.
function getPurchaseSummary(periodOrOptions) {
  const db = getDb();
  const { period, from, to } = typeof periodOrOptions === 'string'
    ? { period: periodOrOptions }
    : (periodOrOptions || {});

  let dateFilter;
  switch (period) {
    case 'today':
      dateFilter = "date(po.created_at) = date('now','localtime')";
      break;
    case 'week':
      dateFilter = "date(po.created_at) >= date('now','localtime','-6 days')";
      break;
    case 'month':
      dateFilter = "strftime('%Y-%m', po.created_at) = strftime('%Y-%m','now','localtime')";
      break;
    case 'year':
      dateFilter = "strftime('%Y', po.created_at) = strftime('%Y','now','localtime')";
      break;
    case 'custom': {
      const safeFrom = sanitizeDate(from);
      const safeTo = sanitizeDate(to);
      dateFilter = (safeFrom && safeTo)
        ? `date(po.created_at) >= date('${safeFrom}') AND date(po.created_at) <= date('${safeTo}')`
        : '1=1';
      break;
    }
    default:
      dateFilter = '1=1';
  }

  const totals = db.prepare(`
    SELECT COUNT(*) as purchaseCount, COALESCE(SUM(total_cost), 0) as totalSpend
    FROM purchase_orders po WHERE ${dateFilter}
  `).get();

  const topItems = db.prepare(`
    SELECT rm.name, SUM(po.quantity) as qty, SUM(po.total_cost) as spend
    FROM purchase_orders po JOIN raw_materials rm ON rm.id = po.raw_material_id
    WHERE ${dateFilter}
    GROUP BY rm.name ORDER BY spend DESC LIMIT 5
  `).all();

  const avgPurchase = totals.purchaseCount > 0 ? +(totals.totalSpend / totals.purchaseCount).toFixed(2) : 0;

  return { ...totals, avgPurchase, topItems };
}

// Purchase-spend trend buckets, mirroring getSalesTrend()'s daily/monthly bucketing rules.
function getPurchaseTrend(periodOrOptions = 'today') {
  const db = getDb();
  const { period, from, to } = typeof periodOrOptions === 'string'
    ? { period: periodOrOptions }
    : (periodOrOptions || {});

  if (period === 'custom') {
    const safeFrom = sanitizeDate(from);
    const safeTo = sanitizeDate(to);
    if (!safeFrom || !safeTo) return [];
    const spanDaysRow = db.prepare(`SELECT CAST(julianday(date(?)) - julianday(date(?)) AS INTEGER) as days`).get(safeTo, safeFrom);
    const spanDays = spanDaysRow ? spanDaysRow.days : 0;
    if (spanDays > 62) {
      return db.prepare(`
        SELECT strftime('%Y-%m', created_at) as day, COALESCE(SUM(total_cost),0) as revenue, COUNT(*) as orders
        FROM purchase_orders
        WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)
        GROUP BY strftime('%Y-%m', created_at) ORDER BY day ASC
      `).all(safeFrom, safeTo);
    }
    return db.prepare(`
      SELECT date(created_at) as day, COALESCE(SUM(total_cost),0) as revenue, COUNT(*) as orders
      FROM purchase_orders
      WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)
      GROUP BY date(created_at) ORDER BY day ASC
    `).all(safeFrom, safeTo);
  }

  if (period === 'year' || period === 'all') {
    const monthsBack = period === 'year' ? 11 : null;
    const whereClause = monthsBack !== null
      ? `WHERE date(created_at) >= date('now','localtime','start of month','-${monthsBack} months')`
      : '';
    return db.prepare(`
      SELECT strftime('%Y-%m', created_at) as day, COALESCE(SUM(total_cost),0) as revenue, COUNT(*) as orders
      FROM purchase_orders
      ${whereClause}
      GROUP BY strftime('%Y-%m', created_at) ORDER BY day ASC
    `).all();
  }

  const days = period === 'month' ? 30 : 14;
  return db.prepare(`
    SELECT date(created_at) as day, COALESCE(SUM(total_cost),0) as revenue, COUNT(*) as orders
    FROM purchase_orders
    WHERE date(created_at) >= date('now','localtime', ?)
    GROUP BY date(created_at) ORDER BY day ASC
  `).all(`-${days - 1} days`);
}

// ---------------- Expenses (salary, rent, utilities, etc. — not stock purchases) ----------------
function recordExpense({ category, paid_to, amount, payment_method, notes }) {
  if (!(amount > 0)) throw new Error('Expense amount must be a positive number greater than 0.');
  const db = getDb();
  const info = db.prepare(
    `INSERT INTO expenses (category, paid_to, amount, payment_method, notes) VALUES (?,?,?,?,?)`
  ).run(category || 'OTHER', paid_to || null, amount, payment_method || 'CASH', notes || null);
  return db.prepare('SELECT * FROM expenses WHERE id = ?').get(info.lastInsertRowid);
}

function getExpenseHistory({ from, to } = {}) {
  const db = getDb();
  let query = 'SELECT * FROM expenses WHERE 1=1';
  const params = [];
  if (from) {
    query += ' AND date(created_at) >= date(?)';
    params.push(from);
  }
  if (to) {
    query += ' AND date(created_at) <= date(?)';
    params.push(to);
  }
  query += ' ORDER BY created_at DESC';
  return db.prepare(query).all(...params);
}

// Total spend, count, avg and category breakdown for a period — the expense-side
// mirror of getPurchaseSummary()/getSummary().
function getExpenseSummary(periodOrOptions) {
  const db = getDb();
  const { period, from, to } = typeof periodOrOptions === 'string'
    ? { period: periodOrOptions }
    : (periodOrOptions || {});

  let dateFilter;
  switch (period) {
    case 'today':
      dateFilter = "date(created_at) = date('now','localtime')";
      break;
    case 'week':
      dateFilter = "date(created_at) >= date('now','localtime','-6 days')";
      break;
    case 'month':
      dateFilter = "strftime('%Y-%m', created_at) = strftime('%Y-%m','now','localtime')";
      break;
    case 'year':
      dateFilter = "strftime('%Y', created_at) = strftime('%Y','now','localtime')";
      break;
    case 'custom': {
      const safeFrom = sanitizeDate(from);
      const safeTo = sanitizeDate(to);
      dateFilter = (safeFrom && safeTo)
        ? `date(created_at) >= date('${safeFrom}') AND date(created_at) <= date('${safeTo}')`
        : '1=1';
      break;
    }
    default:
      dateFilter = '1=1';
  }

  const totals = db.prepare(`
    SELECT COUNT(*) as expenseCount, COALESCE(SUM(amount), 0) as totalSpend
    FROM expenses WHERE ${dateFilter}
  `).get();

  const byCategory = db.prepare(`
    SELECT category, SUM(amount) as spend, COUNT(*) as count
    FROM expenses WHERE ${dateFilter}
    GROUP BY category ORDER BY spend DESC
  `).all();

  const avgExpense = totals.expenseCount > 0 ? +(totals.totalSpend / totals.expenseCount).toFixed(2) : 0;

  return { ...totals, avgExpense, byCategory };
}

// Expense-spend trend buckets, mirroring getPurchaseTrend()'s daily/monthly bucketing rules.
function getExpenseTrend(periodOrOptions = 'today') {
  const db = getDb();
  const { period, from, to } = typeof periodOrOptions === 'string'
    ? { period: periodOrOptions }
    : (periodOrOptions || {});

  if (period === 'custom') {
    const safeFrom = sanitizeDate(from);
    const safeTo = sanitizeDate(to);
    if (!safeFrom || !safeTo) return [];
    const spanDaysRow = db.prepare(`SELECT CAST(julianday(date(?)) - julianday(date(?)) AS INTEGER) as days`).get(safeTo, safeFrom);
    const spanDays = spanDaysRow ? spanDaysRow.days : 0;
    if (spanDays > 62) {
      return db.prepare(`
        SELECT strftime('%Y-%m', created_at) as day, COALESCE(SUM(amount),0) as revenue, COUNT(*) as orders
        FROM expenses
        WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)
        GROUP BY strftime('%Y-%m', created_at) ORDER BY day ASC
      `).all(safeFrom, safeTo);
    }
    return db.prepare(`
      SELECT date(created_at) as day, COALESCE(SUM(amount),0) as revenue, COUNT(*) as orders
      FROM expenses
      WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)
      GROUP BY date(created_at) ORDER BY day ASC
    `).all(safeFrom, safeTo);
  }

  if (period === 'year' || period === 'all') {
    const monthsBack = period === 'year' ? 11 : null;
    const whereClause = monthsBack !== null
      ? `WHERE date(created_at) >= date('now','localtime','start of month','-${monthsBack} months')`
      : '';
    return db.prepare(`
      SELECT strftime('%Y-%m', created_at) as day, COALESCE(SUM(amount),0) as revenue, COUNT(*) as orders
      FROM expenses
      ${whereClause}
      GROUP BY strftime('%Y-%m', created_at) ORDER BY day ASC
    `).all();
  }

  const days = period === 'month' ? 30 : 14;
  return db.prepare(`
    SELECT date(created_at) as day, COALESCE(SUM(amount),0) as revenue, COUNT(*) as orders
    FROM expenses
    WHERE date(created_at) >= date('now','localtime', ?)
    GROUP BY date(created_at) ORDER BY day ASC
  `).all(`-${days - 1} days`);
}

// ---------------- Profit & Loss (combines Sales revenue vs Purchases + Expenses) ----------------
// Always computed across BOTH Food and Room revenue (ignores the Food/Room source
// toggle in Reporting) since purchases/expenses aren't tracked per-source.
function getProfitAndLoss(periodOrOptions) {
  const period = typeof periodOrOptions === 'string' ? periodOrOptions : (periodOrOptions?.period || 'today');
  const from = typeof periodOrOptions === 'object' ? periodOrOptions.from : undefined;
  const to = typeof periodOrOptions === 'object' ? periodOrOptions.to : undefined;
  const payload = period === 'custom' ? { period, from, to } : period;

  const sales = getSummary(payload);
  const purchases = getPurchaseSummary(payload);
  const expenses = getExpenseSummary(payload);

  const revenue = sales.revenue || 0;
  const totalPurchases = purchases.totalSpend || 0;
  const totalExpenses = expenses.totalSpend || 0;
  const netProfit = +(revenue - totalPurchases - totalExpenses).toFixed(2);

  return {
    revenue,
    totalPurchases,
    totalExpenses,
    netProfit,
    expensesByCategory: expenses.byCategory,
  };
}

// ---------------- Restaurant Tables (Table/Area Management — opt-in) ----------------
function getTables() {
  return getDb().prepare('SELECT * FROM restaurant_tables ORDER BY sort_order, name').all();
}

function saveTable(table) {
  const db = getDb();
  if (table.id) {
    db.prepare(
      'UPDATE restaurant_tables SET name = ?, area = ?, capacity = ?, sort_order = ? WHERE id = ?'
    ).run(table.name, table.area || null, table.capacity || 4, table.sort_order || 0, table.id);
    return db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(table.id);
  }
  const info = db.prepare(
    'INSERT INTO restaurant_tables (name, area, capacity, sort_order) VALUES (?, ?, ?, ?)'
  ).run(table.name, table.area || null, table.capacity || 4, table.sort_order || 0);
  return db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(info.lastInsertRowid);
}

// Attaches (or clears, with `waiterName = null`) the name of whichever
// staff/captain is currently serving a table — shown on its card in the
// Tables view. Doesn't touch status/order state at all.
function assignTableWaiter(id, waiterName) {
  const db = getDb();
  db.prepare('UPDATE restaurant_tables SET waiter_name = ? WHERE id = ?').run(waiterName || null, id);
  return db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(id);
}


// Blocked if the table currently has an active order, so deleting a table
// never silently orphans an in-progress bill.
function deleteTable(id) {
  const db = getDb();
  const table = db.prepare('SELECT status FROM restaurant_tables WHERE id = ?').get(id);
  if (table && table.status === 'OCCUPIED') {
    throw new Error('Cannot delete a table that currently has an active order. Bill or clear it first.');
  }
  db.prepare('DELETE FROM restaurant_tables WHERE id = ?').run(id);
  return true;
}

function updateTableStatus(id, status) {
  const db = getDb();
  db.prepare('UPDATE restaurant_tables SET status = ? WHERE id = ?').run(status, id);
  return db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(id);
}

// The table's LIVE, not-yet-billed order — the shared source of truth so
// any device (a second counter, or a Captain's phone over Multi-Terminal
// Sync) opening this table sees exactly what's already been added, instead
// of starting a second, separate order. Returns null if nothing is saved
// for this table (a fresh/empty table, or one that was just billed/cleared).
function getTableOrder(tableId) {
  const row = getDb().prepare('SELECT * FROM table_orders WHERE table_id = ?').get(tableId);
  if (!row) return null;
  let items = [];
  try { items = JSON.parse(row.items_json || '[]'); } catch { items = []; }
  return {
    items,
    customerName: row.customer_name || '',
    customerPhone: row.customer_phone || '',
    updatedAt: row.updated_at,
  };
}

// Upserts the table's live order. Called on every cart change (debounced on
// the client) and whenever a device switches away from the table, so the
// next device to open it — seconds or hours later — always sees the latest
// items, not a stale/blank cart.
function saveTableOrder(tableId, { items, customerName, customerPhone } = {}) {
  const db = getDb();
  const itemsJson = JSON.stringify(items || []);
  db.prepare(`
    INSERT INTO table_orders (table_id, items_json, customer_name, customer_phone, updated_at)
    VALUES (?, ?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(table_id) DO UPDATE SET
      items_json = excluded.items_json,
      customer_name = excluded.customer_name,
      customer_phone = excluded.customer_phone,
      updated_at = excluded.updated_at
  `).run(tableId, itemsJson, customerName || null, customerPhone || null);
  return getTableOrder(tableId);
}

// Wipes a table's live order — called once it's billed, cancelled, or
// explicitly abandoned, so no leftover/stale order can ever resurface next
// time the table is reopened.
function clearTableOrder(tableId) {
  getDb().prepare('DELETE FROM table_orders WHERE table_id = ?').run(tableId);
  return true;
}

// ---------------- WhatsApp helpers (see electron/whatsapp.cjs) ----------------
function markBillWhatsAppSent(id) {
  getDb().prepare("UPDATE bills SET whatsapp_sent_at = datetime('now','localtime') WHERE id = ?").run(id);
}

// Every distinct, non-empty phone number BillNest has ever collected from a
// food bill, room booking guest, or additional booking contact — used to
// broadcast festival greetings. A plain phone-number list, no names attached,
// since a greeting doesn't need to be personalized by name.
function getAllCustomerPhones() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT phone FROM (
      SELECT customer_phone AS phone FROM bills WHERE customer_phone IS NOT NULL AND customer_phone != ''
      UNION
      SELECT guest_phone AS phone FROM room_bookings WHERE guest_phone IS NOT NULL AND guest_phone != ''
      UNION
      SELECT phone AS phone FROM booking_contacts WHERE phone IS NOT NULL AND phone != ''
    )
  `).all();
  return rows.map((r) => r.phone);
}

module.exports = {
  getSettings,
  saveSettings,
  getCategories,
  addCategory,
  getFoodItems,
  getPopularFood,
  saveFoodItem,
  deleteFoodItem,
  createBill,
  getBillById,
  cancelBill,
  getBills,
  getSummary,
  getSalesTrend,
  // Purchases (spend tracking only — no stock/inventory management)
  getRawMaterials,
  saveRawMaterial,
  deleteRawMaterial,
  recordPurchase,
  getPurchaseHistory,
  getPurchaseSummary,
  getPurchaseTrend,
  // Expenses (salary, rent, utilities, etc.)
  recordExpense,
  getExpenseHistory,
  getExpenseSummary,
  getExpenseTrend,
  // Profit & Loss
  getProfitAndLoss,
  // Restaurant Tables (Table/Area Management — opt-in feature)
  getTables,
  saveTable,
  deleteTable,
  updateTableStatus,
  assignTableWaiter,
  getTableOrder,
  saveTableOrder,
  clearTableOrder,
  // WhatsApp (see electron/whatsapp.cjs)
  markBillWhatsAppSent,
  getAllCustomerPhones,
};
