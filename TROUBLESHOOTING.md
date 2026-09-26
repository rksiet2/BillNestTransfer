# BillNest — Known Issues & Fixes Log

A running log of real bugs/blockers we've hit during development and exactly
how we fixed them. Check here first whenever something looks familiar —
saves re-diagnosing the same problem twice.

---

## ⚠️ Standing Development Rule — always check mobile too

BillNest ships as **both** the desktop Electron app and a mobile APK (Capacitor),
sharing the same React UI (`src/`) and CSS (`src/index.css`). **Any UI/CSS
change made for desktop must also be checked at phone width before it's
considered done** — desktop-only testing is not enough, since a change that
looks fine at desktop width can silently break/overflow/hide things at
390–480px (this has happened before — see the mobile cart-drawer and Food
Details overflow bugs fixed earlier).

Checklist for every UI change:
1. Test at desktop width (normal dev workflow).
2. Also resize the browser (or use the headless-Edge screenshot method below)
   to **~390px width** (a typical phone) and confirm: nothing overflows
   horizontally, no element is cut off or hidden, buttons/text don't overlap,
   and touch targets stay reasonably sized.
3. If a new interactive element is added (menus, drawers, buttons), verify it
   behaves correctly inside `@media (max-width: 768px)` — check the mobile
   media-query block already in `src/index.css` for the right place to add
   overrides, rather than only styling the desktop layout.
4. Quick way to check without Android Studio: run `npm run dev`, then either
   resize a regular browser window down to ~390px, or use headless Edge:
   ```powershell
   msedge.exe --headless=new --window-size=390,844 --virtual-time-budget=6000 --screenshot="check.png" "http://localhost:5173/"
   ```

---

## 1. `EPERM: operation not permitted, rename ...win-unpacked.tmp -> ...win-unpacked`
**When it happens:** Running `npm run electron:build:win` (electron-builder packaging step).

**Cause:** Windows file lock on the `release\` output folder — usually leftover
`electron.exe` processes (main + renderer + GPU + utility, typically 5-7 PIDs)
from a dev session (`npm run electron:dev`) that wasn't fully closed, or an
orphaned process from a previous crashed build.

**Fix:**
```powershell
# 1. Find any lingering electron processes
Get-Process electron -ErrorAction SilentlyContinue | Select-Object Id, StartTime

# 2. Kill each by specific PID (NEVER by name — Stop-Process -Name / taskkill /IM are disallowed)
Stop-Process -Id <pid> -Force   # repeat for every PID found

# 3. Clear the stale release folder completely
Remove-Item -Recurse -Force release -ErrorAction SilentlyContinue

