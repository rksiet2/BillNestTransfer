# BillNest Licensing — Reference & To-Do

> Last updated: 2026-09-14

---

## How the System Works

**Fully offline, machine-locked software licensing using EdDSA (Ed25519) cryptographic signing.**

1. Each installation computes a unique **Machine ID** from the motherboard's SMBIOS UUID (stable across OS reinstalls, changes if the app is copied to different hardware).
2. The vendor runs a private tool (`scripts/license-authority/generate-license.cjs`) to Ed25519-sign `{ machineId, hotelName, expiresAt, modules }` with a private key only the vendor holds.
3. The app verifies that signature using a public key baked into the build, and checks that the signed `machineId` matches this machine.
4. Copying an install to a different PC changes the Machine ID — the old license becomes invalid, forcing a new license purchase.

**Fully offline — no server, no internet requirement.**

---

## License Payload Structure

```json
{
  "machineId": "d1e05ee9c143e32f...",
  "hotelName": "Hotel Amber Inn",
  "issuedAt": "2026-09-13T15:52:45.799Z",
  "expiresAt": "2027-09-13T00:00:00.000Z",   // null = perpetual
  "modules": ["food", "rooms"]                 // or ["food"] or ["rooms"]
}
```

---

## Module Tiers

| Key | What it unlocks | Use case |
|-----|-----------------|----------|
| `both` | Food Billing + Room Booking | Full app |
| `food` | Food Billing only | Restaurant-only customer |
| `rooms` | Room Booking only | Hotel-only customer |

---

## File Locations

### Core licensing (shipped with app)
| File | Purpose |
|------|---------|
| `electron/licensing.cjs` | License validation engine (grace period, expiry, machine binding) |
| `electron/main.cjs` | License gate at startup + hourly recheck |
| `src/components/Licensing/ActivationScreen.jsx` | User activation UI |
| `src/components/Settings/LicenseInfoSection.jsx` | In-app license info panel (Settings page) |
| `electron/preload.cjs` | Exposes `getLicenseStatus`, `getMachineId`, `activateLicense` to renderer |

### Vendor-only tools (NEVER shipped with app)
| File | Purpose |
|------|---------|
| `scripts/license-authority/generate-keypair.cjs` | One-time keypair generation |
| `scripts/license-authority/generate-license.cjs` | CLI license issuance |
| `scripts/license-authority/license-core.cjs` | Shared signing logic |
| `scripts/license-authority/licenses-db.cjs` | Vendor history database abstraction |
| `scripts/license-authority/private-key.pem` | **SECRET — never commit, never lose** |
| `scripts/license-authority/licenses.db` | Vendor's local license history |
| `license-dashboard/server.cjs` | Web UI backend (runs at localhost:4790) |
| `license-dashboard/public/` | Web UI frontend |

---

## Vendor Workflow

### Initial Setup (one time only)
```bash
node scripts/license-authority/generate-keypair.cjs
# → Prints PUBLIC KEY (paste into electron/licensing.cjs)
# → Save PRIVATE KEY as scripts/license-authority/private-key.pem
# BACK UP THE PRIVATE KEY. If you lose it, you cannot issue new licenses.
```

### Running the Dashboard
```bash
npm run dashboard
# Opens http://localhost:4790 in your browser
# NEVER expose this on a public/shared network — it holds your signing key
```

### Issuing a License (CLI alternative)
```bash
node scripts/license-authority/generate-license.cjs <machineId> "<Hotel Name>" [YYYY-MM-DD|perpetual] [both|food|rooms]

# Examples:
node scripts/license-authority/generate-license.cjs 9f2a...c31 "Hotel Sunrise" 2027-09-14 both
node scripts/license-authority/generate-license.cjs 9f2a...c31 "Cafe Spice" 2027-03-14 food
node scripts/license-authority/generate-license.cjs 9f2a...c31 "Inn & Suites" perpetual rooms
```

---

## Seller ↔ Customer Scenario Coverage

### Seller Actions

| Scenario | Action | Result |
|----------|--------|--------|
| New customer, 6-month plan | Dashboard → New License, expiry = +6 months, choose modules | Generate blob, send to customer |
| New customer, 1-year plan | Same, expiry = +12 months | Generate blob, send |
| New customer, perpetual | Tick "Perpetual (never expires)" | Signed with `expiresAt: null`, never expires |
| Renewal / extend | Dashboard → Extend, set new expiry date | New blob re-issued to same machine, send to customer |
| Module upgrade (food → full) | Dashboard → Extend, change modules to "Both" | Re-issued blob with new modules, send |
| Module downgrade | Same, change modules | Re-issued blob |
| **Revoke access** | Dashboard → **Revoke** button (amber) | Re-issues blob with `expiresAt = yesterday`. Send to customer → once they apply it, access is blocked. If they don't apply it, access remains until natural expiry + grace passes. |
| Remove from history | Dashboard → Delete | Only removes vendor's own record. App on customer machine is NOT affected. |

> **Revoke limitation (offline trade-off):** Because the app is fully offline, you cannot push a file change to the customer's machine. Revoke works by re-issuing an expired blob that you send to the customer. Once they paste it into the Activation screen, access is immediately blocked. If they refuse to apply it, access remains until their current license expires naturally (expiry date + 7-day grace).

### Customer Experience

