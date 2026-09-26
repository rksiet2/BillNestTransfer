// Polling engine for third-party order/booking integrations (Zomato, Swiggy,
// MMT/Goibibo). Runs inside the Electron main process (has full Node network
// access + timers), polling each ENABLED platform's adapter every few
// seconds for new orders/bookings, and surfacing them to the renderer via
// IPC + a native OS notification — mirroring how most restaurant/hotel POS
// partner integrations work (the POS pulls, rather than the platform pushing
// to a public server the POS doesn't have).
//
// Nothing here talks to a real API yet — see the adapters' "REPLACE ME"
// comments. Until real credentials + endpoints exist, every poll will just
// quietly return zero results, so this is safe to leave running.

const { Notification } = require('electron');
const service = require('../../db/service.cjs');
const { APP_NAME } = require('../brand.cjs');

const POLL_INTERVAL_MS = 8000; // ~8s — adjust once real API rate limits are known

const ADAPTERS = {
  zomato: require('./adapters/zomatoAdapter.cjs'),
  swiggy: require('./adapters/swiggyAdapter.cjs'),
  mmt: require('./adapters/mmtAdapter.cjs'),
};

// In-memory queue of incoming orders/bookings awaiting Accept/Reject.
// Intentionally not persisted to the DB until accepted — a rejected/expired
// one should never show up in billing/reporting history.
let incomingQueue = [];
let pollTimer = null;
let onNewOrderCallback = null;

function setOnNewOrder(cb) {
  onNewOrderCallback = cb;
}

function getCredentials(settings, key) {
  return {
    apiKey: settings[`${key}_api_key`] || '',
    partnerId: settings[`${key}_partner_id`] || '',
  };
}

function isEnabled(settings, key) {
  return settings[`${key}_enabled`] === 'true';
}

async function pollOnce() {
  const settings = service.getSettings();
  for (const [key, adapter] of Object.entries(ADAPTERS)) {
    if (!isEnabled(settings, key)) continue;
    const creds = getCredentials(settings, key);
    if (!creds.apiKey || !creds.partnerId) continue; // toggle on but not configured yet — skip quietly
    let found = [];
    try {
      found = await adapter.fetchNewOrders(creds);
    } catch {
      found = [];
    }
    for (const order of found) {
      if (incomingQueue.some((q) => q.externalId === order.externalId && q.platform === order.platform)) continue;
      incomingQueue.push({ ...order, receivedAt: new Date().toISOString() });
      notifyNewOrder(order);
    }
  }
}

function notifyNewOrder(order) {
  const label = order.kind === 'ROOM_BOOKING'
    ? `🏨 New ${order.platform} Booking — ${order.guestName || 'Guest'} (${order.checkInDate} → ${order.checkOutDate})`
    : `🔔 New ${order.platform} Order — ${(order.items || []).length} item(s), ₹${order.total}`;
  try {
    new Notification({ title: `${APP_NAME} — Incoming Order`, body: label }).show();
  } catch {
    // Notifications can be unavailable in some environments (e.g. certain
    // Linux setups without a notification daemon) — don't crash the poller.
  }
  if (onNewOrderCallback) onNewOrderCallback(order);
}

function start() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { pollOnce().catch(() => {}); }, POLL_INTERVAL_MS);
  pollOnce().catch(() => {}); // also run one immediately on start
}

// Triggers an immediate check outside the normal interval — used right after
// Settings are saved so a freshly-enabled/configured platform doesn't wait
// up to POLL_INTERVAL_MS for its first check.
function pollNow() {
  pollOnce().catch(() => {});
}

function stop() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function listIncoming() {
  return incomingQueue;
}

