// Remote API implementation for mobile/web devices in "Connect to Host"
// mode (see remoteConfig.js). Talks to a desktop Host's LAN sync server
// (electron/lanServer.cjs) over plain fetch(), using the exact same
// `{channel, args}` RPC protocol as electron/preload-client.cjs — this
// mobile client and a desktop Client counter are peers of the same Host,
// so a waiter's phone and a second billing counter both see one truly
// live, shared set of tables/orders/menu instead of separate local copies.

// How long a single request to the Host is allowed to hang before we give
// up and report a clear "timed out" error, instead of a spinner that never
// resolves (the biggest source of "it's just stuck" support questions).
const REQUEST_TIMEOUT_MS = 6000;

// Accepts whatever a user might type/paste into the "Host address" field —
// a bare IP ("192.168.1.5"), an IP with a port baked in ("192.168.1.5:4001"),
// or (rarely) a hostname — and safely splits it into `{ hostIp, hostPort }`,
// falling back to `defaultPort` when no port is present. Never throws; a
// clearly-invalid input is returned as-is in `hostIp` so the caller's own
// connection attempt (and its error handling) is what surfaces the problem,
// rather than this parser guessing wrong and hiding a typo.
export function parseHostAddress(input, defaultPort = '4001') {
  const raw = (input || '').trim();
  if (!raw) return { hostIp: '', hostPort: String(defaultPort) };
  // IPv6 literals ("[::1]:4001") are out of scope for a LAN-sync counter
  // address — every device this feature targets (phones, desktop Wi-Fi/
  // Ethernet NICs) uses IPv4. Guard against splitting an IPv6 address's own
  // colons by only treating a SINGLE trailing ":<digits>" as a port.
  const match = raw.match(/^(.*):(\d{1,5})$/);
  if (match) {
    return { hostIp: match[1].trim(), hostPort: match[2] };
  }
  return { hostIp: raw, hostPort: String(defaultPort) };
}

function isValidPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

// Turns a raw fetch()/timeout failure into one clear, actionable sentence
// instead of a generic "Failed to fetch" — this is what a Captain/Waiter or
// Owner actually needs to know to fix the connection themselves without
// calling support.
export function describeNetworkError(err, hostIp, hostPort) {
  if (!hostIp) return 'Enter the counter\u2019s IP address first.';
  if (!isValidPort(hostPort)) return `"${hostPort}" isn\u2019t a valid port number (must be 1\u201365535).`;
  if (err && err.name === 'AbortError') {
    return `Timed out reaching ${hostIp}:${hostPort}. Make sure both devices are on the same WiFi and the counter app is open.`;
  }
  if (err && err.isHttpError) {
    if (err.status === 401) {
      return `The Host at ${hostIp}:${hostPort} rejected this device's shared access key (HTTP 401). Open Settings → Counter Mode and enter the current key from the Host.`;
    }
    return `The counter at ${hostIp}:${hostPort} responded with an error (HTTP ${err.status}). Try again, or check the counter app.`;
  }
  // A plain fetch() network failure (host unreachable, connection refused,
  // DNS failure, wrong port) always surfaces as a generic TypeError in
  // browsers/WebViews — there's no finer-grained reason available to us.
  return `Could not reach ${hostIp}:${hostPort}. Check WiFi, the IP/port, and that the counter app is open.`;
}

function buildInvoke(hostIp, hostPort, authToken) {
  const baseUrl = `http://${hostIp}:${hostPort}`;
  return async function invoke(channel, ...args) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${baseUrl}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BillNest-Token': authToken || '' },
        body: JSON.stringify({ channel, args }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(describeNetworkError(err, hostIp, hostPort));
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const httpErr = new Error();
      httpErr.isHttpError = true;
      httpErr.status = res.status;
      httpErr.authFailed = res.status === 401;
      throw new Error(describeNetworkError(httpErr, hostIp, hostPort));
    }
    const data = await res.json().catch(() => ({ ok: false, error: 'Invalid response from Host.' }));
    if (!data.ok) throw new Error(data.error || 'Request to Host failed.');
    return data.result;
  };
}

export async function testHostConnection(hostIp, hostPort, authToken) {
  if (!isValidPort(hostPort)) throw new Error(describeNetworkError(null, hostIp, hostPort));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`http://${hostIp}:${hostPort}/health`, {
      method: 'GET', headers: { 'X-BillNest-Token': authToken || '' }, signal: controller.signal,
    });
  } catch (err) {
    throw new Error(describeNetworkError(err, hostIp, hostPort));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const httpErr = new Error();
    httpErr.isHttpError = true;
    httpErr.status = res.status;
    throw new Error(describeNetworkError(httpErr, hostIp, hostPort));
  }
  return res.json();
}


