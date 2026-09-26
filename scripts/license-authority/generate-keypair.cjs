// VENDOR-ONLY TOOL — run this once, by you, on your own computer.
// NEVER ship this file or the private key it prints with the app.
//
// Creates your signing keypair for BillNest's offline licensing system.
//
// Usage:
//   node scripts/license-authority/generate-keypair.cjs
//
// Then:
//   1. Copy the PUBLIC KEY block into electron/licensing.cjs
//      (replace the PUBLIC_KEY_PEM placeholder).
//   2. Save the PRIVATE KEY block into
//      scripts/license-authority/private-key.pem (already gitignored) —
//      this file is what lets YOU (and only you) generate valid licenses.
//      Keep a backup of it somewhere safe outside this machine too; if you
//      lose it, you can no longer issue new licenses with this same key,
//      and every license.lic already issued would need reissuing on a new key.
const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

console.log('\n=== PUBLIC KEY — paste into electron/licensing.cjs (PUBLIC_KEY_PEM) ===\n');
console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString());

console.log('=== PRIVATE KEY — save as scripts/license-authority/private-key.pem, keep SECRET ===\n');
console.log(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