// Adds a fake order to the queue for end-to-end testing without real API
// access — lets you verify notification → accept → bill/booking creation →
// reporting all work correctly before official partner approval comes through.
function simulateTestOrder(platform = 'ZOMATO') {
  const key = platform.toLowerCase();
  const adapter = ADAPTERS[key];
  if (!adapter) throw new Error(`Unknown platform: ${platform}`);
  const id = `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const order = adapter.platform === 'MMT'
    ? {
        externalId: id,
        platform: adapter.platform,
        kind: 'ROOM_BOOKING',
        guestName: 'Test Guest',
        guestPhone: '9999999999',
        roomType: 'Deluxe',
        numGuests: 2,
        checkInDate: new Date().toISOString().slice(0, 10),
        checkOutDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        total: 2500,
        raw: { simulated: true },
      }
    : {
        externalId: id,
        platform: adapter.platform,
        kind: 'FOOD_ORDER',
        customerName: 'Test Customer',
        customerPhone: '9999999999',
        items: [{ name: 'Paneer Butter Masala', price: 220, quantity: 2 }, { name: 'Butter Naan', price: 40, quantity: 4 }],
        total: 600,
        raw: { simulated: true },
      };
  incomingQueue.push({ ...order, receivedAt: new Date().toISOString() });
  notifyNewOrder(order);
  return order;
}

// Accepting creates the real bill (food orders) or room booking (MMT),
// tagging it clearly with the originating platform so it's identifiable in
// Reporting/history, without requiring any Reporting schema/UI changes:
// food orders are tagged source='FOOD' (they ARE food revenue) with the
// platform + external order id recorded in the order note; MMT bookings
// auto-assign the first available matching room and tag the guest name.
async function acceptIncoming(externalId) {
  const idx = incomingQueue.findIndex((q) => q.externalId === externalId);
  if (idx === -1) throw new Error('Order not found or already handled.');
  const order = incomingQueue[idx];
  const settings = service.getSettings();
  const key = order.platform.toLowerCase();
  const adapter = ADAPTERS[key];
  const creds = getCredentials(settings, key);

  let result;
  if (order.kind === 'ROOM_BOOKING') {
    const roomService = require('../../db/roomService.cjs');
    const available = roomService
      .getRoomAvailability({ from: order.checkInDate, to: order.checkOutDate })
      .filter((r) => r.isAvailable);
    if (available.length === 0) {
      throw new Error(`No available room for ${order.checkInDate} → ${order.checkOutDate}. Accept manually once you free up a room, or reject this booking.`);
    }
    const room = available[0];
    result = roomService.createBooking({
      roomId: room.id,
      guestName: `[${order.platform}] ${order.guestName || 'Guest'}`,
      guestPhone: order.guestPhone,
      numGuests: order.numGuests || 1,
      checkInDate: order.checkInDate,
      checkOutDate: order.checkOutDate,
      roomRate: order.total,
      notes: `Auto-created from ${order.platform} booking #${order.externalId}`,
    });
  } else {
    result = service.createBill({
      items: order.items,
      paymentMethod: 'ONLINE',
      customerName: `[${order.platform}] ${order.customerName || 'Customer'}`,
      source: 'FOOD',
      orderNote: `${order.platform} order #${order.externalId}`,
    });
  }

  // Best-effort: tell the platform we accepted (won't succeed against a
  // placeholder URL yet, but is a no-op failure — the local bill/booking is
  // already created either way, which is what matters for your business).
  if (adapter && creds.apiKey) {
    adapter.acceptOrder(creds, externalId).catch(() => {});
  }

  incomingQueue.splice(idx, 1);
  return result;
}

async function rejectIncoming(externalId, reason) {
  const idx = incomingQueue.findIndex((q) => q.externalId === externalId);
  if (idx === -1) throw new Error('Order not found or already handled.');
  const order = incomingQueue[idx];
  const settings = service.getSettings();
  const key = order.platform.toLowerCase();
  const adapter = ADAPTERS[key];
  const creds = getCredentials(settings, key);
  if (adapter && creds.apiKey) {
    adapter.rejectOrder(creds, externalId, reason).catch(() => {});
  }
  incomingQueue.splice(idx, 1);
  return true;
}

module.exports = { start, stop, pollNow, listIncoming, acceptIncoming, rejectIncoming, simulateTestOrder, setOnNewOrder };
