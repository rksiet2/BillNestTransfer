# BillNest Licensing (Vendor Tools)

This folder is **your private licensing toolkit**. Nothing in here ships with
the app — the app only embeds your **public** key (in `electron/licensing.cjs`).

## One-time setup

```
node scripts/license-authority/generate-keypair.cjs
```

This prints a PUBLIC key and a PRIVATE key.

1. Paste the **PUBLIC** key into `electron/licensing.cjs`, replacing the
   `PUBLIC_KEY_PEM` placeholder. Rebuild/ship the app with this change —
   every copy of the app you distribute shares this same public key.
2. Save the **PRIVATE** key into `scripts/license-authority/private-key.pem`
   (this exact filename — `generate-license.cjs` looks for it there).
   This file is already covered by `.gitignore` so it can never be
   accidentally committed/pushed. Also keep an offline backup of it
   somewhere safe (USB drive, password manager) — if you lose it, you can
   never issue a new license with this same key again, and everyone
   would need a new build with a new public key.

## Issuing a license (do this each time you sell to a new customer/machine)

1. Ask the customer to open BillNest — if unlicensed, it shows an
   **Activation Required** screen with their **Machine ID**. Have them send
   you that code (copy/paste via WhatsApp/email).
2. Run:
   ```
   node scripts/license-authority/generate-license.cjs <machineId> "Hotel Name" [YYYY-MM-DD|perpetual]
   ```
   Example (never-expiring):
   ```
   node scripts/license-authority/generate-license.cjs 9f2a...c31 "Hotel Sunrise" perpetual
   ```
   Example (1-year term license):
   ```
   node scripts/license-authority/generate-license.cjs 9f2a...c31 "Hotel Sunrise" 2027-09-09
   ```
3. This prints a license code (and saves it as a `.lic` file in this folder,
   also gitignored). Send that code/file back to the customer.
4. They paste it into BillNest's Activation screen → the app unlocks on
   that machine only.

## Why this can't just be copied to another PC

The license is cryptographically bound to the customer's specific
**Machine ID** (their motherboard's SMBIOS UUID) and signed with your
private key. If someone copies the whole install (including their
`license.lic`) to a different computer, the Machine ID no longer matches
what's inside the signed license, so it's rejected — that new machine needs
its own license from you.

## Multiple terminals at one hotel

Multi-Terminal Sync (LAN Host/Client mode) does **not** need separate
licenses per terminal — only the **Host** machine (the one holding the real
database) needs a license. Client terminals just connect to an already
licensed Host over the local network and never touch the database directly.
