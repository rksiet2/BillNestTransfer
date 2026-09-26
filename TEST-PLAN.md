# BillNest — Manual Regression Test Plan

Run this **entire checklist after every change** before rebuilding the installer.
Tick each box (✅ pass / ❌ fail + note) as you go. Takes ~20-25 minutes end to end.

> Tip: Use a throwaway/dev database while testing so you don't pollute real
> sales data. If you ever need a truly fresh start, delete the app's data
> folder (`%APPDATA%\billnest\data`) — this resets everything including PINs.

---

## 1. First-Run Setup & Owner PIN

| # | Steps | Expected Result |
|---|-------|------------------|
| 1.1 | Launch app on a fresh install (no `settings.setup_completed`) | Setup Wizard step 1 (Hotel Details) appears, not the main app |
| 1.2 | Fill hotel name, address, phone, GSTIN, tax % → Save | Moves to step 2 (Create Owner PIN) — only if no Owner exists yet |
| 1.3 | Try a 3-digit PIN | Rejected: "PIN must be 4 to 6 digits" |
| 1.4 | Enter valid PIN, mismatched Confirm PIN | Rejected: "PINs do not match" |
| 1.5 | Enter matching valid 4-6 digit PIN + name → Submit | Setup completes, Login screen appears next |
| 1.6 | Relaunch app | Setup Wizard does **not** reappear (hotel details already saved); goes straight to Login screen |

---

## 2. Login / Role Access (Owner vs Staff)

| # | Steps | Expected Result |
|---|-------|------------------|
| 2.1 | On Login screen, enter wrong PIN | "Incorrect PIN. Please try again," PIN field clears |
| 2.2 | Enter correct Owner PIN | Logs in, topbar shows 👑 + Owner name |
| 2.3 | As Owner, check sidebar (Food module) | See: Billing, Search, Food Management, Inventory, Reporting, **Settings** |
| 2.4 | As Owner, check sidebar (Room module) | See: Availability, Bookings, Rooms, **Settings** |
| 2.5 | Go to Settings → Manage Staff → add a Staff PIN (name + 4-6 digit PIN) | New row appears in staff table, active |
| 2.6 | Click 🔒 (topbar) to log out | Returns to Login screen |
| 2.7 | Log in with the new Staff PIN | Logs in, topbar shows 🧑‍💼 + staff name |
| 2.8 | As Staff, check sidebar (Food module) | See **only**: Billing, Search — no Food Mgmt, Inventory, Reporting, **no Settings button at all** |
| 2.9 | As Staff, check sidebar (Room module) | See **only**: Availability, Bookings — no Rooms setup, no Settings |
| 2.10 | As Staff, open Bookings tab, find an active booking | **No "Cancel" button visible** (Check In / Check Out only) |
| 2.11 | Try navigating to a URL/hash for an owner-only page directly (if possible) | Should not be reachable; if somehow active state stuck on owner page, it auto-bounces to Billing/Availability |
| 2.12 | Log out, log back in as Owner, open same booking | **Cancel button is visible** for Owner |
| 2.13 | Settings → Manage Staff → Reset PIN for the staff user | New PIN required next login; old PIN stops working |
| 2.14 | Settings → Manage Staff → Deactivate the staff user | User can no longer log in with that PIN |
| 2.15 | Try to deactivate the Owner account | Blocked/disabled — cannot deactivate OWNER |

---

## 3. Food Management (Owner only)

| # | Steps | Expected Result |
|---|-------|------------------|
| 3.1 | Add a new category | Appears in category list + in Billing category filter |
| 3.2 | Add a new food item with image, price, category | Appears in Billing menu grid under correct category, image renders |
| 3.3 | Edit an existing item's price | Price updates immediately in Billing menu |
| 3.4 | Delete/deactivate a food item | No longer selectable in Billing |
| 3.5 | Search an item by name in Food Management | Filters correctly |

---

