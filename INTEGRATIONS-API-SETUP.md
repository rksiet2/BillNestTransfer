# Updating Zomato / Swiggy / MMT Integrations With Real Partner APIs

This is the **reference doc for later** — for when you get official partner
approval from Zomato, Swiggy, and/or MakeMyTrip/Goibibo and receive their
real API documentation. Today, all three adapters talk to placeholder URLs
and always return empty results (or fail silently), so the feature is 100%
safe to ship/use as-is — nothing breaks until you deliberately plug in real
credentials.

## 1. How the feature works today (recap)

- **Settings → "Online Ordering & Channel Integrations"** lets the owner
  enable a platform + save its Partner/Restaurant ID and API Key. Off by
  default; a platform only starts polling once it is **both** enabled *and*
  has both fields filled in.
- Every ~8 seconds (`POLL_INTERVAL_MS` in `pollingService.cjs`), the app
  calls each enabled platform's adapter to ask "any new orders/bookings?"
  This is a **polling** model — BillNest reaches out to the platform, the
  platform never needs to reach into this PC. No public server/webhook/
  domain/SSL certificate is required.
- New orders show up as a badge + dropdown on the topbar bell
  (`IncomingOrdersBell.jsx`) with Accept/Reject buttons.
- **Accept** on a food order creates a real bill (tagged `[PLATFORM] Name` in
  the customer name + order note, `source='FOOD'`). **Accept** on an MMT
  booking auto-picks the first available room and creates a real booking
  (tagged `[MMT] Guest Name`).
- The **"🧪 Simulate Test Order"** button in Settings lets you test this
  entire pipeline (bell → dropdown → accept → bill/booking) right now, with
  fake data, with zero real API access — useful for demoing/training staff
  before you're approved, and for confirming nothing broke after you make
  real-API changes below.

## 2. Files you'll touch once you have real API docs

Everything lives in `electron/integrations/`:

```
electron/integrations/
  pollingService.cjs           <- the engine — do NOT need to change this
  adapters/
    zomatoAdapter.cjs          <- update for real Zomato API
    swiggyAdapter.cjs          <- update for real Swiggy API
    mmtAdapter.cjs              <- update for real MMT/Goibibo API
```

Each adapter is a small, self-contained file exporting exactly 4 things:

```js
module.exports = { platform: 'ZOMATO', fetchNewOrders, acceptOrder, rejectOrder };
```

`pollingService.cjs`, the bell UI, and the Settings UI never talk to Zomato/
Swiggy/MMT directly — they only ever call these 4 functions. So **updating
an adapter to use the real API never requires touching anything outside
that one adapter file.**

## 3. Step-by-step: updating ONE adapter (example: Zomato)

Open `electron/integrations/adapters/zomatoAdapter.cjs`. Every place that
needs a real value is already marked with a `// REPLACE ME` comment. There
are exactly 3 things to change, in 3 functions:

### 3a. `BASE_URL` (top of file)
```js
const BASE_URL = 'https://api.zomato.com/order-manager/v1'; // REPLACE ME
```
Replace with the real base URL from Zomato's Order Manager partner docs
(apply at https://www.zomato.com/business/order-manager once your
restaurant is approved).

### 3b. Authentication header (appears 3 times: in `fetchNewOrders`,
`acceptOrder`, `rejectOrder`)
```js
headers: { Authorization: `Bearer ${apiKey}` }, // REPLACE ME with real auth scheme
```
Zomato's real docs will tell you the exact header name/format — common
patterns are:
- `Authorization: Bearer <token>`
- `Authorization: <token>` (no "Bearer" prefix)
- A custom header, e.g. `X-Zomato-Api-Key: <token>`

`apiKey` here is exactly what the owner typed into the "Zomato API Key"
field in Settings — it's passed in automatically, you just need to put it
in the right header shape.

### 3c. Response field mapping (inside `fetchNewOrders`)
```js
return (data.orders || []).map((o) => ({
  externalId: o.order_id,        // REPLACE the right-hand side field names
  platform: 'ZOMATO',            // leave this as-is
  kind: 'FOOD_ORDER',            // leave this as-is
  customerName: o.customer_name,
  customerPhone: o.customer_phone,
  items: (o.items || []).map((it) => ({ name: it.name, price: it.price, quantity: it.quantity })),
  total: o.total_amount,
  raw: o,                        // leave this as-is (keeps the original payload for debugging)
}));
```
This is the **only normalization step** — take whatever field names Zomato's
real API actually returns (e.g. maybe it's `data.result` instead of
`data.orders`, or `order.id` instead of `order.order_id`) and map them onto
the **left-hand side** property names shown above exactly as they are —
those left-hand names are a fixed contract that `pollingService.cjs` and the
bell UI both depend on. Do not rename `externalId`, `platform`, `kind`,
`items[].name/price/quantity`, or `total` — only change what's on the right
of the `:`.

