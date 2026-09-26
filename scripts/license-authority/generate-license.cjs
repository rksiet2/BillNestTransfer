#!/usr/bin/env node
// VENDOR-ONLY TOOL — run this yourself, once per sale, on your own computer.
// NEVER ship this file or your private key with the app.
//
// Usage:
//   node scripts/license-authority/generate-license.cjs <machineId> "<Hotel Name>" [YYYY-MM-DD|perpetual] [modules]
//
// <machineId>  — the code the customer's Activation screen shows them
//                (BillNest > Activation Required > "Your Machine ID").
// "<Hotel Name>" — shown back to them once activated, purely descriptive.
// [expiry]     — omit or pass "perpetual" for a one-time never-expiring
//                license, or a date like 2027-09-09 for a term/subscription
//                license that will need renewing.
// [modules]    — which parts of the app this key unlocks. One of:
//                  both  (default) — Food Billing + Room Booking, full app
//                  food            — Food Billing / restaurant side only
//                                    (Billing, Tables, Food Details,
//                                    Inventory, Reporting) — Room Booking is
//                                    hidden entirely on this install
//                  rooms           — Hotel/Room Booking side only
//                                    (Room Availability, Bookings, Rooms,
//                                    Reporting) — Food Billing is hidden
//                                    entirely on this install
//                Sell a cheaper "Food Billing only" or "Hotel Billing only"
//                plan by issuing a key with just that one module.
//
// Produces scripts/license-authority/license-<hotel-slug>.lic (gitignored)
// and prints the same code to the console — send either the file or the
// printed text to the customer; they paste it into the Activation screen.
// Every license issued here is also recorded in licenses.db so it shows up
// in the BillNest Dashboard (license-dashboard/, `npm run dashboard`)
// alongside any issued/extended from there — one combined history either way.
//
// Produces scripts/license-authority/license-<hotel-slug>.lic (gitignored)
// and prints the same code to the console — send either the file or the
// printed text to the customer; they paste it into the Activation screen.
const fs = require('fs');
const path = require('path');
const { generateLicenseBlob } = require('./license-core.cjs');
const { recordLicense } = require('./licenses-db.cjs');

const [, , machineId, hotelName, expiryArg, modulesArg] = process.argv;
if (!machineId || !hotelName) {
  console.error('Usage: node generate-license.cjs <machineId> "<Hotel Name>" [YYYY-MM-DD|perpetual] [both|food|rooms]');
  process.exit(1);
}

let blob, payload;
try {
  ({ blob, payload } = generateLicenseBlob({ machineId, hotelName, expiryArg, modulesArg }));
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

recordLicense({
  clientName: payload.hotelName,
  machineId: payload.machineId,
  modules: payload.modules,
  issuedAt: payload.issuedAt,
  expiresAt: payload.expiresAt,
  blob,
});

const slug = hotelName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'license';
const outFile = path.join(__dirname, `license-${slug}.lic`);
fs.writeFileSync(outFile, blob, 'utf8');

console.log(`\n✅ License generated for "${payload.hotelName}"`);
console.log(`   Machine ID : ${payload.machineId}`);
console.log(`   Modules    : ${payload.modules.join(' + ')}`);
console.log(`   Expires    : ${payload.expiresAt ? new Date(payload.expiresAt).toLocaleDateString() : 'Never (perpetual)'}`);
console.log(`   Saved to   : ${outFile}`);
console.log('   Tracked in : scripts/license-authority/licenses.db (view via `npm run dashboard`)\n');
console.log('--- License code (send this whole line to the customer) ---\n');
console.log(blob);
console.log('\n-------------------------------------------------------------');

