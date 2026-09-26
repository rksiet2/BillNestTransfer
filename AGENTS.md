# Project Rules

Rules that must be followed whenever making changes to this repo (not just guidance — required steps).

## 1. Always sync the Android (Capacitor) mobile app after UI/web changes

This repo ships **two consumers of the same web app**:

- The Electron desktop app (`electron:dev`, `electron-builder`) — loads straight from `dist/` /
  the Vite dev server, so it always gets the latest code automatically.
- The **Android mobile app** (Capacitor) — has its **own bundled copy** of the built web assets at
  `android/app/src/main/assets/public/`. This copy is a static snapshot; it does **not** update on
  its own and will silently go stale (old header, old styles, old bugs) if forgotten.

**Rule:** any time `src/`, `index.html`, or `public/` assets change (styling, components, branding,
icons, copy, etc.), before considering the work done, run:

```
npm run build
npx cap sync android
```

`npm run build` refreshes `dist/`, and `npx cap sync android` copies `dist/` into the Android
project and updates its native plugins. Skipping this step means the desktop app and browser/dev
view look correct while the mobile app keeps showing the old UI — always do both, every time,
not just when explicitly asked about mobile.

## 2. Kill stray Electron processes before restarting

`npm run electron:dev` runs via `concurrently`; simply stopping the terminal session doesn't
always kill the spawned `electron.exe` child processes. Leftover instances lock the same SQLite
DB/cache files and can cause a blank window on the next launch.

Before starting a fresh `electron:dev` run, check for and kill any leftovers:

```
Get-Process electron -ErrorAction SilentlyContinue
```

Kill each PID individually (`Stop-Process -Id <PID>`), then start exactly one clean instance.

## 3. Vendor-only license tooling never ships with the app

`scripts/license-authority/` (signing key, `.lic` generation, `licenses.db`) and `license-dashboard/`
are internal, vendor-side tools for issuing/tracking customer license keys. They must never be
bundled into the Electron/Android build, committed with real secrets, or exposed on a public
network — the dashboard holds the private signing key.

## 4. Never run `npx cap sync android` while `npm run electron:dev` is running

Vite's dev-server file watcher watches the whole repo by default. `cap sync` overwrites files
under `android/app/src/main/assets/public/` (including binary assets like `app-icon.png`), and on
Windows a mid-write file can be transiently locked (`EBUSY: resource busy or locked`) — if Vite's
watcher touches it at that exact moment, the entire `npm run dev` process crashes and takes the
whole `electron:dev` session down with it.

`vite.config.js` already excludes `android/**` from the watcher (it's a build output, never
hand-edited, and doesn't need watching) — but as a habit, still run `npm run build` +
`npx cap sync android` **before** starting `electron:dev` for the session, not while it's already
running in the background, to avoid any race.

## 5. Tax/GST rate: Cash vs Online, per business (Food vs Room)

Both Food Billing and Room Booking support **separate tax rates for Cash vs Online payments**,
configured in Settings, auto-applied the instant the payment method is chosen, and still
manually overridable per bill/booking:

- Settings keys: `tax_percent_cash` / `tax_percent_online` (Food), `room_tax_percent_cash` /
  `room_tax_percent_online` (Room). The old single `tax_percent` key is kept only as a legacy
  fallback for callers that don't know about the split yet (old scripts, API callers).
- `db/service.cjs`'s `saveSettings()` (and its mobile mirror in `src/mobile/webApi.js`) mirrors
  a caller-supplied `tax_percent` into both `*_cash`/`*_online` keys **unless** the caller also
  sets those keys explicitly in the same call — this keeps any legacy single-rate caller working
  exactly as before. Never remove this mirroring without checking every `saveSettings()` caller
  first.
- `db/service.cjs`'s `createBill()` only auto-picks a rate from Settings (via `autoTaxPercent()`)
  when the caller doesn't pass `taxPercent` explicitly — Cart.jsx and BookingFormModal.jsx always
  resolve and pass one explicitly, so this is a safety net, not the primary path.
- UI pattern (Cart.jsx, BookingFormModal.jsx): keep a `*Touched`/`*Override` flag that starts
  `null`/`false`; an effect (or inline computation) auto-fills the tax rate from Settings based on
  the current payment method whenever that flag says "not manually touched"; selecting the
  tax rate directly, or switching payment method, should update this flag/reset the override so
  the right thing happens automatically **and** stays overridable. Follow this same pattern if a
  third payment method or another billing surface (e.g. checkout modals) needs this feature too.

## 6. Any new `window.api.xyz()` function must be added to ALL FOUR client API surfaces

There are **four separate, independently-maintained implementations** of the `window.api` bridge
that a new IPC channel/feature must be wired into — forgetting even one is a silent bug (a
missing function either no-ops or throws, which can block whatever code runs after it, e.g. it
once broke opening a table entirely because the throw happened before navigation):

1. `electron/preload.cjs` — Electron desktop (standalone or Host), local `ipcRenderer.invoke`.
2. `electron/preload-client.cjs` — Electron desktop configured as a **Client** (second machine on
   LAN), proxies via `fetch()` to the Host's `/rpc`.
3. `src/mobile/remoteApi.js` — mobile/browser configured as a Client, also proxies via `fetch()`.
4. `src/mobile/webApi.js` — standalone mobile/browser with no Host connection, fully independent
   localStorage-backed implementation (needs the actual business logic re-implemented here, not
   just a wrapper).

Any new `ipcMain.handle('channel:name', ...)` added to `electron/main.cjs` is automatically
reachable over LAN via `electron/lanServer.cjs`'s generic `/rpc` dispatcher (it reuses the same
`registeredHandlers` map) — so #1–#3 above are usually one-line wrappers with identical shape;
only #4 needs real logic. **Grep all four files for the sibling function you're adding next to,
add the same wrapper/logic to each, and re-run `npm run test:multidevice`** (see rule 7) before
considering the change done.