## 4. Billing (Food) — Cart & Payment

| # | Steps | Expected Result |
|---|-------|------------------|
| 4.1 | Open Billing, filter menu by category | Only that category's items show |
| 4.2 | Use search bar for a food item | Shows matching items with image + qty +/- stepper |
| 4.3 | Click + on an item with 0 qty in cart | Adds to cart, qty becomes 1 |
| 4.4 | Click + / - repeatedly | Quantity updates live, cart total recalculates correctly |
| 4.5 | Reduce quantity to 0 via - | Item removed from cart |
| 4.6 | Try "Generate Bill" with an empty cart | Blocked: "Please add at least 1 item to generate a bill." |
| 4.7 | Add 2-3 items, switch payment method Cash → Online → Cash repeatedly | **All cart item rows stay fully visible** — no cropping/scroll glitch (regression check for the earlier cropping bug) |
| 4.8 | Settings → set a UPI ID (e.g. `name@bank`) → Save → go back to Billing, switch to Online | **QR code appears immediately**, no app restart needed (regression check for the UPI live-refresh bug) |
| 4.9 | Without any UPI ID set, switch to Online | Shows "No UPI ID set up yet..." message, no broken QR |
| 4.10 | Add items, choose Cash, click "Generate Bill" | Bill opens in a **new window**; token shown with correct prefix (e.g. `B01`) |
| 4.11 | Add items, choose Online, generate bill | Token prefix should differ appropriately if your token scheme distinguishes cash/online (verify current spec), UPI section shows on printed bill if UPI id set |
| 4.12 | Open the "Bill Records" folder (Settings button) | The just-generated bill's file exists there |
| 4.13 | Generate a KOT ("Generate + Print KOT") | KOT opens in new window; saved in "KOT Records" folder |
| 4.14 | Use "Generate + Print Both" | Opens/prints both Bill and KOT correctly |
| 4.15 | Start an order, then click Cancel/Order Cancellation | Confirms before cancelling; cart clears; **cancelled order does NOT appear in revenue totals** (see Reporting section) |
| 4.16 | Re-open the same bill's invoice a second time from history | Shows correct **current** data, not stale/cached content (regression check for the stale-window bug) |

---

## 5. Search

| # | Steps | Expected Result |
|---|-------|------------------|
| 5.1 | Search partial item name | Matches show with image + qty stepper, same as Billing |
| 5.2 | Add from Search results directly to cart | Reflects correctly in Billing/Cart |
| 5.3 | Search a non-existent item | Empty state shown, no crash |

---

## 6. Room Booking

### 6.1 Availability Tab
| # | Steps | Expected Result |
|---|-------|------------------|
| 6.1.1 | Open Availability tab | Layout is clean — no overlapping date fields (regression check) |
| 6.1.2 | Try to pick a "From" date in the past | Blocked — date picker `min` prevents backdating |
| 6.1.3 | Try to pick a "To" date before "From" | Blocked/auto-corrected, cannot be backdated relative to From |
| 6.1.4 | Pick a valid future date range | Shows correct room availability for that range |

### 6.2 Rooms Tab (Owner only)
| # | Steps | Expected Result |
|---|-------|------------------|
| 6.2.1 | Open Rooms tab | Table header shows: Room, Type, Default Rate, Max Occ., Status, **Actions** (regression check — Actions header must be labeled) |
| 6.2.2 | Add a new room | Appears in table, available in booking form |
| 6.2.3 | Edit a room's rate | Updates and reflects in new bookings |

