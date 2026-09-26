# BillNest — Installation Guide

A quick reference for installing BillNest on a Windows laptop/desktop.

---

## 1. What you need

- The installer file: **`BillNest Setup 1.0.0.exe`**
- A Windows 10/11 laptop or desktop (64-bit)
- No internet connection required to run the app day-to-day (it's fully offline/local)
- No admin rights required to install

---

## 2. Copy the installer to the new machine

Use any of these:
- USB flash drive
- Shared network folder
- Cloud upload/download (Google Drive, OneDrive, WhatsApp, email, etc.)

---

## 3. Run the installer

1. Double-click **`BillNest Setup 1.0.0.exe`**.
2. Windows may show a **"Windows protected your PC" (SmartScreen)** warning because
   the app isn't yet signed by a paid trusted certificate authority.
   - Click **More info** → **Run anyway** to proceed. This is expected and safe —
     it happens for any new installer that hasn't built up SmartScreen reputation yet.
3. Choose an install location if prompted (default is fine for most users).
4. Click **Install**, then **Finish**. A desktop shortcut and Start Menu entry
   named **BillNest** will be created.

---

## 4. First-time setup (Setup Wizard)

The very first time you open BillNest, it will walk you through a 2-step wizard:

**Step 1 — Hotel Details**
- Hotel/Restaurant name
- Address
- Phone number
- GSTIN (optional)

> These are all placeholders you can change anytime later from **Settings**.

**Step 2 — Create Owner PIN**
- Set a 4–6 digit PIN for the **Owner** account.
- This PIN has full access to everything, including Settings and staff management.
- Keep this PIN safe — it cannot be recovered without owner access, only reset by
  someone who is already logged in as Owner.

Once both steps are done, you're logged in as Owner and ready to use the app.

---

## 5. Recommended first steps after setup

1. **Settings** → add your UPI ID if you want to accept online/UPI payments
   (this enables a scannable QR code during billing).
2. **Food Management** → review the default categories/menu items, add your own,
   remove ones you don't need, and set prices.
3. **Room Booking** (if you use it) → add your rooms, room types, and rates.
4. **Manage Staff** (Owner only, in Settings) → create PINs for staff members.
   Staff accounts cannot access Settings and cannot cancel bookings — only
   the Owner can.

---

## 6. Where your data lives

All bills, bookings, food items, and settings are stored **locally on that
machine only**, in:

```
%APPDATA%\billnest\
```

- This data is **not shared or synced** between different computers running BillNest.
  Each install is fully independent right now.
- Cross-device sync (so the same hotel's data appears on multiple machines/phones)
  is a planned future upgrade — not available in this version.

**Backup tip:** periodically copy the `%APPDATA%\billnest\` folder somewhere safe
(USB/cloud) in case the laptop is lost, reset, or damaged.

---

## 7. Daily use quick reference

| Task | Where |
|---|---|
| Take a food order & bill it | **Billing** tab → search/select items → Generate Bill |
| Pay via cash | Select **Cash** at billing |
| Pay via UPI/online | Select **Online** → customer scans the QR shown |
| Cancel an order before billing | **Cancel Order** button in cart |
| Cancel a bill after generation | Open bill in **Reporting** → Cancel (Owner only) |
| Check today's/weekly/yearly sales | **Reporting** tab |
| Book a room | **Room Booking** → Bookings tab → New Booking |
| Check a guest in/out | **Room Booking** → Bookings tab |
| View saved bill PDFs/printouts | `Bill Records` folder (opens from app, or via Reporting) |

---

## 8. Uninstalling

Windows Settings → **Apps** → **Installed apps** → search **BillNest** → **Uninstall**.

> Uninstalling does **not** automatically delete your data folder
> (`%APPDATA%\billnest\`) — delete it manually only if you want a completely
> fresh start on reinstall.

---

## 9. Getting help / reporting issues

If something doesn't work as expected, note down:
- What you were doing when it happened
- Any error message shown
- Whether it happens every time or only sometimes

This makes it much faster to diagnose and fix.