## 7. Multi-device / multi-terminal sync scenarios have a permanent regression suite — keep it green

`scripts/multidevice-test.cjs` (run via `npm run test:multidevice`, included in `npm run test:all`)
spins up the real `electron/lanServer.cjs` against a throwaway SQLite DB and fires genuinely
concurrent HTTP requests at it (`Promise.all`, real sockets) to lock in real-world multi-device
behavior that's easy to silently break:

- Table Management feature **OFF** never touches `table_orders`, and counter billing (no table)
  is unaffected either way.
- Multiple concurrent counter bills (no table) never cross-contaminate items and never collide on
  bill number / token, even under real HTTP concurrency.
- Two different tables edited concurrently by two different devices never bleed into each other
  (waiter name, items).
- The table-order persistence feature itself: Device A adds items to a table, Device B opens the
  SAME table later and adds more — must merge into ONE order (e.g. ₹800 + ₹100 = ₹900), never a
  second disconnected entry.
- Billing/clearing a table wipes ITS OWN order only, other tables' in-progress orders untouched.
- 20 simultaneous counter bills stay unique — guards `db/database.cjs`'s `nextBillNumber`/
  `nextToken` read-then-write counter logic against ever gaining an `async`/`await` gap between
  the SELECT and UPDATE (which would silently reintroduce a real race condition, since
  `better-sqlite3` calls are synchronous today and that's WHY concurrent LAN requests can't
  interleave mid-transaction).

**Rule:** any change touching billing (`db/service.cjs` createBill, counters), Table Management
(`table_orders`, waiter assignment, table status), or the LAN sync layer (`lanServer.cjs`,
`main.cjs`'s `registeredHandlers`) must be validated by running `npm run test:multidevice` (or the
full `npm run test:all`) before considering the work done — do not skip it just because
`test:regression`/`test:webapi` passed, since those don't exercise real concurrent LAN requests.

## 8. `CartContext.jsx`'s server-reconcile MUST treat a null `getTableOrder` as "genuinely empty", never as "keep whatever's on screen"

This repo has no React component/hook test harness (all `scripts/*.cjs`/`*.mjs` tests are
plain-Node, backend/service-level only) — so this specific class of bug can't be caught by
`npm run test:all` and must be manually re-checked on any future change to `CartContext.jsx`'s
`selectTable()`:

- `tableDrafts[tableId]` is only an **optimistic, possibly-stale local cache** shown instantly
  while the real answer is fetched from the server via `window.api.getTableOrder(tableId)`.
- If that fetch resolves to `null` (no saved order — e.g. another device already billed/cleared
  this table since the local cache was last written), the code **must** reset `items`/
  `customerName`/`customerPhone` to empty AND drop the stale `tableDrafts[tableId]` entry — never
  just `return` early and leave the optimistic draft on screen. Doing so silently resurrects a
  previous, already-billed guest's items into what looks like a brand-new order.
- Real bug this rule prevents (found and fixed): Device A had a table open as `activeTable`,
  Device B billed and cleared that same table. Device A's `TablesPage` was still polling and
  showed a stale "Currently viewing" badge with the wrong status color, because nothing told
  Device A its local `activeTable`/cart was now stale. Two fixes were required together:
  1. `TablesPage.jsx`'s `load()` polling loop must release (`clearTableDraft` + `selectTable(null,
     { discardOutgoing: true })`) any locally-held `activeTable` the moment a poll shows that
     table's server status is now `EMPTY`/`BILLED` (or the table no longer exists) — this is the
     ONLY place that detects "someone else finished this table while I still had it open".
  2. `CartContext.jsx`'s `selectTable()` async reconcile must not leave stale optimistic
     `tableDrafts` items on screen when the server says there's no order (this rule).