| Scenario | Experience |
|----------|------------|
| First install, unlicensed | Activation screen — copy Machine ID, paste license code, relaunch |
| License expires while app is open | Hourly recheck detects it → automatic relaunch → Activation screen |
| License expires, app closed | On next start → Activation screen |
| 14 days before expiry | Yellow banner at top of app: "Your license expires on [date] — contact your vendor to renew." Dismissible per-session. |
| 7 days before expiry | Same banner, more urgent text: "only 7 days left!" |
| Past expiry, within 7-day grace | App still works. Settings page shows "Grace period — Nd left" badge in amber. |
| Past grace (8+ days after expiry) | Activation screen shows "contact vendor to renew" |
| Tries to activate an expired blob | Error: "This license has expired. Contact the vendor to renew before activating." |
| Views own license info | Settings → License section: Hotel name, modules (color-coded badges), issued date, expiry date with status badge, Machine ID |
| Wrong machine | Activation screen: "This license is bound to a different computer" |
| Food-only license | Room Booking module hidden everywhere |
| Rooms-only license | Food Billing module hidden |

---

## Grace Period Logic

| State | Days past expiry | App behavior |
|-------|-----------------|--------------|
| Active | — (not expired) | Full access |
| Warning zone | -14 to -1 days (14 days before expiry) | Full access + yellow banner in app |
| Grace period | 0 to +7 days past expiry | Full access, no banner, "grace period" badge in Settings |
| Blocked | 8+ days past expiry | Activation screen, cannot use app |

---

## What Is Currently In Place

| Feature | Status | Details |
|---------|--------|---------|
| Expiry dates | ✅ | `expiresAt` in payload, checked at startup and hourly |
| 7-day grace period | ✅ | App works for 7 days after expiry; badge shown in Settings |
| Perpetual licenses | ✅ | `expiresAt: null` = never expires |
| Machine binding | ✅ | SMBIOS UUID → SHA256, bound to specific hardware |
| Module tiers | ✅ | food / rooms / both |
| Cryptographic signing | ✅ | Ed25519, cannot forge without private key |
| Offline validation | ✅ | No internet required, ever |
| In-app license info | ✅ | Settings → License section |
| Expiry warning banner | ✅ | 14-day advance warning, dismissible |
| Hourly runtime recheck | ✅ | Auto-relaunch to Activation screen when license expires |
| Vendor dashboard | ✅ | Create / Extend / Revoke / Delete at localhost:4790 |
| Revoke action | ✅ | Re-issues expired blob; customer must apply it |
| Copy-protection | ✅ | Machine ID embedded in signature |
| Multi-terminal support | ✅ | Only HOST needs license; Clients bypass check |
| Renewal flow | ✅ | Dashboard Extend re-issues for same machine with new dates |

---

## Known Gaps / Design Limitations (Offline Trade-offs)

| Gap | Why it exists | Workaround |
|-----|---------------|------------|
| Revoke requires customer cooperation | Offline app — cannot push file to customer machine | Issue short-expiry blob; customer must apply it, or wait for natural expiry |
| No usage reporting | No server | Trust / notes field in dashboard |
| No concurrent-user cap | No server | License is per-machine, not per-user seat |
| Fallback Machine ID weaker on locked-down VMs | PowerShell/WMI may be restricted | Hostname + CPU + RAM hash used instead; still unique per machine |
| Private key loss = system compromise | Single key for all licenses | **Back up private-key.pem to a secure, separate location immediately** |

---

## TO-DO (Future Enhancements)

- [ ] **Email / WhatsApp notification** — auto-remind customer 14 days before expiry with renewal instructions
- [ ] **Trial license type** — add `isTrialLicense: true` field + UI banner "Trial — X days left"  
- [ ] **Usage caps** — e.g. "up to 500 bills/month" license tier (requires server or local counter)
- [ ] **License export** — let customer export their license info from Settings for backup
- [ ] **Multi-location** — single license covering N machines (floating seat model; requires server)
- [ ] **Private key rotation plan** — documented procedure for what to do if `private-key.pem` is ever lost or leaked
- [ ] **Automated renewal reminder** — dashboard flag/email when any license is within 30 days of expiry

---

## Data Flow Summary

```
VENDOR SIDE:
1. generate-keypair.cjs → PUBLIC_KEY (paste into electron/licensing.cjs)
                        → PRIVATE_KEY (save as private-key.pem, keep secret + backed up)
2. Customer sends their Machine ID
3. npm run dashboard → New License (or generate-license.cjs CLI)
   → Outputs base64 license blob, records in licenses.db
4. Send license blob to customer (WhatsApp / email)

CUSTOMER SIDE:
1. Open unlicensed app → Activation screen
2. Copy Machine ID from screen
3. Send to vendor
4. Receive license code
5. Paste into Activation screen → validation → app relaunches
6. License saved to <userData>/license.lic
7. App checks on each startup AND every hour:
   - license.lic present?         → NOT_ACTIVATED if missing
   - Signature valid?             → invalid if tampered
   - machineId matches?           → MACHINE_MISMATCH if different PC
   - Within 7-day grace window?   → valid but gracePeriodDaysLeft set
   - Past grace (8+ days)?        → EXPIRED → Activation screen
8. If valid → extract modules, show appropriate UI
9. If valid + expiry within 14 days → show yellow warning banner
10. If in grace → show "grace period" badge in Settings
11. If invalid → Activation screen until valid license is applied
```