# 4. Retry the build
npm run electron:build:win
```
**Always stop the dev app (`npm run electron:dev`) before packaging.** If the
build still fails with the same EPERM after killing all electron PIDs, also
check for a lingering Explorer window with the `release` folder open, or an
antivirus scan in progress, and delete `release\` again before retrying.

---

## 2. `node-gyp`/`@electron/rebuild` fails — no working Python found
**When it happens:** Running `npm run electron:build:win` (electron-builder's
default native-module rebuild step for `better-sqlite3`).

**Cause:** This sandboxed dev environment has no functional Python (only a
non-functional Windows Store stub `python.exe` alias). `winget install
Python.Python.3.12` and direct `Invoke-WebRequest` downloads of the Python
installer both hang/fail here (environment restricts large binary downloads).

**Fix:** Add `"npmRebuild": false` to `package.json`'s `"build"` config. This
skips electron-builder's rebuild step entirely. It works here because the
already-installed `better-sqlite3` prebuilt binary
(`node_modules/better-sqlite3/prebuilds/win32-x64.node`) already matches the
packaged Electron version's ABI — confirmed by extensive testing with zero DB
errors.

**Caveat:** This assumes the prebuilt binary's ABI stays compatible with
whatever Electron version is in use. **If you ever upgrade Electron or
better-sqlite3 and the packaged app throws a `NODE_MODULE_VERSION mismatch`
error at runtime on a real machine**, this shortcut needs revisiting — either
fix the Python toolchain properly, or find/build a genuine Electron-targeted
prebuild for the new versions.

---

## 3. Hotel/Room revenue showing ₹0 in Reporting despite bookings existing
**Cause:** `roomService.checkOut()` called `service.createBill()` without
passing `source: 'ROOM'`, so every room-booking bill silently defaulted to
`source: 'FOOD'`. The Hotel filter in Reporting then had nothing to show.

**Fix:** Added `source: 'ROOM'` explicitly to the `createBill()` call inside
`checkOut()` in `db/roomService.cjs`.

**Lesson learned — the general pattern:** Any time a new bill-classifying
column is added (like `source`), it must be kept in sync in **three** places:
1. `database.cjs` `CREATE TABLE` schema
2. `migrateBillsTableColumns()` (so existing DBs get the column added too)
3. **Every** `service.createBill()` caller that should set it explicitly —
   easy to forget on secondary integration points (this was exactly the bug).

The `scripts/regression-test.cjs` suite (`npm run test:regression`) now has a
dedicated test ("Room booking checkout is tagged source=ROOM, not FOOD") that
would catch this exact regression again immediately.

---

## 4. Invoice showing a massively corrupted total (e.g. ₹2,01,62,800 instead of ~₹1,800)
**Cause:** A polluted data row from an old test script — `room_rate` had been
mistyped as `18002500` (a stray/concatenated number-input bug), not a
calculation bug in the billing engine itself.

**Fix:** One-off corrected the bad row's `room_rate` back to `1800` and
recalculated/retagged the bill. The billing math itself (`subtotal = rate ×
nights`, `tax = subtotal × tax%`, `total = subtotal + tax - discount`) was
verified correct via `scripts/regression-test.cjs`.

**Prevention:** Always sanity-check numeric inputs coming from forms
(especially `<input type="number">` fields) aren't accidentally
concatenating digits instead of replacing them.

---

## 5. Reopening the same invoice/KOT a second time shows stale data
**Cause:** Electron sub-windows use `window.location.hash` for routing.
Setting `hash` to a value **identical** to its current value is a DOM no-op —
no `hashchange` event fires, so the window never re-fetches.

**Fix:**
- `navigateWindow()` in `electron/main.cjs` now appends a cache-busting
  suffix: `#/bill/123?_=${Date.now()}`.
- `App.jsx` passes `key={hash}` to `<BillWindow>`/`<KotWindow>` so React
  fully remounts (forcing a fresh fetch) instead of just re-rendering with
  stale state.

**General pattern:** Any hash-routed Electron window that can be asked to
"reopen the same record" needs both halves of this fix — the cache-busting
navigation AND a `key`-forced remount on the consuming component.

---

## 6. Cart items get cropped/cut off when switching Cash ↔ Online payment method
**Cause:** `.cart-panel` itself was the scrollable element (not just the item
list). When the UPI QR box appeared/disappeared (only shown for Online), it
shifted the whole panel's scroll position, cropping item rows out of view.

**Fix:** `.cart-panel` → `overflow: hidden` with `flex-shrink: 0` on all
direct children; only `.cart-items` scrolls (`flex: 1 1 auto !important;
overflow-y: auto`).

---

## 7. UPI QR code doesn't appear even after saving a UPI ID in Settings
**Cause:** `Cart.jsx` fetched `settings` once on mount
(`useEffect(..., [])`) and never refetched. Since Cart usually stays mounted
for the whole session, saving a new UPI ID in the Settings modal never
propagated to the already-mounted Cart component.

**Fix:** Added a `window.dispatchEvent(new CustomEvent('billnest:settings-updated'))`
in `SettingsPage.jsx`'s `handleSave()`, and a matching
`window.addEventListener('billnest:settings-updated', refresh)` in both
`Cart.jsx` and `App.jsx` (topbar hotel name) that refetches settings whenever
that event fires. Any other component that fetches settings once on mount and
needs to stay live should subscribe to this same event.

---

## 8. `png-to-ico` v3 import fails under CommonJS (`require(...)` isn't callable)
**Cause:** The package is ESM-flavored even when required from a `.cjs` file.

**Fix:** Destructure the default export explicitly:
```js
const { default: pngToIco } = require('png-to-ico');
```

---

## 9. PowerShell inline `node -e "..."` scripts fail with quoting/tokenizer errors
**Cause:** Nested double-quotes, SQL string literals, or stray `*` characters
inside a `node -e "..."` one-liner get mangled by PowerShell's own tokenizer
(hit this multiple times — once with SQL literals, once with a wildcard).