### 3d. `acceptOrder` / `rejectOrder` — endpoint paths
```js
const res = await fetch(`${BASE_URL}/restaurants/${partnerId}/orders/${externalId}/accept`, { ... });
```
Update the path to match whatever "confirm/accept this order" and
"reject/cancel this order" endpoints Zomato's docs specify. `partnerId` is
exactly what the owner typed into "Zomato Restaurant / Partner ID" in
Settings.

Repeat the same 3 steps for `swiggyAdapter.cjs` (Swiggy partner docs:
https://partner.swiggy.com) and `mmtAdapter.cjs` (MMT/Goibibo Channel
Manager partner docs: https://hotels.makemytrip.com) — the shape is
identical, just swap in each platform's real base URL / auth / field names.
Note `mmtAdapter.cjs` maps to `kind: 'ROOM_BOOKING'` with different fields
(`guestName`, `checkInDate`, `checkOutDate`, `roomType`, etc.) since MMT
sends bookings, not food orders — same left-hand-side rule applies: only
change what's on the right of the `:`.

## 4. How to test your changes after updating an adapter

1. `npm run build` then `npm start` (or `npm run electron:dev` while
   developing) to launch the app with your changes.
2. Go to **Settings → Online Ordering & Channel Integrations**, enable the
   platform you just updated, and paste in **real** Partner ID + API Key
   from your approved partner account.
3. Wait ~8 seconds (or place a real test order on that platform, if their
   sandbox/test mode allows it) and watch the topbar bell for a badge.
4. If nothing shows up, open DevTools (Ctrl+Shift+I in dev mode) and check
   the console/network tab for the actual HTTP response from your adapter's
   `fetch()` calls — most likely cause of silence is a wrong `BASE_URL`,
   wrong auth header shape, or a 4xx/5xx from the real API (all of which are
   swallowed to `[]` by the adapter's `try/catch`, by design, so the poll
   loop never crashes — but this also means you must check the network tab
   directly to debug, rather than relying on a visible error in the UI).
5. The "🧪 Simulate Test Order" button still works even with a real platform
   enabled — use it any time to confirm the accept/reject → bill/booking →
   Reporting pipeline itself is still intact, isolating whether a problem is
   in your adapter's real API call vs. the rest of the app.

## 5. If you ever add a 4th platform (or replace one of these three)

1. Copy an existing adapter file (e.g. `zomatoAdapter.cjs`) as a template —
   it must export `{ platform, fetchNewOrders, acceptOrder, rejectOrder }`
   with the same normalized shapes described in section 3c.
2. Register it in the `ADAPTERS` map near the top of
   `electron/integrations/pollingService.cjs`:
   ```js
   const ADAPTERS = {
     zomato: require('./adapters/zomatoAdapter.cjs'),
     swiggy: require('./adapters/swiggyAdapter.cjs'),
     mmt: require('./adapters/mmtAdapter.cjs'),
     newplatform: require('./adapters/newPlatformAdapter.cjs'), // add this line
   };
   ```
3. Add an entry to the `PLATFORMS` array in
   `src/components/Settings/IntegrationsSection.jsx` (label, ID/key field
   labels, partner-signup help URL) — the toggle/credential-fields UI and
   the "Simulate Test Order" button are generated automatically from this
   array, no other UI code needs to change.
4. If it's a room-booking platform (like MMT), make sure `fetchNewOrders`
   returns `kind: 'ROOM_BOOKING'` with the same fields MMT uses
   (`guestName`, `guestPhone`, `roomType`, `numGuests`, `checkInDate`,
   `checkOutDate`, `total`) — `acceptIncoming()` in `pollingService.cjs`
   already knows how to turn that generic shape into a real booking via
   `roomService.createBooking`, regardless of which platform it came from.

## 6. Nothing else needs to change

Deliberately NOT touched by any of the above: `pollingService.cjs` (the
poll loop, in-memory queue, notification dispatch, accept/reject-to-bill/
booking logic), `IncomingOrdersBell.jsx` (topbar bell UI), `main.cjs`/
`preload.cjs` (IPC wiring), and the `settings` DB table (generic key-value
storage already handles any new platform's credentials with zero schema
changes). This separation is intentional — it's what makes swapping in
real APIs later a small, contained, low-risk change instead of a rewrite.
