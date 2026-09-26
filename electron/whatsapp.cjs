// WhatsApp integration — sends food-bill / room-booking / room-checkout
// confirmations and festival greetings via the *personal/business* WhatsApp
// account the owner links here (scan a QR code, same as WhatsApp Web), using
// the open-source Baileys library. This is NOT Meta's paid official
// Business API — it's free and has no per-message cost or volume cap, but
// carries some risk of the linked number being rate-limited/banned by
// WhatsApp if used for high-volume bulk sends. See the throttled festival
// broadcast below, which deliberately paces sends rather than firing them
// all at once.
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const {
  makeWASocket,
  useMultiFileAuthState: initAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { getDb } = require('../db/database.cjs');
const service = require('../db/service.cjs');
const cloud = require('./whatsappCloud.cjs');

let sock = null;
let sessionDir = null;
let status = 'DISCONNECTED'; // DISCONNECTED | CONNECTING | QR_READY | CONNECTED
let lastQrDataUrl = null;
let connectedNumber = null;
let onStatusChange = () => {};
let festivalTimer = null;
// Consecutive-failure backoff: a real network/TLS block (proxy, firewall,
// blocked outbound WhatsApp endpoint) fails instantly every single retry —
// without this, the old code hammered the network in a tight infinite loop
// and the UI just showed "Connecting…" forever with no useful signal.
let reconnectAttempts = 0;
let reconnectTimer = null;
let lastError = null;
const MAX_AUTO_RECONNECT_ATTEMPTS = 5;

function setStatus(next) {
  status = next;
  onStatusChange({ status, qr: lastQrDataUrl, number: connectedNumber, error: lastError });
}

function setOnStatusChange(fn) {
  onStatusChange = fn || (() => {});
}

function getStatus() {
  const settings = service.getSettings();
  if (settings.whatsapp_provider === 'CLOUD_API') {
    const config = cloud.configuration();
    return {
      status: cloud.isConfigured() ? 'CONNECTED' : 'DISCONNECTED',
      provider: 'CLOUD_API',
      number: config.phoneNumberId || null,
      configured: cloud.isConfigured(),
      error: cloud.isConfigured() ? null : 'Configure the Cloud API credentials in Settings before sending.',
    };
  }
  return { status, qr: lastQrDataUrl, number: connectedNumber, error: lastError };
}

// Converts any of "9876543210", "+91 98765 43210", "919876543210" into the
// bare digit string Baileys expects, assuming an Indian 10-digit number gets
// the country code prefixed if it's missing (BillNest's primary market).
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function cloudMessageOptions(settings) {
  return settings?.whatsapp_cloud_template_name
    ? {
      templateName: settings.whatsapp_cloud_template_name,
      templateLanguage: settings.whatsapp_cloud_template_language || 'en_US',
    }
    : {};
}

async function connect(userDataPath, isManualRetry = false) {
  if (service.getSettings().whatsapp_provider === 'CLOUD_API') return getStatus();
  if (status === 'CONNECTING' || status === 'CONNECTED') return getStatus();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (isManualRetry) reconnectAttempts = 0; // user clicked Connect again — give it a fresh run of attempts
  sessionDir = path.join(userDataPath, 'whatsapp-session');
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  lastError = null;
  setStatus('CONNECTING');
  const { state, saveCreds } = await initAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      lastQrDataUrl = await qrcode.toDataURL(qr);
      setStatus('QR_READY');
    }
    if (connection === 'open') {
      connectedNumber = sock.user?.id ? sock.user.id.split(':')[0] : null;
      lastQrDataUrl = null;
      reconnectAttempts = 0;
      setStatus('CONNECTED');
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      connectedNumber = null;
      if (loggedOut) {
        // Explicit logout from the phone itself — clear the session so the
        // next "Connect" starts a fresh QR pairing instead of looping.
        reconnectAttempts = 0;
        setStatus('DISCONNECTED');
        clearSession();
        return;
      }
      reconnectAttempts += 1;
      if (reconnectAttempts > MAX_AUTO_RECONNECT_ATTEMPTS) {
        // A real network/TLS block (proxy, firewall) fails every retry
        // instantly — retrying forever just spins the UI on "Connecting…"
        // with no useful signal. Stop and surface a clear error instead;
        // the user can hit "Connect" again once the network is fixed.
        const reason = lastDisconnect?.error?.message || 'Could not reach WhatsApp servers.';
        lastError = `Connection failed after several attempts (${reason}). Check your internet connection / firewall, then click Connect again.`;
        setStatus('DISCONNECTED');
        return;
      }
      // Any other drop (network blip, app restart) — Baileys' own
      // multi-file auth state can resume the same session automatically,
      // so just reconnect rather than forcing a re-scan every time.
      // Exponential backoff (3s, 6s, 12s, 24s, 30s cap) so a persistent
      // failure doesn't hammer the network in a tight loop.
      setStatus('DISCONNECTED');
      const delayMs = Math.min(30000, 3000 * 2 ** (reconnectAttempts - 1));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect(userDataPath).catch(() => {});
      }, delayMs);
    }
  });

  return getStatus();
}