**Fix:** Never fight PowerShell quoting for anything non-trivial. Write a
disposable `.cjs` script file instead, run it with `node scripts/foo.cjs`,
then delete it (or keep it if it's a reusable diagnostic/regression tool).

---

## 10. Electron `app.getPath('userData')` folder silently changes after a rebrand
**Cause:** Electron's userData path is derived from `package.json`'s `"name"`
field. Renaming the app (e.g. `hotel-billing-software` → `billnest`) makes
Electron start writing to a brand-new, empty `%APPDATA%\billnest\...` folder
— all data in the old `%APPDATA%\hotel-billing-software\...` folder is left
behind (not deleted, just orphaned/inaccessible from the renamed app).

**Fix / what to know:** This is expected, not a bug — but **always mention
it explicitly** whenever renaming the app's `package.json` `"name"`, so real
production data isn't "lost" by surprise. If migrating old data forward is
ever needed, copy the old `data\hotel_billing.db` file into the new folder
before first launch under the new name.

---

## 11. Windows installer build kept failing EPERM even with zero locking processes (electron-builder's own extraction step)
**When it happens:** `npm run electron:build:win`, failing at the exact same
step every time — extracting/renaming the freshly-downloaded Electron binary
itself into `release\win-unpacked` (not any of our app's own files).

**Cause:** This looked identical to Issue #1 at first, but killing every
`electron.exe`/`BillNest.exe` process and clearing `release\` repeatedly did
**not** fix it — it failed the same way 3+ times in a row. Root cause:
electron-builder's own `extractArchive()` (in
`node_modules/app-builder-lib/out/util/electronGet.js`) does a plain
`fs.rename(tmpDir, dir)` right after extracting Electron's zip, with **no
retry logic**. Windows Defender's real-time scanner transiently holds a
read/scan lock on newly-extracted `.exe`/`.dll` files for a short window —
long enough to make that single `rename()` call fail with `EPERM`, even
though no process we control is holding a lock. No admin rights were
available in this environment to add a Defender exclusion.

**Fix:** Patched `extractArchive()`'s final rename with a retry-with-backoff
loop (8 attempts, 500ms × attempt) that only retries on `EPERM`/`EBUSY`:
```js
let renameAttempt = 0;
while (true) {
  try {
    await fs.rename(tmpDir, dir);
    break;
  } catch (err) {
    renameAttempt++;
    if ((err.code !== 'EPERM' && err.code !== 'EBUSY') || renameAttempt >= 8) throw err;
    await new Promise(r => setTimeout(r, 500 * renameAttempt));
  }
}
```
This lives in `node_modules`, so it **will be wiped out by any future
`npm install`/`npm ci`** — if the EPERM error resurfaces after reinstalling
dependencies, re-apply this same patch (or consider forking/patch-package-ing
`app-builder-lib` so it survives reinstalls).

**Lesson:** If a "file lock" error survives killing every process and
clearing every folder more than twice, stop suspecting our own app/process
and go look at what the *tool* (electron-builder) is doing internally —
antivirus real-time scanning on Windows can transiently lock any freshly
written file, not just ones our own code touches.

---

## 12. Mobile/browser adapter (`src/mobile/webApi.js`) — two bugs found via runtime smoke testing
**When it happens:** Only affects the browser/Capacitor "web adapter" used
for the mobile/demo build (not the desktop Electron+SQLite app, which was
never affected). Found by writing `scripts/webapi-smoke-test.mjs` and
actually running it end-to-end instead of only build-verifying the file.

**Bug A — Reporting always showed ₹0 revenue for Today/Week/Month/Year:**
`nowLocal()` stored bill/user timestamps as a **locale-formatted string**
(`new Date().toLocaleString('en-IN')`, e.g. `"5/9/2026, 4:53:08 pm"`). That
format isn't reliably re-parseable by `new Date(...)` — it silently produced
an Invalid Date, so every period filter (`today`/`week`/`month`/`year`)
excluded every bill.
**Fix:** Store `created_at` as `new Date().toISOString()` instead (always
parseable); the UI's `formatDate()` util already converts ISO to a readable
local string for display, so nothing else needed to change.

**Bug B — Bills would have shown blank Bill No./Date/Payment Method/Customer
in BillWindow, KotWindow, and the Reporting table:**
The mobile adapter's `createBill()` originally returned **camelCase** fields
(`billNumber`, `paymentMethod`, `customerName`, `taxAmount`, `taxPercent`,
`orderNote`, `createdAt`) but the real UI components (`BillWindow.jsx`,
`KotWindow.jsx`, `ReportingPage.jsx`) read the **desktop SQLite schema's
snake_case column names directly** (`bill_number`, `payment_method`,
`customer_name`, `tax_amount`, `tax_percent`, `order_note`, `created_at`) —
those two never matched. (Bookings and Settings were already fine — the
desktop's room-booking service maps DB rows to camelCase before returning
them, and `getSummary()`'s fields were already camelCase on both sides — only
the raw bill object was affected.)
**Fix:** Renamed the affected fields in `webApi.js`'s `createBill`,
`cancelBill`, `listBills`, `getSummary`, and `getSalesTrend` to snake_case to
exactly match what the UI already expects from the desktop build.

**Lesson:** "It builds successfully" only proves there are no syntax/type
errors — it does NOT prove a parallel data-layer implementation returns the
same shape of data the UI expects. Always runtime-test a new adapter/shim
end-to-end (even via a Node script with a localStorage shim, as done here)
before considering it done. `scripts/webapi-smoke-test.mjs` now exists
specifically to re-run this check after any future change to `webApi.js`.

## 13. Android app shows "Could not reach that address" when connecting to a Host (Multi-Terminal Sync / Captain mode)
**When it happens:** The desktop Host's Multi-Terminal Sync is on, both
devices are genuinely on the same WiFi, the IP:port is correct — yet the
phone's "Test Connection"/"Connect & Reload" in Settings > Connect to a
Counter always fails.

**Cause:** `electron/lanServer.cjs` is deliberately plain `http://` (no TLS
— dependency-free, LAN-only by design). Since Android 9 (API 28), the OS
blocks **all** cleartext (`http://`) network traffic by default once
`targetSdkVersion` is 28+ (this app targets 36) — the request never leaves
the device, so `fetch()` throws a generic network error that's
indistinguishable from a genuinely wrong IP/offline host, hence the vague
"Could not reach that address" message.

**Fix:** Added `android:usesCleartextTraffic="true"` to the `<application>`
tag in `android/app/src/main/AndroidManifest.xml`. Safe here because the
whole feature is explicitly LAN-only/opt-in and never talks to the public
internet. Requires a full rebuild of the APK (`npm run build && npx cap sync
android` then re-build in Android Studio) — a plain reinstall of the old
APK won't pick this up.

**If it still fails after rebuilding**, check in this order:
1. Both devices on the **exact same WiFi network** (not a guest/isolated
   SSID — many routers enable "AP/client isolation" on guest networks,
   which silently blocks device-to-device traffic even on the same WiFi).
2. Windows Firewall didn't block the incoming connection — the first time
   the desktop app runs, Windows may prompt to allow it through the
   firewall on Private/Public networks; if that was dismissed/denied, allow
   "BillNest"/"Electron" manually in Windows Defender Firewall settings.
3. The IP shown in Settings > Multi-Terminal Sync (Host) is picked by
   `os.networkInterfaces()` (`lanServer.cjs`'s `getLocalIp()`), which returns
   the **first** non-internal IPv4 adapter — on a machine with multiple
   adapters (Ethernet + WiFi, or a VPN), this can be the wrong one. Compare
   it against `ipconfig`'s actual WiFi adapter IP.
4. Multi-Terminal Sync is toggled on **and** this device's role is actually
   set to "Host" (Settings > Features) — the LAN server never starts
   otherwise, and any `/health` request will simply time out.

---

## How to use this file going forward
- Hit something that looks familiar? Search this file first.
- Fixed a new non-trivial bug? Add a new numbered section here in the same
  format: **When it happens / Cause / Fix / (Lesson or Prevention)**.
- Pair this with `TEST-PLAN.md` (manual UI checklist) and
  `npm run test:regression` (automated business-logic checks) — together
  these three are the full quality safety net for BillNest.
