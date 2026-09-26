// Preload script for a "Client" device in Multi-Terminal Sync mode. Exposes
// the EXACT same window.api surface as preload.cjs, so every existing React
// component works completely unchanged — the only difference is *how*
// `invoke()` reaches the business logic: instead of Electron's local IPC
// (ipcRenderer.invoke), every call is sent as JSON over HTTP to the Host
// device's tiny /rpc server (see electron/lanServer.cjs), which runs the
// identical handler function the Host's own local UI would have run.
//
// The Host's IP/port are not read from this device's own (mostly-empty)
// local database — they're passed in once at BrowserWindow creation via
// `webPreferences.additionalArguments` (see main.cjs), so they're available
// here in `process.argv` before any renderer code has even started.
const { contextBridge, ipcRenderer } = require('electron');

function readArg(prefix) {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

const hostIp = readArg('--sync-host-ip=');
const hostPort = readArg('--sync-port=') || '4001';
const authToken = readArg('--sync-token=');
const baseUrl = `http://${hostIp}:${hostPort}`;
const REQUEST_TIMEOUT_MS = 6000;

async function invoke(channel, ...args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BillNest-Token': authToken },
      body: JSON.stringify({ channel, args }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Timed out reaching the Host counter (${hostIp}:${hostPort}). Check that both devices are on the same WiFi and the Host app is open.`);
    }
    throw new Error(`Could not reach the Host counter (${hostIp}:${hostPort}). Check the WiFi connection and that the Host app is open.`);
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({ ok: false, error: 'Invalid response from Host.' }));
  if (!data.ok) throw new Error(data.error || 'Request to Host failed.');
  return data.result;
}

contextBridge.exposeInMainWorld('api', {
  getSettings: () => invoke('settings:get'),
  saveSettings: (partial) => invoke('settings:save', partial),
  getPrinters: () => invoke('printer:list'),
  printSample: () => Promise.reject(new Error('Test printing is available on the desktop host only.')),

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
  openBillWindow: (id) => invoke('bill:openWindow', id),
  getGroupInvoice: (groupId) => invoke('bill:getGroupInvoice', groupId),
  openGroupBillWindow: (groupId) => invoke('bill:openGroupWindow', groupId),
  printBill: (id) => invoke('print:bill', id),
  downloadBillImage: (id) => invoke('bill:downloadImage', id),
  downloadBillPdf: (id) => invoke('bill:downloadPdf', id),
  downloadGroupBillPdf: (groupId) => invoke('bill:downloadGroupPdf', groupId),

  listTables: () => invoke('table:list'),
  saveTable: (table) => invoke('table:save', table),
  deleteTable: (id) => invoke('table:delete', id),
  updateTableStatus: (id, status) => invoke('table:updateStatus', id, status),
  assignTableWaiter: (id, waiterName) => invoke('table:assignWaiter', id, waiterName),
  getTableOrder: (id) => invoke('table:getOrder', id),
  saveTableOrder: (id, payload) => invoke('table:saveOrder', id, payload),
  clearTableOrder: (id) => invoke('table:clearOrder', id),

  // A Client never runs its own LAN server. Role/host-ip/port config is
  // ALWAYS local to this device — routed straight to this device's own main
  // process via ipcRenderer (NOT the fetch()-based invoke() above), so
  // Settings on a Client device correctly edits its own role, never the
  // Host's settings.
  getSyncConfig: () => ipcRenderer.invoke('sync:getLocalConfig'),
  saveSyncConfig: (partial) => ipcRenderer.invoke('sync:setLocalConfig', partial),
  getSyncStatus: () => ipcRenderer.invoke('sync:getStatus'),
  restartSync: () => ipcRenderer.invoke('sync:restart'),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),

  openKotWindow: (id) => invoke('kot:openWindow', id),
  openKotRecordsFolder: () => invoke('kot:openRecordsFolder'),
  printKot: (id) => invoke('print:kot', id),

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
  // Live push notifications (new Zomato/Swiggy order) rely on Electron IPC
  // events from the Host's own polling service — a Client has no direct
  // pipe for that yet, so it's a no-op here for now. Client screens that use
  // this (the topbar bell) simply won't get the instant push; the order
  // still shows up next time `listIncomingOrders` is polled/refreshed.
  onIncomingOrder: () => () => {},

  getWhatsAppStatus: () => invoke('whatsapp:getStatus'),
  configureWhatsAppCloudApi: () => Promise.reject(new Error('Configure Cloud API on the Host device.')),
  clearWhatsAppCloudApi: () => Promise.reject(new Error('Manage Cloud API credentials on the Host device.')),
  connectWhatsApp: () => invoke('whatsapp:connect'),
  logoutWhatsApp: () => invoke('whatsapp:logout'),
  sendWhatsAppTest: (phone) => invoke('whatsapp:sendTest', phone),
  getWhatsAppSendLog: () => invoke('whatsapp:getSendLog'),
  applyWhatsAppWebhook: (payload) => invoke('whatsapp:applyWebhook', payload),
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

  // Licensing is always local to THIS device (a Client is auto-exempt in its
  // own main.cjs), never forwarded to the Host over HTTP — same reasoning as
  // the sync-config calls above.
  getLicenseStatus: () => ipcRenderer.invoke('license:getStatus'),
  getMachineId: () => ipcRenderer.invoke('license:getMachineId'),
  activateLicense: (blob) => ipcRenderer.invoke('license:activate', blob),
  relaunchAfterActivation: () => ipcRenderer.invoke('app:relaunchAfterActivation'),
});