### 6.3 Bookings Tab
| # | Steps | Expected Result |
|---|-------|------------------|
| 6.3.1 | Create a new booking, pick a room, date range, guest info | Booking created with status BOOKED |
| 6.3.2 | Check-in the booking | Status → CHECKED_IN |
| 6.3.3 | Check-out the booking | Status → CHECKED_OUT; a bill is auto-generated |
| 6.3.4 | Open the generated invoice | **Total must be correct** — e.g. ₹1,800/night × nights + correct tax, NOT a corrupted/inflated number (regression check for the ₹2 crore bug) |
| 6.3.5 | Confirm invoice shows correct hotel name/address from Settings | Matches current settings, not placeholder |
| 6.3.6 | As Owner, cancel a BOOKED/CHECKED_IN booking | Confirms, cancels, excluded from revenue |
| 6.3.7 | As Staff, attempt same | No Cancel button available at all |

---

## 7. Reporting (Owner only)

| # | Steps | Expected Result |
|---|-------|------------------|
| 7.1 | Open Reporting, default view | Shows some sales summary/totals |
| 7.2 | Switch Food / Hotel / Both filter tabs | Numbers change appropriately — **Food revenue and Hotel/Room revenue must be correctly separated**, neither should show ₹0 if bills exist for that source (regression check for the source-misclassification bug) |
| 7.3 | Check "Both" total | Should equal Food total + Hotel total exactly |
| 7.4 | Switch to Weekly view | Shows correct week-bounded totals |
| 7.5 | Switch to Annual/monthly view | Shows correct period totals |
| 7.6 | Open Sales History list | Shows all bills with correct Source column (FOOD/ROOM), date, amount |
| 7.7 | Confirm a cancelled order does **not** appear in revenue sums | Cancelled orders excluded from all total calculations, but still visible/traceable in history if applicable |
| 7.8 | Click "View" on a past bill in Sales History | Opens correct invoice matching that record |
| 7.9 | Verify Subtotal + Tax = Total on a few random bills | Math must reconcile exactly (no floating point drift, correct tax %) |
| 7.10 | Verify a Discount (if applied) reduces total correctly | Subtotal - Discount + Tax(on discounted amount, per your business rule) = Total |

---

## 8. Settings

| # | Steps | Expected Result |
|---|-------|------------------|
| 8.1 | Change hotel name/address/GSTIN/phone → Save | "Settings saved" toast appears |
| 8.2 | Go back to Billing/Cart or Bill window | New hotel details reflected immediately without app restart (regression check) |
| 8.3 | Change tax % | New bills use updated tax %, old bills keep their original recorded tax |
| 8.4 | Set/change UPI ID | Cart's Online QR updates live (see 4.8) |
| 8.5 | Open "Bill Records" / "KOT Records" folder buttons | Correct folders open in File Explorer |

---

## 9. Cross-cutting / Regression Sanity

| # | Steps | Expected Result |
|---|-------|------------------|
| 9.1 | Open every nav screen (Food + Room modules) as Owner | Zero console errors (check DevTools) |
| 9.2 | Open every allowed screen as Staff | Zero console errors |
| 9.3 | Resize window small (tablet-width) | Responsive layout holds, no broken overlap |
| 9.4 | Topbar clock | Displays steadily, no layout jitter/shifting as seconds tick (regression check) |
| 9.5 | Close and reopen the app | All data persisted correctly (bills, bookings, settings, users) |

---

## 10. Packaging (only before shipping a new installer)

| # | Steps | Expected Result |
|---|-------|------------------|
| 10.1 | `npm run build` | Builds clean, no errors |
| 10.2 | `npm run electron:build:win` | Produces `release\BillNest Setup <version>.exe` without needing Python/node-gyp |
| 10.3 | Install the fresh `.exe` on a clean/test path | Installs without asking for any extra prerequisite |
| 10.4 | Launch installed app | Goes through Setup Wizard → Owner PIN → Login exactly like dev mode |
| 10.5 | Verify installed app icon + window icon show the BillNest logo | Correct in taskbar, title bar, and desktop shortcut |

---

### Known/accepted follow-ups (not bugs, just open items)
- ~12,300 old demo/seed bills may still exist in a dev DB from earlier testing — purge before real production use if needed.
- Mobile (Android APK) / iOS / cloud-sync are future roadmap items, not yet built.
