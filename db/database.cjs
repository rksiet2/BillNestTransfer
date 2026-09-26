// SQLite database layer for Hotel Billing Software.
// Uses better-sqlite3 (synchronous, fast, zero external server needed).
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Real bundled food photos (public/food-images/*.jpg) for the default sample menu.
const DEFAULT_FOOD_IMAGES = {
  'Paneer Tikka': 'food-images/paneer-tikka.jpg',
  'Chicken 65': 'food-images/chicken-65.jpg',
  'Veg Spring Roll': 'food-images/veg-spring-roll.jpg',
  'Butter Chicken': 'food-images/butter-chicken.jpg',
  'Paneer Butter Masala': 'food-images/paneer-butter-masala.jpg',
  'Dal Makhani': 'food-images/dal-makhani.jpg',
  'Tandoori Roti': 'food-images/tandoori-roti.jpg',
  'Butter Naan': 'food-images/butter-naan.jpg',
  'Veg Biryani': 'food-images/veg-biryani.jpg',
  'Chicken Biryani': 'food-images/chicken-biryani.jpg',
  'Gulab Jamun': 'food-images/gulab-jamun.jpg',
  'Ice Cream': 'food-images/ice-cream.jpg',
  'Masala Chai': 'food-images/masala-chai.jpg',
  'Cold Coffee': 'food-images/cold-coffee.jpg',
};

let db;
let dbFilePath;
let billRecordsDir;
let kotRecordsDir;

function initDatabase(userDataPath) {
  const dataDir = path.join(userDataPath, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  billRecordsDir = path.join(userDataPath, 'Bill Records');
  if (!fs.existsSync(billRecordsDir)) fs.mkdirSync(billRecordsDir, { recursive: true });

  kotRecordsDir = path.join(userDataPath, 'KOT Records');
  if (!fs.existsSync(kotRecordsDir)) fs.mkdirSync(kotRecordsDir, { recursive: true });

  dbFilePath = path.join(dataDir, 'hotel_billing.db');
  db = new Database(dbFilePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS food_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category_id INTEGER NOT NULL,
      price REAL NOT NULL,
      image_path TEXT,
      is_veg INTEGER DEFAULT 1,
      available INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_number TEXT NOT NULL UNIQUE,
      token TEXT NOT NULL,
      payment_method TEXT NOT NULL, -- CASH | ONLINE
      customer_name TEXT,
      subtotal REAL NOT NULL,
      tax_percent REAL NOT NULL DEFAULT 5,
      tax_amount REAL NOT NULL,
      discount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'COMPLETED', -- COMPLETED | CANCELLED
      cancel_reason TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      file_path TEXT,
      kot_file_path TEXT,
      kot_number TEXT,
      order_note TEXT,
      source TEXT NOT NULL DEFAULT 'FOOD' -- FOOD | ROOM
    );

    CREATE TABLE IF NOT EXISTS bill_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER NOT NULL,
      food_id INTEGER,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      total REAL NOT NULL,
      FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS counters (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS raw_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      unit TEXT NOT NULL DEFAULT 'kg', -- kg | g | ltr | ml | pcs
      current_stock REAL NOT NULL DEFAULT 0,
      low_stock_threshold REAL NOT NULL DEFAULT 0,
      cost_per_unit REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- Recipe / Bill of Materials: how much of each raw material one serving of a food item consumes.
    CREATE TABLE IF NOT EXISTS recipe_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      food_id INTEGER NOT NULL,
      raw_material_id INTEGER NOT NULL,
      quantity_per_unit REAL NOT NULL,
      FOREIGN KEY (food_id) REFERENCES food_items(id) ON DELETE CASCADE,
      FOREIGN KEY (raw_material_id) REFERENCES raw_materials(id) ON DELETE CASCADE,
      UNIQUE(food_id, raw_material_id)
    );

    -- Raw material purchase entries (stock-in / purchase orders).
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_material_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      cost_per_unit REAL NOT NULL,
      total_cost REAL NOT NULL,
      supplier TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (raw_material_id) REFERENCES raw_materials(id)
    );

    -- Full stock ledger: every deduction (sale), addition (purchase/adjustment), or
    -- restock (order cancellation) is logged here for day-end reports and audit.
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_material_id INTEGER NOT NULL,
      change_qty REAL NOT NULL, -- negative = consumed, positive = added
      type TEXT NOT NULL, -- SALE_DEDUCTION | PURCHASE | ADJUSTMENT | CANCEL_RESTOCK
      reference_id INTEGER, -- bill id or purchase order id, depending on type
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (raw_material_id) REFERENCES raw_materials(id)
    );

    -- General business expenses (salary, rent, utilities, maintenance, etc.) — separate
    -- from raw-material Purchases above, mirroring how accounting apps (e.g. Vyapar)
    -- keep salary/expense entries distinct from supplier/stock purchases.
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'OTHER', -- SALARY | RENT | UTILITIES | MAINTENANCE | OTHER
      paid_to TEXT,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'CASH', -- CASH | ONLINE
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- ---------------- Room Booking / PMS ----------------
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_number TEXT NOT NULL UNIQUE,
      room_type TEXT NOT NULL DEFAULT 'Standard',
      base_price REAL NOT NULL DEFAULT 0,
      max_occupancy INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | MAINTENANCE
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS room_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_number TEXT NOT NULL UNIQUE,
      room_id INTEGER NOT NULL,
      guest_name TEXT NOT NULL,
      guest_phone TEXT,
      guest_country TEXT,
      guest_id_type TEXT,
      guest_id_number TEXT,
      guest_gstin TEXT,
      guest_id_document_path TEXT,
      guest_id_document_paths TEXT,
      num_guests INTEGER NOT NULL DEFAULT 1,
      check_in_date TEXT NOT NULL,
      check_out_date TEXT NOT NULL,
      actual_check_in TEXT,
      actual_check_out TEXT,
      room_rate REAL NOT NULL,
      tourist_tax REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      tax_percent REAL NOT NULL DEFAULT 0,
      payment_method TEXT,
      status TEXT NOT NULL DEFAULT 'BOOKED', -- BOOKED | CHECKED_IN | CHECKED_OUT | CANCELLED
      cancel_reason TEXT,
      bill_id INTEGER,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (bill_id) REFERENCES bills(id)
    );

    CREATE TABLE IF NOT EXISTS booking_addons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      total REAL NOT NULL,
      FOREIGN KEY (booking_id) REFERENCES room_bookings(id) ON DELETE CASCADE
    );

    -- One row per additional guest contact on a booking (name/phone/email/
    -- special request). Linked by booking_group_id, which is shared across
    -- every room booked together in the same "New Booking" submission (even
    -- a single-room booking gets a group id, so lookup is always uniform).
    -- The first contact is also mirrored onto room_bookings.guest_name/
    -- guest_phone for backward compatibility with the existing single-room
    -- guest fields used across checkout, reporting and receipts.
    CREATE TABLE IF NOT EXISTS booking_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      special_request TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- Local-only PIN login for Owner vs Staff access control. Fully offline:
    -- pin_hash is a salted SHA-256 hash (see userService.cjs), never plain text.
    -- The Owner account's PIN is set during first-time Setup Wizard, not seeded
    -- with a default, so there's never a predictable/known Owner PIN.
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'STAFF', -- OWNER | STAFF
      access TEXT NOT NULL DEFAULT 'BOTH', -- BOTH | FOOD | ROOMS (Owner is always treated as BOTH regardless of this value)
      pin_hash TEXT NOT NULL,
      pin_salt TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- Dine-in tables/areas (Table Management feature — opt-in via Settings).
    -- Orders can optionally be tied to a table_id (see migrateBillsTableColumns
    -- below); counter/takeaway orders simply leave it NULL, so both service
    -- styles work side by side on the same install.
    CREATE TABLE IF NOT EXISTS restaurant_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      area TEXT,
      capacity INTEGER DEFAULT 4,
      status TEXT NOT NULL DEFAULT 'EMPTY', -- EMPTY | OCCUPIED | BILLED
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- The table's LIVE, not-yet-billed order (items/customer info), kept in
    -- the shared database — NOT just in one device's browser memory — so
    -- that when Device A adds ₹800 of items to Table 1 and walks away,
    -- Device B (another counter, or a Captain's phone on Multi-Terminal
    -- Sync) opening that same table later sees the exact same ₹800 order
    -- and can add to it (making ₹900), instead of starting a second, blank
    -- ₹100 order. One row per table; overwritten on every autosave and
    -- deleted once the table is billed/cleared/cancelled.
    CREATE TABLE IF NOT EXISTS table_orders (
      table_id INTEGER PRIMARY KEY REFERENCES restaurant_tables(id) ON DELETE CASCADE,
      items_json TEXT NOT NULL DEFAULT '[]',
      customer_name TEXT,
      customer_phone TEXT,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- Recurring yearly occasions (Diwali, New Year, the hotel's own
    -- anniversary, etc.) for the WhatsApp festival-greetings feature (see
    -- electron/whatsapp.cjs). month_day is a fixed 'MM-DD' string checked
    -- against today's date once a day; last_sent_year prevents re-sending
    -- the same festival's greeting more than once per year even across app
    -- restarts on the same day.
    CREATE TABLE IF NOT EXISTS festival_greetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      month_day TEXT NOT NULL, -- 'MM-DD'
      message_template TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_sent_year INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- One row per WhatsApp message attempt (bill/booking confirmation or
    -- festival greeting) — purely a send-history log for troubleshooting in
    -- Settings, not used for any business logic.
    CREATE TABLE IF NOT EXISTS whatsapp_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      type TEXT NOT NULL, -- BILL | BOOKING | CHECKOUT | GREETING | TEST
      status TEXT NOT NULL, -- SENT | DELIVERED | READ | FAILED
      message_id TEXT,
      recipient_id TEXT,
      status_updated_at TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  migrateBillsTableColumns();
  migrateRoomBookingsTableColumns();
  migrateUsersTableColumns();
  migrateRestaurantTablesColumns();
  migrateWhatsAppLogColumns();
  seedDefaults();
  seedFestivalDefaults();
  repairLegacyAdvanceBills();
  backfillBillProfileSnapshots();
  backfillBillBookingNumbers();
  return db;
}

// Fills in bundled placeholder images for the default sample menu items on
// databases created before images were introduced (image_path was NULL).
function backfillDefaultFoodImages() {
  const update = db.prepare('UPDATE food_items SET image_path = ? WHERE name = ? AND (image_path IS NULL OR image_path = \'\')');
  for (const [name, image] of Object.entries(DEFAULT_FOOD_IMAGES)) {
    update.run(image, name);
  }
}

// Upgrades default sample items still pointing at the old generated SVG icons
// to the new real bundled food photos. Only touches rows that are still
// exactly the old default path, so any custom image a user picked is untouched.
function upgradeDefaultFoodImagesToPhotos() {
  const update = db.prepare('UPDATE food_items SET image_path = ? WHERE name = ? AND image_path = ?');
  for (const [name, newImage] of Object.entries(DEFAULT_FOOD_IMAGES)) {
    const slug = newImage.replace('food-images/', '').replace('.jpg', '');
    const oldImage = `food-images/${slug}.svg`;
    update.run(newImage, name, oldImage);
  }
}

// Seeds a sample raw-material inventory and links it to the default menu via
// recipe (BOM) entries, so item-wise auto stock deduction works out of the box.
function seedInventoryDefaults() {
  const count = db.prepare('SELECT COUNT(*) c FROM raw_materials').get().c;
  if (count > 0) return;

  const insertMaterial = db.prepare(
    'INSERT INTO raw_materials (name, unit, current_stock, low_stock_threshold, cost_per_unit) VALUES (?,?,?,?,?)'
  );
  const materials = [
    ['Paneer', 'kg', 15, 3, 320],
    ['Chicken', 'kg', 20, 4, 220],
    ['Rice', 'kg', 30, 5, 70],
    ['Wheat Flour', 'kg', 25, 5, 40],
    ['Butter', 'kg', 10, 2, 450],
    ['Onion', 'kg', 20, 4, 30],
    ['Tomato', 'kg', 15, 3, 35],
    ['Milk', 'ltr', 20, 4, 55],
    ['Sugar', 'kg', 15, 3, 45],
    ['Tea Powder', 'kg', 3, 0.5, 400],
    ['Coffee Powder', 'kg', 3, 0.5, 550],
    ['Cooking Oil', 'ltr', 15, 3, 150],
    ['Spring Roll Sheet', 'pcs', 200, 40, 3],
    ['Lentils (Dal)', 'kg', 15, 3, 110],
    ['Cream', 'ltr', 8, 2, 260],
    ['Gulab Jamun Mix', 'kg', 8, 2, 180],
    ['Ice Cream Mix', 'ltr', 8, 2, 200],
  ];
  const matIds = {};
  for (const [name, unit, stock, threshold, cost] of materials) {
    const info = insertMaterial.run(name, unit, stock, threshold, cost);
    matIds[name] = info.lastInsertRowid;
  }

  const foodRow = (name) => db.prepare('SELECT id FROM food_items WHERE name = ?').get(name);
  const insertRecipe = db.prepare(
    'INSERT OR IGNORE INTO recipe_items (food_id, raw_material_id, quantity_per_unit) VALUES (?,?,?)'
  );
  const recipes = {
    'Paneer Tikka': [['Paneer', 0.15], ['Onion', 0.02], ['Cooking Oil', 0.02]],
    'Chicken 65': [['Chicken', 0.2], ['Cooking Oil', 0.03]],
    'Veg Spring Roll': [['Spring Roll Sheet', 4], ['Onion', 0.03], ['Cooking Oil', 0.02]],
    'Butter Chicken': [['Chicken', 0.2], ['Butter', 0.03], ['Tomato', 0.05], ['Cream', 0.02]],
    'Paneer Butter Masala': [['Paneer', 0.15], ['Butter', 0.03], ['Tomato', 0.05], ['Cream', 0.02]],
    'Dal Makhani': [['Lentils (Dal)', 0.1], ['Butter', 0.02], ['Cream', 0.01]],
    'Tandoori Roti': [['Wheat Flour', 0.08]],
    'Butter Naan': [['Wheat Flour', 0.09], ['Butter', 0.01]],
    'Veg Biryani': [['Rice', 0.15], ['Onion', 0.03], ['Cooking Oil', 0.02]],
    'Chicken Biryani': [['Rice', 0.15], ['Chicken', 0.15], ['Onion', 0.03], ['Cooking Oil', 0.02]],
    'Gulab Jamun': [['Gulab Jamun Mix', 0.08], ['Sugar', 0.05]],
    'Ice Cream': [['Ice Cream Mix', 0.1]],
    'Masala Chai': [['Tea Powder', 0.005], ['Milk', 0.1], ['Sugar', 0.02]],
    'Cold Coffee': [['Coffee Powder', 0.01], ['Milk', 0.15], ['Sugar', 0.02]],
  };
  for (const [foodName, items] of Object.entries(recipes)) {
    const food = foodRow(foodName);
    if (!food) continue;
    for (const [matName, qty] of items) {
      insertRecipe.run(food.id, matIds[matName], qty);
    }
  }
}

// Seeds a small sample set of rooms so the Room Booking module isn't empty on first run.
function seedRoomDefaults() {
  const count = db.prepare('SELECT COUNT(*) c FROM rooms').get().c;
  if (count > 0) return;
  const insertRoom = db.prepare(
    'INSERT INTO rooms (room_number, room_type, base_price, max_occupancy) VALUES (?,?,?,?)'
  );
  const rooms = [
    ['101', 'Standard', 1800, 2],
    ['102', 'Standard', 1800, 2],
    ['103', 'Standard', 1800, 3],
    ['201', 'Deluxe', 2800, 3],
    ['202', 'Deluxe', 2800, 3],
    ['301', 'Suite', 4500, 4],
  ];
  for (const room of rooms) insertRoom.run(...room);
}

function migrateWhatsAppLogColumns() {
  const cols = db.prepare('PRAGMA table_info(whatsapp_log)').all().map((c) => c.name);
  const ensure = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE whatsapp_log ADD COLUMN ${ddl}`);
  };
  ensure('message_id', 'message_id TEXT');
  ensure('recipient_id', 'recipient_id TEXT');
  ensure('status_updated_at', 'status_updated_at TEXT');
}

// Adds new columns to the bills table for existing (already created) databases,
// since CREATE TABLE IF NOT EXISTS won't add columns to a table that already exists.
function migrateBillsTableColumns() {
  const cols = db.prepare('PRAGMA table_info(bills)').all().map((c) => c.name);
  const ensure = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE bills ADD COLUMN ${ddl}`);
  };
  ensure('kot_file_path', 'kot_file_path TEXT');
  ensure('kot_number', 'kot_number TEXT');
  ensure('order_note', 'order_note TEXT');
  ensure('source', "source TEXT NOT NULL DEFAULT 'FOOD'");
  // Optional link to restaurant_tables — NULL for counter/takeaway orders,
  // set when the Table Management feature is enabled and the cashier/waiter
  // assigns the order to a dine-in table.
  ensure('table_id', 'table_id INTEGER REFERENCES restaurant_tables(id)');
  // Optional customer phone number, used only to send the bill via WhatsApp
  // (see electron/whatsapp.cjs) — never required to generate a bill itself.
  ensure('customer_phone', 'customer_phone TEXT');
  // Tracks whether a WhatsApp bill message was actually sent for this bill,
  // so the UI can show "Sent"/"Failed"/nothing without re-sending on reopen.
  ensure('whatsapp_sent_at', 'whatsapp_sent_at TEXT');
  // Room-booking advance payments used to be folded straight into `discount`
  // (see roomService.checkOut), which quietly understated both the printed
  // bill total and revenue reports by the advance amount. `advance_payment`
  // now tracks that money separately (it was already received, it's not a
  // price reduction), and `balance_due` records what was actually collected
  // at THIS checkout (total - advance_payment) — a historical fact once the
  // bill is created, since checkout always requires a payment method for
  // the remainder. See repairLegacyAdvanceBills() below for existing bills.
  ensure('advance_payment', 'advance_payment REAL NOT NULL DEFAULT 0');
  ensure('balance_due', 'balance_due REAL');
  // Snapshot of the business identity (Food/Restaurant vs Hotel/Room profile
  // — see getBillIdentity in db/service.cjs) actually in effect when this
  // bill was created. Previously this was always recomputed LIVE from
  // current Settings on every read, so editing the business profile later
  // silently rewrote the printed name/address/GSTIN/footer/UPI on every old
  // bill. Bills created before this column existed fall back to the live
  // lookup (see getBillById) since there's no historical snapshot to recover.
  ensure('biz_name', 'biz_name TEXT');
  ensure('biz_address', 'biz_address TEXT');
  ensure('biz_phone', 'biz_phone TEXT');
  ensure('biz_gstin', 'biz_gstin TEXT');
  ensure('biz_footer', 'biz_footer TEXT');
  ensure('biz_upi_id', 'biz_upi_id TEXT');
  // Hotel logo path/data-URL snapshot for the A4 room invoice letterhead —
  // same historical-snapshot rationale as the biz_* fields above (a logo
  // changed later in Settings shouldn't silently rewrite an already-printed
  // invoice).
  ensure('biz_logo_path', 'biz_logo_path TEXT');
  // The room-booking's own booking_number (e.g. "SEED6M-BK-903120"), set
  // only for ROOM-source bills at checkout — lets the printed receipt show
  // the same reference guests/staff see on the Bookings tab, instead of
  // only the internal invoice bill_number. NULL for FOOD/counter bills,
  // where a booking number doesn't apply.
  ensure('booking_number', 'booking_number TEXT');
}

// One-time repair for bills created before `advance_payment`/`balance_due`
// existed: any ROOM-source bill whose checkout applied a room-booking
// advance had that advance folded straight into `discount` and `total` was
// reduced by it. This walks each such bill via its linked room_bookings row
// (advance_applied), splits the old discount back into the real manual
// discount + the advance, and recomputes total/balance_due so the bill
// (and every revenue report built from SUM(total)) reflects the FULL
// charge, with the advance recorded as separately-already-received money.
// Idempotent: only touches bills that still have advance_payment = 0 (a
// bill already repaired, or a fresh one from the fixed checkout path,
// always has advance_payment > 0 here and is skipped).
function repairLegacyAdvanceBills() {
  const candidates = db.prepare(`
    SELECT b.id as billId, b.discount, b.subtotal, b.tax_amount, r.advance_applied
    FROM bills b
    JOIN room_bookings r ON r.bill_id = b.id
    WHERE b.source = 'ROOM' AND b.advance_payment = 0 AND r.advance_applied > 0
  `).all();
  if (!candidates.length) return;
  const update = db.prepare(`
    UPDATE bills SET discount = ?, advance_payment = ?, total = ?, balance_due = ? WHERE id = ?
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      // advance_applied can never legitimately exceed what was folded into
      // discount at the time (checkOut caps it at the room's own charge) —
      // this Math.min guard just protects against any inconsistent/edited
      // historical data instead of ever producing a negative discount.
      const advance = Math.min(row.advance_applied, row.discount || 0);
      const newDiscount = +((row.discount || 0) - advance).toFixed(2);
      const newTotal = +((row.subtotal || 0) + (row.tax_amount || 0) - newDiscount).toFixed(2);
      const newBalanceDue = +(newTotal - advance).toFixed(2);
      update.run(newDiscount, advance, newTotal, newBalanceDue, row.billId);
    }
  });
  tx(candidates);
}

// One-time backfill of `booking_number` for pre-existing ROOM bills created
// before that column existed — joins back to room_bookings via bill_id to
// recover each bill's actual booking reference. Idempotent: only touches
// bills where booking_number is still NULL.
function backfillBillBookingNumbers() {
  const rows = db.prepare(`
    SELECT b.id as billId, r.booking_number FROM bills b
    JOIN room_bookings r ON r.bill_id = b.id
    WHERE b.source = 'ROOM' AND b.booking_number IS NULL
  `).all();
  if (!rows.length) return;
  const update = db.prepare('UPDATE bills SET booking_number = ? WHERE id = ?');
  const tx = db.transaction((list) => {
    for (const row of list) update.run(row.booking_number, row.billId);
  });
  tx(rows);
}

// One-time backfill of the biz_* profile-snapshot columns for bills created
// before they existed. There's no way to recover the EXACT settings in
// effect at the time each old bill was made, so this is a best-effort
// snapshot using whatever the business profile (Food vs Room, per
// bill.source) is configured as right now — after this runs once, every
// future bill snapshots its own profile at creation time and is never
// touched here again (see WHERE biz_name IS NULL, making this idempotent).
function backfillBillProfileSnapshots() {
  const settingsRows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of settingsRows) settings[r.key] = r.value;
  const pick = (source) => (source === 'ROOM'
    ? {
      name: settings.room_biz_name || 'Hotel',
      address: settings.room_biz_address || '',
      phone: settings.room_biz_phone || '',
      gstin: settings.room_biz_gstin || '',
      footer: settings.room_bill_footer || 'Thank you! Visit again.',
      upi: settings.room_upi_id || '',
      logo: settings.room_biz_logo_path || '',
    }
    : {
      name: settings.hotel_name || 'Hotel',
      address: settings.hotel_address || '',
      phone: settings.hotel_phone || '',
      gstin: settings.hotel_gstin || '',
      footer: settings.bill_footer || 'Thank you! Visit again.',
      upi: settings.upi_id || '',
      logo: '',
    });
  const foodIdentity = pick('FOOD');
  const roomIdentity = pick('ROOM');
  const update = db.prepare(`
    UPDATE bills SET biz_name=?, biz_address=?, biz_phone=?, biz_gstin=?, biz_footer=?, biz_upi_id=?, biz_logo_path=? WHERE id=?
  `);
  const rows = db.prepare("SELECT id, source FROM bills WHERE biz_name IS NULL").all();
  const tx = db.transaction((list) => {
    for (const row of list) {
      const identity = row.source === 'ROOM' ? roomIdentity : foodIdentity;
      update.run(identity.name, identity.address, identity.phone, identity.gstin, identity.footer, identity.upi, identity.logo, row.id);
    }
  });
  tx(rows);
}

// Adds new columns to room_bookings for existing (already created) databases
// (guest GSTIN for GST-calculated business invoices, a path to an uploaded
// ID-proof document, a shared booking_group_id linking rooms booked together
// in one multi-room reservation, and an advance payment collected upfront).
function migrateRoomBookingsTableColumns() {
  const cols = db.prepare('PRAGMA table_info(room_bookings)').all().map((c) => c.name);
  const ensure = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE room_bookings ADD COLUMN ${ddl}`);
  };
  ensure('guest_gstin', 'guest_gstin TEXT');
  ensure('guest_id_document_path', 'guest_id_document_path TEXT');
  ensure('guest_id_document_paths', 'guest_id_document_paths TEXT');
  ensure('booking_group_id', 'booking_group_id TEXT');
  ensure('advance_payment', 'advance_payment REAL NOT NULL DEFAULT 0');
  ensure('advance_payment_method', 'advance_payment_method TEXT');
  // Tracks how much of the advance was actually returned to the guest when
  // a booking is cancelled (staff enters this at cancel time — could be a
  // full refund, a partial refund, or 0 to forfeit it as a cancellation
  // fee). NULL until a cancellation actually happens, so a normal active/
  // checked-out booking is never confused with "refund of ₹0 given".
  ensure('refund_amount', 'refund_amount REAL');
  ensure('refund_method', 'refund_method TEXT');
  // How much of the group's upfront advance was actually deducted from THIS
  // room's own bill at its checkout (may be less than the full advance if
  // it's larger than this room's charge — the remainder carries forward to
  // the next room in the group's checkout instead of pushing this bill's
  // total negative).
  ensure('advance_applied', 'advance_applied REAL NOT NULL DEFAULT 0');
}

// Adds the `access` column (module-level permission: BOTH | FOOD | ROOMS) for
// existing databases created before per-staff module access was introduced.
// Existing staff default to BOTH so nobody's access silently shrinks on
// upgrade — an Owner can then dial individual staff down from Manage Staff.
function migrateUsersTableColumns() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const ensure = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
  };
  ensure('access', "access TEXT NOT NULL DEFAULT 'BOTH'");
}

// Waiter/captain assignment for the Table/Area Management feature — a
// table can have a staff member's name attached to it (picked from the
// existing Staff accounts list) so front-of-house knows who's serving it.
// Purely informational: it doesn't gate billing or change access control.
function migrateRestaurantTablesColumns() {
  const cols = db.prepare('PRAGMA table_info(restaurant_tables)').all().map((c) => c.name);
  const ensure = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE restaurant_tables ADD COLUMN ${ddl}`);
  };
  ensure('waiter_name', 'waiter_name TEXT');
}

// A starter set of common occasions so the WhatsApp festival-greetings
// feature (Settings > Integrations > WhatsApp) isn't an empty list on first
// install — all disabled by default (enabled=0) so nothing sends until the
// owner reviews the message text and turns them on deliberately. Fixed
// calendar dates only (month_day); lunar-calendar festivals like Diwali move
// every year, so those are left for the owner to add/adjust with the
// correct date for that year.
function seedFestivalDefaults() {
  const count = db.prepare('SELECT COUNT(*) c FROM festival_greetings').get().c;
  if (count > 0) return;
  const insert = db.prepare(
    'INSERT INTO festival_greetings (name, month_day, message_template, enabled) VALUES (?, ?, ?, 0)'
  );
  const defaults = [
    ['New Year', '01-01', 'Wishing you a very Happy New Year from all of us at {hotel_name}! 🎉'],
    ['Republic Day', '01-26', 'Happy Republic Day from {hotel_name}! 🇮🇳'],
    ["Women's Day", '03-08', "Happy Women's Day from {hotel_name}! 💐"],
    ['Independence Day', '08-15', 'Happy Independence Day from {hotel_name}! 🇮🇳'],
    ['Christmas', '12-25', 'Wishing you a Merry Christmas from {hotel_name}! 🎄'],
  ];
  for (const [name, monthDay, template] of defaults) insert.run(name, monthDay, template);
}

function seedDefaults() {
  const catCount = db.prepare('SELECT COUNT(*) c FROM categories').get().c;
  if (catCount === 0) {
    const insertCat = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
    const insertFood = db.prepare(
      'INSERT INTO food_items (name, category_id, price, image_path, is_veg) VALUES (?, ?, ?, ?, ?)'
    );
    const categories = [
      ['Starters', 1],
      ['Main Course', 2],
      ['Breads', 3],
      ['Rice & Biryani', 4],
      ['Desserts', 5],
      ['Beverages', 6],
    ];
    const catIds = {};
    for (const [name, order] of categories) {
      const info = insertCat.run(name, order);
      catIds[name] = info.lastInsertRowid;
    }
    const foods = [
      ['Paneer Tikka', 'Starters', 220, 1, DEFAULT_FOOD_IMAGES['Paneer Tikka']],
      ['Chicken 65', 'Starters', 260, 0, DEFAULT_FOOD_IMAGES['Chicken 65']],
      ['Veg Spring Roll', 'Starters', 180, 1, DEFAULT_FOOD_IMAGES['Veg Spring Roll']],
      ['Butter Chicken', 'Main Course', 320, 0, DEFAULT_FOOD_IMAGES['Butter Chicken']],
      ['Paneer Butter Masala', 'Main Course', 260, 1, DEFAULT_FOOD_IMAGES['Paneer Butter Masala']],
      ['Dal Makhani', 'Main Course', 200, 1, DEFAULT_FOOD_IMAGES['Dal Makhani']],
      ['Tandoori Roti', 'Breads', 30, 1, DEFAULT_FOOD_IMAGES['Tandoori Roti']],
      ['Butter Naan', 'Breads', 45, 1, DEFAULT_FOOD_IMAGES['Butter Naan']],
      ['Veg Biryani', 'Rice & Biryani', 220, 1, DEFAULT_FOOD_IMAGES['Veg Biryani']],
      ['Chicken Biryani', 'Rice & Biryani', 280, 0, DEFAULT_FOOD_IMAGES['Chicken Biryani']],
      ['Gulab Jamun', 'Desserts', 90, 1, DEFAULT_FOOD_IMAGES['Gulab Jamun']],
      ['Ice Cream', 'Desserts', 100, 1, DEFAULT_FOOD_IMAGES['Ice Cream']],
      ['Masala Chai', 'Beverages', 40, 1, DEFAULT_FOOD_IMAGES['Masala Chai']],
      ['Cold Coffee', 'Beverages', 110, 1, DEFAULT_FOOD_IMAGES['Cold Coffee']],
    ];
    for (const [name, cat, price, veg, image] of foods) {
      insertFood.run(name, catIds[cat], price, image, veg);
    }
  }

  backfillDefaultFoodImages();
  upgradeDefaultFoodImagesToPhotos();
  seedInventoryDefaults();
  seedRoomDefaults();

  // Placeholder / default values for hotel-specific details. These are shown as
  // editable placeholders in the Settings screen so the owner can personalize
  // them during first-time setup and change them again anytime later.
  //
  // `hotel_name`/`hotel_address`/`hotel_phone`/`hotel_gstin`/`bill_footer`/
  // `tax_percent`/`upi_id` are the Restaurant / Food Billing business
  // identity — shown on Food bills and used throughout WhatsApp/festival
  // messages. `room_biz_*` is the SEPARATE Hotel / Room Booking business
  // identity — shown only on room-booking invoices — so an install can have
  // a different legal/trade name, GSTIN, footer message and UPI ID for its
  // restaurant vs. its hotel side (e.g. "Green Leaf Restaurant" vs "Green
  // Leaf Residency"). New installs get generic placeholders for both; an
  // existing install upgrading from before this feature existed gets its
  // room_biz_* fields pre-filled with whatever it already had configured
  // (so nothing changes on room invoices until the owner deliberately edits
  // the new Hotel section separately in Settings).
  const legacy = (key, fallback) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value) || fallback;
  const defaultSettings = {
    hotel_name: 'My Hotel Restaurant',
    hotel_address: '123, Main Street, Your City, State - 000000',
    hotel_phone: '+91 90000 00000',
    hotel_gstin: 'GSTIN: 00AAAAA0000A1Z5',
    bill_footer: 'Thank you! Visit again.',
    tax_percent: '5',
    // Cash vs Online tax slabs — many businesses charge a different
    // effective GST/tax rate (or none at all) depending on payment method
    // (e.g. 0% on cash, 8% on Online/UPI/Card per a fixed slab). Cart.jsx
    // and BookingFormModal auto-select one of these the moment the cashier
    // picks a payment method, while still letting them override it per
    // bill/booking. Existing installs get both pre-filled from whatever
    // single `tax_percent` they already had, so nothing changes silently.
    tax_percent_cash: legacy('tax_percent', '5'),
    tax_percent_online: legacy('tax_percent', '5'),
    upi_id: '',
    room_biz_name: legacy('hotel_name', 'My Hotel'),
    room_biz_address: legacy('hotel_address', '123, Main Street, Your City, State - 000000'),
    room_biz_phone: legacy('hotel_phone', '+91 90000 00000'),
    room_biz_gstin: legacy('hotel_gstin', 'GSTIN: 00AAAAA0000A1Z5'),
    room_bill_footer: legacy('bill_footer', 'Thank you! Visit again.'),
    room_upi_id: legacy('upi_id', ''),
    // Hotel logo shown on the room-invoice letterhead (A4 format) next to
    // the hotel name — a local file path (desktop) or data: URL (mobile),
    // same pattern as food_items.image_path / guest_id_document_path.
    room_biz_logo_path: '',
    room_tax_percent_cash: '0',
    room_tax_percent_online: '0',
    food_printer_name: '',
    room_printer_name: '',
    kot_printer_name: '',
    printer_paper_width: '80',
    printer_scale_percent: '100',
    room_invoice_format: 'A4',
    setup_completed: 'false',
    // Opt-in feature toggles for the multi-tenant/SaaS roadmap — every
    // install defaults to OFF so a plain single-counter restaurant sees no
    // change; an Owner can enable them per-install (or, once cloud-hosted,
    // they'll be set per-customer license/plan) from Settings > Features.
    feature_table_management: 'false',
    feature_captain_app: 'false',
    feature_multi_terminal_sync: 'false',
    whatsapp_send_room_checkin: 'false',
    whatsapp_provider: 'BAILEYS',
    whatsapp_cloud_template_name: '',
    whatsapp_cloud_template_language: 'en_US',
    whatsapp_checkout_review_request: 'false',
    whatsapp_room_review_link: '',
    whatsapp_food_bill_template: 'Hi {customer_name}, please find bill {bill_number} from {business_name}. Total: {total}. Thank you!',
    whatsapp_room_booking_template: '✅ Hi {guest_name}, Your Booking is Confirmed at {hotel_name} 🎉\n\n📅 Your Booking Details:\n\nBooking ID: {booking_number}\nCheck-in: {check_in}\nCheck-out: {check_out}\nRoom/Bed: {room}\n\nTotal Amount: {total}\nAmount Paid: {advance}\n\n📞 For any queries, please contact the property: {hotel_phone}. You can reply to this message to chat with hotel team directly!\n📍 Location: {hotel_address}\n\nLooking forward to hosting you!\n{hotel_name} Team',
    whatsapp_room_checkin_template: '✅ Welcome {guest_name} to {hotel_name}! 🎉\n\nBooking ID: {booking_number}\nRoom/Bed: {room}\nCheck-out: {check_out}\n\n📞 For queries: {hotel_phone}\n📍 Location: {hotel_address}\n\nWe hope you have a pleasant stay!\n{hotel_name} Team',
    whatsapp_room_checkout_template: '✅ Thank you for staying with {hotel_name}, {guest_name}!\n\nBooking ID: {booking_number}\nRoom/Bed: {room}\nTotal Amount: {total}\nAmount Paid: {advance}\n\n📞 For queries: {hotel_phone}\n📍 Location: {hotel_address}\n\nWe look forward to hosting you again!\n{hotel_name} Team',
  };
  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaultSettings)) {
    const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!existing) insertSetting.run(key, value);
  }

  // A stable per-install identifier, generated once and never overwritten.
  // Not used for anything yet on this single-tenant desktop app, but this is
  // exactly the `tenant_id` a future cloud-hosted BillNest backend would use
  // to namespace this restaurant's data among many customers — baking it in
  // now means zero migration work later when that day comes.
  const existingTenantId = db.prepare("SELECT value FROM settings WHERE key = 'tenant_id'").get();
  if (!existingTenantId) {
    insertSetting.run('tenant_id', require('crypto').randomUUID());
  }
}

// ---------- Token & Bill Number generation ----------
// Token format: <PREFIX><NNN...> where PREFIX = B (Cash) or G (Online Gateway)
// Numeric part is 2-6 digits, resets daily, grows from 2 digits up to 6 as needed.
function nextToken(paymentMethod) {
  const prefix = paymentMethod === 'ONLINE' ? 'G' : 'B';
  const dateKey = new Date().toISOString().slice(0, 10);
  const counterKey = `token_${prefix}_${dateKey}`;
  const row = db.prepare('SELECT value FROM counters WHERE key = ?').get(counterKey);
  let next = row ? row.value + 1 : 1;
  if (row) {
    db.prepare('UPDATE counters SET value = ? WHERE key = ?').run(next, counterKey);
  } else {
    db.prepare('INSERT INTO counters (key, value) VALUES (?, ?)').run(counterKey, next);
  }
  const digits = next < 100 ? 2 : next < 1000 ? 3 : next < 10000 ? 4 : next < 100000 ? 5 : 6;
  return `${prefix}${String(next).padStart(digits, '0')}`;
}

function nextBillNumber() {
  const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const counterKey = `bill_${dateKey}`;
  const row = db.prepare('SELECT value FROM counters WHERE key = ?').get(counterKey);
  let next = row ? row.value + 1 : 1;
  if (row) {
    db.prepare('UPDATE counters SET value = ? WHERE key = ?').run(next, counterKey);
  } else {
    db.prepare('INSERT INTO counters (key, value) VALUES (?, ?)').run(counterKey, next);
  }
  return `INV-${dateKey}-${String(next).padStart(4, '0')}`;
}

function nextKotNumber() {
  const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const counterKey = `kot_${dateKey}`;
  const row = db.prepare('SELECT value FROM counters WHERE key = ?').get(counterKey);
  let next = row ? row.value + 1 : 1;
  if (row) {
    db.prepare('UPDATE counters SET value = ? WHERE key = ?').run(next, counterKey);
  } else {
    db.prepare('INSERT INTO counters (key, value) VALUES (?, ?)').run(counterKey, next);
  }
  return `KOT-${dateKey}-${String(next).padStart(4, '0')}`;
}

function nextBookingNumber() {
  const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const counterKey = `booking_${dateKey}`;
  const row = db.prepare('SELECT value FROM counters WHERE key = ?').get(counterKey);
  let next = row ? row.value + 1 : 1;
  if (row) {
    db.prepare('UPDATE counters SET value = ? WHERE key = ?').run(next, counterKey);
  } else {
    db.prepare('INSERT INTO counters (key, value) VALUES (?, ?)').run(counterKey, next);
  }
  return `BKG-${dateKey}-${String(next).padStart(4, '0')}`;
}

function getDb() {
  return db;
}

function getBillRecordsDir() {
  return billRecordsDir;
}

function getKotRecordsDir() {
  return kotRecordsDir;
}

function getDbFilePath() {
  return dbFilePath;
}

// Wipes all transactional/business data (bills, bookings, purchases,
// expenses, stock ledger, staff/owner accounts, hotel settings). By default
// keeps the reusable "catalog" data an owner doesn't want to re-enter from
// scratch: the food menu (categories + food_items + recipe_items), the raw
// materials list (only its current_stock is zeroed, not the item itself),
// and the rooms/restaurant_tables lists (only their live status is reset).
// Pass `fullWipe: true` to ALSO erase the catalog itself — menu items,
// categories, recipes, raw materials, rooms and tables — for a genuinely
// blank/brand-new install with nothing pre-populated.
// Used exclusively by the standalone Factory Reset tool (electron/factoryReset.cjs)
// — never exposed to the regular in-app UI.
function factoryReset({ fullWipe = false } = {}) {
  const wipe = db.transaction(() => {
    db.exec(`
      DELETE FROM booking_addons;
      DELETE FROM booking_contacts;
      DELETE FROM room_bookings;
      DELETE FROM bill_items;
      DELETE FROM bills;
      DELETE FROM stock_movements;
      DELETE FROM purchase_orders;
      DELETE FROM expenses;
      DELETE FROM users;
      DELETE FROM settings;
      DELETE FROM counters;
      DELETE FROM whatsapp_log;
      DELETE FROM table_orders;
    `);
    if (fullWipe) {
      db.exec(`
        DELETE FROM recipe_items;
        DELETE FROM food_items;
        DELETE FROM categories;
        DELETE FROM raw_materials;
        DELETE FROM rooms;
        DELETE FROM restaurant_tables;
      `);
    } else {
      db.exec(`
        UPDATE raw_materials SET current_stock = 0;
        UPDATE restaurant_tables SET status = 'EMPTY';
      `);
    }
  });
  wipe();
  db.exec('VACUUM');
  seedDefaults();


  // Clear out old printed bill/KOT files too — the DB rows referencing them
  // are already gone, so leaving the files around would just be orphaned
  // clutter with no way to open them from the (now-empty) app.
  for (const dir of [billRecordsDir, kotRecordsDir]) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, file)); } catch { /* skip files in use */ }
    }
  }
}

module.exports = {
  initDatabase,
  getDb,
  getBillRecordsDir,
  getKotRecordsDir,
  getDbFilePath,
  nextToken,
  nextBillNumber,
  nextKotNumber,
  nextBookingNumber,
  factoryReset,
  // Exported mainly so regression tests can exercise these one-time
  // migration/repair/backfill routines directly against hand-crafted
  // "legacy" rows, without needing a real pre-upgrade database fixture.
  repairLegacyAdvanceBills,
  backfillBillProfileSnapshots,
  backfillBillBookingNumbers,
};