// Mirrors webApi.js's navigateTo/printBill/printKot exactly — the phone's
// in-app hash-routed bill/KOT views are rendered locally regardless of
// where the underlying data came from.
function navigateAndMaybePrint(hashRoute, shouldPrint) {
  if (typeof window !== 'undefined' && window.location) {
    window.location.hash = `${hashRoute}?_=${Date.now()}`;
  }
  if (!shouldPrint) return Promise.resolve(true);
  return new Promise((resolve) => {
    setTimeout(() => {
      if (typeof window !== 'undefined' && window.print) window.print();
      resolve(true);
    }, 400);
  });
}

export function createRemoteApi({ hostIp, hostPort, authToken }) {
  const invoke = buildInvoke(hostIp, hostPort || '4001', authToken);
  return {
    getSettings: () => invoke('settings:get'),
    saveSettings: (partial) => invoke('settings:save', partial),

    chooseBackupFolder: () => invoke('backup:chooseFolder'),
    backupNow: () => invoke('backup:now'),
    openBackupFolder: () => invoke('backup:openFolder'),
    restoreBackup: () => invoke('backup:restore'),

    exportForMobile: () => invoke('data:exportForMobile'),

    listCategories: () => invoke('categories:list'),
    addCategory: (name) => invoke('categories:add', name),

    listFood: (filters) => invoke('food:list', filters),
    getPopularFood: (limit) => invoke('food:popular', limit),
    saveFood: (item) => invoke('food:save', item),
    deleteFood: (id) => invoke('food:delete', id),
    pickImage: () => invoke('food:pickImage'),

    createBill: (payload) => invoke('bill:create', payload),
    getBillById: (id) => invoke('bill:getById', id),
    cancelBill: (id, reason) => invoke('bill:cancel', id, reason),
    listBills: (filters) => invoke('bill:list', filters),
    openRecordsFolder: () => invoke('bill:openRecordsFolder'),
    // Bill/KOT data lives on the Host, but "opening"/"printing" is still a
    // local, in-app hash-route + browser print() action on THIS phone —
    // exactly like the standalone mobile webApi.js — never the Host's own
    // native print:bill/print:kot IPC channels (those print on the HOST's
    // physical printer, which isn't what a phone tapping "print" wants).
    openBillWindow: (id) => navigateAndMaybePrint(`#/bill/${id}`, false),
    printBill: (id) => navigateAndMaybePrint(`#/bill/${id}`, true),
    getGroupInvoice: (groupId) => invoke('bill:getGroupInvoice', groupId),
    openGroupBillWindow: (groupId) => navigateAndMaybePrint(`#/bill-group/${groupId}`, false),

    listTables: () => invoke('table:list'),
    saveTable: (table) => invoke('table:save', table),
    deleteTable: (id) => invoke('table:delete', id),
    updateTableStatus: (id, status) => invoke('table:updateStatus', id, status),
    assignTableWaiter: (id, waiterName) => invoke('table:assignWaiter', id, waiterName),
    getTableOrder: (id) => invoke('table:getOrder', id),
    saveTableOrder: (id, payload) => invoke('table:saveOrder', id, payload),
    clearTableOrder: (id) => invoke('table:clearOrder', id),

    // This device is already a CLIENT (it's using remoteApi). Sync config/status
    // are not applicable — it has no server of its own and doesn't manage role.
    getSyncConfig: async () => ({ role: 'CLIENT', hostIp: hostIp || '', port: hostPort || '4001' }),
    saveSyncConfig: async () => ({ role: 'CLIENT', hostIp: hostIp || '', port: hostPort || '4001' }),
    getSyncStatus: async () => ({ running: false, ip: '', port: 4001, supported: false }),
    restartSync: async () => ({ running: false, ip: '', supported: false }),

    openKotWindow: (id) => navigateAndMaybePrint(`#/kot/${id}`, false),
    openKotRecordsFolder: () => invoke('kot:openRecordsFolder'),
    printKot: (id) => navigateAndMaybePrint(`#/kot/${id}`, true),

    getSummary: (payload) => invoke('report:summary', payload),
    getSalesTrend: (payload) => invoke('report:trend', payload),
    getProfitLoss: (payload) => invoke('report:profitLoss', payload),

    listRawMaterials: () => invoke('inventory:listMaterials'),
    saveRawMaterial: (item) => invoke('inventory:saveMaterial', item),
    deleteRawMaterial: (id) => invoke('inventory:deleteMaterial', id),
    recordPurchase: (payload) => invoke('inventory:recordPurchase', payload),
    getPurchaseHistory: (filters) => invoke('inventory:purchaseHistory', filters),
    getPurchaseSummary: (payload) => invoke('inventory:purchaseSummary', payload),
    getPurchaseTrend: (payload) => invoke('inventory:purchaseTrend', payload),

    recordExpense: (payload) => invoke('inventory:recordExpense', payload),
    getExpenseHistory: (filters) => invoke('inventory:expenseHistory', filters),
    getExpenseSummary: (payload) => invoke('inventory:expenseSummary', payload),
    getExpenseTrend: (payload) => invoke('inventory:expenseTrend', payload),

    listRooms: () => invoke('room:list'),
    saveRoom: (room) => invoke('room:save', room),
    deleteRoom: (id) => invoke('room:delete', id),
    toggleRoomMaintenance: (id, underMaintenance) => invoke('room:toggleMaintenance', { id, underMaintenance }),
    getRoomAvailability: (payload) => invoke('room:availability', payload),
    getRoomCalendar: (payload) => invoke('room:calendar', payload),
    pickIdDocument: () => invoke('room:pickIdDocument'),
    openIdDocument: (filePath) => invoke('room:openIdDocument', filePath),

    createBooking: (payload) => invoke('booking:create', payload),
    addRoomToBookingGroup: (groupId, room) => invoke('booking:addRoomToGroup', { groupId, room }),
    updateBooking: (id, payload) => invoke('booking:update', { id, payload }),
    checkInBooking: (id) => invoke('booking:checkIn', id),
    checkOutBooking: (id, paymentMethod) => invoke('booking:checkOut', { id, paymentMethod }),
    cancelBooking: (id, reason, refund, refundMethod) => invoke('booking:cancel', { id, reason, refund, refundMethod }),
    cancelGroupBooking: (groupId, reason, refund, refundMethod) => invoke('booking:cancelGroup', { groupId, reason, refund, refundMethod }),
    addBookingAddon: (bookingId, addon) => invoke('booking:addAddon', { bookingId, addon }),
    removeBookingAddon: (addonId) => invoke('booking:removeAddon', addonId),
    listBookings: (filters) => invoke('booking:list', filters),
    getBookingById: (id) => invoke('booking:getById', id),

    listIncomingOrders: () => invoke('integrations:listIncoming'),
    acceptIncomingOrder: (externalId) => invoke('integrations:accept', externalId),
    rejectIncomingOrder: (externalId, reason) => invoke('integrations:reject', externalId, reason),
    simulateTestOrder: (platform) => invoke('integrations:simulateTestOrder', platform),
    // Live push (new Zomato/Swiggy order) relies on an Electron IPC event
    // from the Host's own polling service, which a plain fetch()-based
    // phone client has no equivalent pipe for yet — a no-op for now; the
    // order still appears next time listIncomingOrders is polled/refreshed.
    onIncomingOrder: () => () => {},

    getWhatsAppStatus: () => invoke('whatsapp:getStatus'),
    connectWhatsApp: () => invoke('whatsapp:connect'),
    logoutWhatsApp: () => invoke('whatsapp:logout'),
    sendWhatsAppTest: (phone) => invoke('whatsapp:sendTest', phone),
    getWhatsAppSendLog: () => invoke('whatsapp:getSendLog'),
    listFestivals: () => invoke('whatsapp:listFestivals'),
    saveFestival: (festival) => invoke('whatsapp:saveFestival', festival),
    deleteFestival: (id) => invoke('whatsapp:deleteFestival', id),
    shareViaWhatsApp: (text, phoneNumber) => invoke('whatsapp:share', text, phoneNumber),

    hasOwnerAccount: () => invoke('user:hasOwnerAccount'),
    createOwnerAccount: (payload) => invoke('user:createOwnerAccount', payload),
    createStaffAccount: (payload) => invoke('user:createStaffAccount', payload),
    listUsers: () => invoke('user:list'),
    deactivateUser: (id) => invoke('user:deactivate', id),
    resetUserPin: (id, newPin) => invoke('user:resetPin', { id, newPin }),
    changeMyPin: (id, currentPin, newPin) => invoke('user:changePin', { id, currentPin, newPin }),
    requestPinResetOtp: () => invoke('user:requestPinResetOtp'),
    verifyPinResetOtp: (otp, newPin) => invoke('user:verifyPinResetOtp', { otp, newPin }),
    updateUserAccess: (id, access) => invoke('user:updateAccess', { id, access }),
    loginWithPin: (pin) => invoke('user:loginWithPin', pin),
    // This phone is a companion terminal of an already-licensed Host (same
    // reasoning as the desktop Client role) — never separately gated.
    getLicenseStatus: async () => ({ valid: true }),
  };
}