function clearSession() {
  if (sessionDir && fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

async function logout() {
  if (service.getSettings().whatsapp_provider === 'CLOUD_API') return getStatus();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    if (sock) await sock.logout();
  } catch { /* already disconnected */ }
  clearSession();
  sock = null;
  connectedNumber = null;
  lastQrDataUrl = null;
  reconnectAttempts = 0;
  lastError = null;
  setStatus('DISCONNECTED');
}

// Every real outbound send funnels through here so success/failure is always
// logged consistently (see Settings > Integrations > WhatsApp send history).
async function sendMessage(rawPhone, text, type = 'TEST', cloudOptions = {}) {
  const phone = normalizePhone(rawPhone);
  const log = (logStatus, error, response) => {
    try {
      getDb().prepare('INSERT INTO whatsapp_log (phone, type, status, message_id, recipient_id, error, status_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(rawPhone || '', type, logStatus, response?.messages?.[0]?.id || null, response?.contacts?.[0]?.wa_id || null, error || null, response ? new Date().toISOString() : null);
    } catch { /* logging must never block the actual send */ }
  };
  if (!phone) { log('FAILED', 'No phone number provided.'); throw new Error('No phone number provided.'); }
  const settings = service.getSettings();
  if (settings.whatsapp_provider === 'CLOUD_API') {
    if (!cloud.isConfigured()) { log('FAILED', 'WhatsApp Cloud API is not configured.'); throw new Error('WhatsApp Cloud API is not configured.'); }
    try { const response = await cloud.sendText(rawPhone, text, cloudOptions); log('SENT', null, response); return true; } catch (err) { log('FAILED', err.message); throw err; }
  }
  if (status !== 'CONNECTED' || !sock) { log('FAILED', 'WhatsApp is not connected.'); throw new Error('WhatsApp is not connected.'); }
  try {
    await sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
    log('SENT');
    return true;
  } catch (err) {
    log('FAILED', err.message);
    throw err;
  }
}

// Sends the actual bill/receipt as an image (a screenshot of the same
// on-screen receipt used for print/preview — see main.cjs's
// captureBillImage) with a short caption, instead of a fully typed-out text
// message. Logged the same way as sendMessage so Settings > WhatsApp > Send
// History shows one consistent trail regardless of which path was used.
async function sendImageMessage(rawPhone, imageBuffer, caption, type = 'TEST') {
  const phone = normalizePhone(rawPhone);
  const log = (logStatus, error, response) => {
    try {
      getDb().prepare('INSERT INTO whatsapp_log (phone, type, status, message_id, recipient_id, error, status_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(rawPhone || '', type, logStatus, response?.messages?.[0]?.id || null, response?.contacts?.[0]?.wa_id || null, error || null, response ? new Date().toISOString() : null);
    } catch { /* logging must never block the actual send */ }
  };
  if (!phone) { log('FAILED', 'No phone number provided.'); throw new Error('No phone number provided.'); }
  if (status !== 'CONNECTED' || !sock) { log('FAILED', 'WhatsApp is not connected.'); throw new Error('WhatsApp is not connected.'); }
  try {
    await sock.sendMessage(`${phone}@s.whatsapp.net`, { image: imageBuffer, caption });
    log('SENT');
    return true;
  } catch (err) {
    log('FAILED', err.message);
    throw err;
  }
}

async function sendPdfMessage(rawPhone, pdfBuffer, fileName, caption, type = 'TEST') {
  const phone = normalizePhone(rawPhone);
  const log = (logStatus, error, response) => {
    try {
      getDb().prepare('INSERT INTO whatsapp_log (phone, type, status, message_id, recipient_id, error, status_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(rawPhone || '', type, logStatus, response?.messages?.[0]?.id || null, response?.contacts?.[0]?.wa_id || null, error || null, response ? new Date().toISOString() : null);
    } catch { /* logging must never block the actual send */ }
  };
  if (!phone) { log('FAILED', 'No phone number provided.'); throw new Error('No phone number provided.'); }
  const settings = service.getSettings();
  if (settings.whatsapp_provider === 'CLOUD_API') {
    if (!cloud.isConfigured()) { log('FAILED', 'WhatsApp Cloud API is not configured.'); throw new Error('WhatsApp Cloud API is not configured.'); }
    try { const response = await cloud.sendPdf(rawPhone, pdfBuffer, fileName, caption); log('SENT', null, response); return true; } catch (err) { log('FAILED', err.message); throw err; }
  }
  if (status !== 'CONNECTED' || !sock) { log('FAILED', 'WhatsApp is not connected.'); throw new Error('WhatsApp is not connected.'); }
  try {
    await sock.sendMessage(`${phone}@s.whatsapp.net`, {
      document: pdfBuffer,
      mimetype: 'application/pdf',
      fileName: fileName || 'Invoice.pdf',
      caption,
    });
    log('SENT');
    return true;
  } catch (err) {
    log('FAILED', err.message);
    throw err;
  }
}

function fillTemplate(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => (vars[key] != null ? vars[key] : ''));
}

function fillRoomTemplate(template, booking, settings, bill = booking) {
  const guestName = booking.guestName || booking.guest_name || 'Guest';
  const bookingNumber = booking.bookingNumber || booking.booking_number || '';
  const roomNumber = booking.roomNumber || booking.room_number || '';
  const roomType = booking.roomType || booking.room_type || '';
  const formatDate = (value) => {
    const raw = String(value || '');
    if (!raw) return '';
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? raw : date.toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  };
  const nights = Math.max(1, Math.round(
    (new Date(String(booking.checkOutDate || booking.check_out_date).slice(0, 10))
      - new Date(String(booking.checkInDate || booking.check_in_date).slice(0, 10))) / 86400000
  ));
  const addonTotal = (booking.addons || []).reduce((sum, addon) => (
    sum + Number(addon.total ?? (Number(addon.price || 0) * Number(addon.quantity || 1)))
  ), 0);
  const subtotal = Number(booking.roomRate || booking.room_rate || 0) * nights
    + Number(booking.touristTax || booking.tourist_tax || 0) + addonTotal
    - Number(booking.discount || 0);
  const calculatedTotal = subtotal + (subtotal * Number(booking.taxPercent || booking.tax_percent || 0) / 100);
  return fillTemplate(template, {
    guest_name: guestName,
    hotel_name: settings.room_biz_name || settings.hotel_name || 'our hotel',
    booking_number: bookingNumber,
    check_in: formatDate(booking.checkInDate || booking.check_in_date),
    check_out: formatDate(booking.checkOutDate || booking.check_out_date),
    room: roomType ? `${roomNumber} (${roomType})` : roomNumber,
    total: bill.total != null ? `₹${bill.total}` : `₹${calculatedTotal.toFixed(2)}`,
    advance: bill.advancePayment != null ? `₹${bill.advancePayment}` : (bill.advance_payment != null ? `₹${bill.advance_payment}` : `₹${Number(booking.advancePayment || booking.advance_payment || 0).toFixed(2)}`),
    hotel_phone: settings.room_biz_phone || settings.hotel_phone || '',
    hotel_address: settings.room_biz_address || settings.hotel_address || '',
  });
}

// ---------------- Trigger-point senders (called from main.cjs IPC handlers) ----------------
async function sendBillMessage(bill, imageBuffer) {
  if (!bill.customer_phone && !bill.customerPhone) return false;
  const phone = bill.customer_phone || bill.customerPhone;
  const settings = service.getSettings();
  if (imageBuffer) {
    // The image itself already shows every line item/total — keep the
    // caption short instead of repeating the whole itemized breakdown.
    const caption = [
      `Thank you for visiting ${settings.hotel_name || 'us'}!`,
      `Bill No: ${bill.bill_number || bill.billNumber} | Total: ₹${bill.total}`,
      settings.bill_footer || 'Visit again!',
    ].join('\n');
    // Logged distinctly from a plain-text 'BILL' send (see the fallback
    // below) so Settings > WhatsApp > Send History shows whether the
    // customer actually got the real invoice image or just a typed summary.
    await sendImageMessage(phone, imageBuffer, caption, 'BILL_IMAGE');
    service.markBillWhatsAppSent(bill.id);
    return true;
  }
  const lines = [
    `Thank you for visiting ${settings.hotel_name || 'us'}!`,
    '',
    `Bill No: ${bill.bill_number || bill.billNumber}`,
    `Token: ${bill.token}`,
    ...(bill.items || []).map((it) => `${it.name} x${it.quantity} - ₹${it.total}`),
    '',
    `Total: ₹${bill.total}`,
    '',
    settings.bill_footer || 'Visit again!',
  ];
  await sendMessage(phone, lines.join('\n'), 'BILL');
  service.markBillWhatsAppSent(bill.id);
  return true;
}

async function sendBookingMessage(booking) {
  if (!booking.guestPhone && !booking.guest_phone) return false;
  const phone = booking.guestPhone || booking.guest_phone;
  const settings = service.getSettings();
  // Confirmation reflects the reservation dates, not any later operational
  // timestamps that may be present when a booking is re-sent.
  const scheduledBooking = {
    ...booking,
    checkInDate: booking.checkInDate || booking.check_in_date,
    checkOutDate: booking.checkOutDate || booking.check_out_date,
  };
  await sendMessage(phone, fillRoomTemplate(settings.whatsapp_room_booking_template, scheduledBooking, settings), 'BOOKING', cloudMessageOptions(settings));
  return true;
}

async function sendCheckinMessage(booking) {
  if (!booking.guestPhone && !booking.guest_phone) return false;
  const phone = booking.guestPhone || booking.guest_phone;
  const settings = service.getSettings();
  // Check-in confirmation uses the timestamp recorded when staff marked the
  // guest in, while retaining the booked check-out date.
  const checkedInBooking = {
    ...booking,
    checkInDate: booking.actualCheckIn || booking.actual_check_in || booking.checkInDate || booking.check_in_date,
    checkOutDate: booking.checkOutDate || booking.check_out_date,
  };
  await sendMessage(phone, fillRoomTemplate(settings.whatsapp_room_checkin_template, checkedInBooking, settings), 'CHECKIN', cloudMessageOptions(settings));
  return true;
}

async function sendCheckoutMessage(booking, bill, pdfBuffer) {
  if (!booking.guestPhone && !booking.guest_phone) return false;
  const phone = booking.guestPhone || booking.guest_phone;
  const settings = service.getSettings();
  // The final message must describe the actual stay recorded at checkout,
  // rather than the originally scheduled interval.
  const completedBooking = {
    ...booking,
    checkInDate: booking.actualCheckIn || booking.actual_check_in || booking.checkInDate || booking.check_in_date,
    checkOutDate: booking.actualCheckOut || booking.actual_check_out || booking.checkOutDate || booking.check_out_date,
  };
  const reviewLink = settings.whatsapp_room_review_link || '';
  const reviewRequest = settings.whatsapp_checkout_review_request === 'true' && reviewLink
    ? `\n\n⭐ Enjoyed your stay? Please rate us here:\n${reviewLink}`
    : '';
  if (pdfBuffer) {
    const caption = fillRoomTemplate(settings.whatsapp_room_checkout_template, { ...completedBooking, ...bill }, settings) + reviewRequest;
    await sendPdfMessage(
      phone,
      pdfBuffer,
      `Invoice-${bill.billNumber || bill.bill_number || bill.id}.pdf`,
      caption,
      'CHECKOUT_PDF'
    );
    return true;
  }
  await sendMessage(phone, fillRoomTemplate(settings.whatsapp_room_checkout_template, { ...completedBooking, ...bill }, settings) + reviewRequest, 'CHECKOUT', cloudMessageOptions(settings));
  return true;
}

// ---------------- Festival greetings (throttled broadcast) ----------------
// Deliberately sends one message every few seconds instead of all at once —
// firing a burst of identical messages in a few milliseconds is exactly the
// bulk-automation pattern WhatsApp's anti-spam systems are tuned to catch.
async function runFestivalCheckOnce() {
  if (status !== 'CONNECTED') return;
  const db = getDb();
  const today = new Date();
  const monthDay = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const year = today.getFullYear();
  const due = db.prepare(
    'SELECT * FROM festival_greetings WHERE enabled = 1 AND month_day = ? AND (last_sent_year IS NULL OR last_sent_year != ?)'
  ).all(monthDay, year);
  if (due.length === 0) return;

  const settings = service.getSettings();
  const phones = service.getAllCustomerPhones();
  for (const festival of due) {
    const message = fillTemplate(festival.message_template, { hotel_name: settings.hotel_name || 'us' });
    for (const phone of phones) {
      try {
        await sendMessage(phone, message, 'GREETING');
      } catch { /* individual failures already logged in whatsapp_log; keep going */ }
      await new Promise((r) => setTimeout(r, 4000)); // ~4s pacing between sends
    }
    db.prepare('UPDATE festival_greetings SET last_sent_year = ? WHERE id = ?').run(year, festival.id);
  }
}

function startFestivalScheduler() {
  if (festivalTimer) return;
  runFestivalCheckOnce().catch(() => {});
  festivalTimer = setInterval(() => { runFestivalCheckOnce().catch(() => {}); }, 60 * 60 * 1000); // hourly
}

function stopFestivalScheduler() {
  if (festivalTimer) { clearInterval(festivalTimer); festivalTimer = null; }
}

function applyCloudWebhook(payload) {
  const statuses = cloud.parseWebhookStatuses(payload);
  const update = getDb().prepare(
    'UPDATE whatsapp_log SET status = ?, recipient_id = COALESCE(?, recipient_id), error = COALESCE(?, error), status_updated_at = COALESCE(?, status_updated_at) WHERE message_id = ?'
  );
  const transaction = getDb().transaction((items) => {
    for (const item of items) update.run(item.status, item.recipientId, item.error, item.timestamp, item.messageId);
  });
  transaction(statuses);
  return { updated: statuses.length, statuses };
}

function getCloudApiStatus() {
  return cloud.getStatus();
}

function configureCloudApi(accessToken, phoneNumberId) {
  return cloud.configure(accessToken, phoneNumberId);
}

function clearCloudApi() {
  return cloud.clearCredentials();
}

module.exports = {
  connect,
  logout,
  getStatus,
  setOnStatusChange,
  sendMessage,
  sendImageMessage,
  sendPdfMessage,
  sendBillMessage,
  sendBookingMessage,
  sendCheckinMessage,
  sendCheckoutMessage,
  startFestivalScheduler,
  stopFestivalScheduler,
  runFestivalCheckOnce,
  applyCloudWebhook,
  getCloudApiStatus,
  configureCloudApi,
  clearCloudApi,
};
