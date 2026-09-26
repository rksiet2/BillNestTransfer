#!/usr/bin/env node
// BillNest — Standalone Data Reset Tool.
//
// Runs completely outside the normal app UI (double-click "Reset BillNest
// Data.bat" next to the installed BillNest.exe) so it still works even if
// the app itself won't launch. Reuses the exact same DB/schema/backup code
// as the app (db/database.cjs, db/backupService.cjs, db/userService.cjs)
// so there is only ONE place that understands the data shape.
//
// Two reset levels:
//   1) "Wipe specific records" — pick which category of transactional data
//      to clear (Bills, Bookings, Expenses, Purchases, KOT/Bill PDF files,
//      Inventory stock counts) while keeping Menu/Rooms/Settings/Staff.
//   2) "Wipe EVERYTHING" — deletes the database + Bill Records + KOT
//      Records entirely; next app launch starts the Setup Wizard fresh,
//      as if freshly installed.
//
// Safety: an automatic full backup (same format as Settings → Backup Now)
// is always taken first, and both reset levels require the Owner PIN plus
// typing the word DELETE to confirm.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const APP_DATA_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'billnest')
  : path.join(require('os').homedir(), '.config', 'billnest');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function line() { console.log('─'.repeat(60)); }

async function main() {
  console.log('');
  line();
  console.log('  BillNest — Data Reset Tool');
  line();
  console.log(`Data folder: ${APP_DATA_DIR}`);

  const dbPath = path.join(APP_DATA_DIR, 'data', 'hotel_billing.db');
  if (!fs.existsSync(dbPath)) {
    console.log('\nNo BillNest data found here — nothing to reset. Exiting.');
    return rl.close();
  }

  const { initDatabase, getDb, getBillRecordsDir, getKotRecordsDir } = require('../db/database.cjs');
  const { loginWithPin } = require('../db/userService.cjs');
  const { performBackup } = require('../db/backupService.cjs');
  initDatabase(APP_DATA_DIR);

  // ---- Step 1: Owner PIN check ----
  let owner = null;
  for (let attempt = 1; attempt <= 3 && !owner; attempt++) {
    const pin = await ask('\nEnter Owner PIN to continue: ');
    const user = loginWithPin(pin);
    if (user && user.role === 'OWNER') { owner = user; break; }
    console.log(attempt < 3 ? 'Incorrect PIN — that PIN is either wrong or not an Owner account.' : 'Incorrect PIN — too many attempts.');
  }
  if (!owner) { console.log('\nExiting without changes.'); return rl.close(); }
  console.log(`\nWelcome, ${owner.name}.`);

  // ---- Step 2: choose reset level ----
  console.log('\nWhat would you like to do?');
  console.log('  1) Wipe SPECIFIC records (choose what to clear, keep Menu/Rooms/Settings/Staff)');
  console.log('  2) Wipe EVERYTHING (full factory reset — app starts fresh Setup Wizard next launch)');
  console.log('  3) Cancel');
  const choice = await ask('\nEnter 1, 2 or 3: ');
  if (choice !== '1' && choice !== '2') { console.log('\nCancelled — no changes made.'); return rl.close(); }

  // ---- Step 3: mandatory safety backup ----
  const backupFolder = await ask('\nWhere should the automatic safety backup be saved? (folder path): ');
  if (!backupFolder || !fs.existsSync(backupFolder)) {
    console.log('That folder does not exist. Exiting without changes to be safe.');
    return rl.close();
  }
  try {
    performBackup(backupFolder);
    console.log(`Safety backup saved to: ${path.join(backupFolder, 'BillNest-Backup')}`);
  } catch (err) {
    console.log(`Could not create safety backup (${err.message}). Exiting without changes to be safe.`);
    return rl.close();
  }

  // ---- Step 4: confirm ----
  const confirmWord = await ask(`\nThis cannot be undone (a backup was just saved though). Type DELETE to confirm: `);
  if (confirmWord !== 'DELETE') { console.log('\nConfirmation text did not match — cancelled, no changes made.'); return rl.close(); }

  if (choice === '2') {
    await wipeEverything();
  } else {
    await wipeSpecificRecords(getDb, getBillRecordsDir, getKotRecordsDir);
  }
  rl.close();
}

async function wipeSpecificRecords(getDb, getBillRecordsDir, getKotRecordsDir) {
  const db = getDb();
  console.log('\nWhich categories should be wiped? Enter comma-separated numbers, e.g. 1,3,5');
  const options = [
    { key: 'bills', label: 'Bills & Bill History (bills + bill_items)' },
    { key: 'bookings', label: 'Room Bookings (bookings + add-ons + guest contacts)' },
    { key: 'expenses', label: 'Expenses' },
    { key: 'purchases', label: 'Purchase Orders & stock movement ledger' },
    { key: 'kot_files', label: 'KOT Record PDF files (on disk)' },
    { key: 'bill_files', label: 'Bill Record PDF files (on disk)' },
    { key: 'stock_reset', label: 'Reset Inventory stock counts to 0 (keeps raw material definitions)' },
  ];
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`));
  const raw = await ask('\nYour choice(s): ');
  const picked = new Set(
    raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n >= 1 && n <= options.length).map((n) => options[n - 1].key)
  );
  if (picked.size === 0) { console.log('\nNothing selected — cancelled, no changes made.'); return; }

  if (picked.has('bills')) {
    db.exec('DELETE FROM bill_items; DELETE FROM bills;');
    console.log('✔ Bills & bill history cleared.');
  }
  if (picked.has('bookings')) {
    db.exec('DELETE FROM booking_addons; DELETE FROM booking_contacts; DELETE FROM room_bookings;');
    console.log('✔ Room bookings cleared.');
  }
  if (picked.has('expenses')) {
    db.exec('DELETE FROM expenses;');
    console.log('✔ Expenses cleared.');
  }
  if (picked.has('purchases')) {
    db.exec('DELETE FROM stock_movements; DELETE FROM purchase_orders;');
    console.log('✔ Purchase orders & stock ledger cleared.');
  }
  if (picked.has('stock_reset')) {
    db.exec('UPDATE raw_materials SET current_stock = 0;');
    console.log('✔ Inventory stock counts reset to 0.');
  }
  if (picked.has('kot_files')) {
    clearFolderContents(getKotRecordsDir());
    console.log('✔ KOT Record files deleted.');
  }
  if (picked.has('bill_files')) {
    clearFolderContents(getBillRecordsDir());
    console.log('✔ Bill Record files deleted.');
  }
  console.log('\nDone. Menu, Rooms, Settings and Staff accounts were left untouched.');
}

async function wipeEverything() {
  // We deliberately do NOT close/query the DB here — the whole folder
  // (including the DB file) is about to be deleted outright, and the
  // caller closes the readline interface right after this returns.
  const target = APP_DATA_DIR;
  console.log('\nWiping everything — this may take a moment for large record folders...');
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`\n✔ All data deleted (${target}).`);
  console.log('BillNest will show the Setup Wizard again next time it is opened, as if freshly installed.');
}

function clearFolderContents(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\nUnexpected error:', err.message || err);
  process.exitCode = 1;
});
