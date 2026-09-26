// Preload script: securely exposes a limited API to the renderer via contextBridge.
const { contextBridge, ipcRenderer } = require('electron');

// Electron wraps any error thrown inside a main-process ipcMain.handle()
// as "Error invoking remote method 'channel': Error: <actual message>" when
// it reaches the renderer. That boilerplate isn't useful to show a user, so
// every exposed API call below goes through this wrapper, which strips it
// and rethrows a clean Error with just the original message.
async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    const raw = err && err.message ? err.message : String(err);
    const cleaned = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '').trim();
    throw new Error(cleaned || raw);
  }
}

contextBridge.exposeInMainWorld('api', {
  // Settings (hotel name, address, phone, GSTIN, tax %, bill footer, etc.)
  getSettings: () => invoke('settings:get'),
  saveSettings: (partial) => invoke('settings:save', partial),
  getPrinters: () => invoke('printer:list'),
  printSample: (options) => invoke('printer:test', options),

  // Local backup/restore (no cloud service — point the chosen folder at a
  // Google Drive synced folder for free off-device protection).
  chooseBackupFolder: () => invoke('backup:chooseFolder'),
  backupNow: () => invoke('backup:now'),
  openBackupFolder: () => invoke('backup:openFolder'),
  restoreBackup: () => invoke('backup:restore'),

  // Desktop -> Mobile data export (one-way; see db/mobileSyncService.cjs).
  // Returns the saved file path, or null if the save dialog was cancelled.
  exportForMobile: () => invoke('data:exportForMobile'),

  // Categories
  listCategories: () => invoke('categories:list'),
  addCategory: (name) => invoke('categories:add', name),

  // Food items
  listFood: (filters) => invoke('food:list', filters),
  getPopularFood: (limit) => invoke('food:popular', limit),
  saveFood: (item) => invoke('food:save', item),
  deleteFood: (id) => invoke('food:delete', id),
  pickImage: () => invoke('food:pickImage'),

  // Billing
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

  // Restaurant Tables (Table/Area Management — opt-in via Settings > Features)
  listTables: () => invoke('table:list'),
  saveTable: (table) => invoke('table:save', table),
  deleteTable: (id) => invoke('table:delete', id),
  updateTableStatus: (id, status) => invoke('table:updateStatus', id, status),
  assignTableWaiter: (id, waiterName) => invoke('table:assignWaiter', id, waiterName),
  getTableOrder: (id) => invoke('table:getOrder', id),
  saveTableOrder: (id, payload) => invoke('table:saveOrder', id, payload),
  clearTableOrder: (id) => invoke('table:clearOrder', id),

  // Multi-Terminal Sync (opt-in) — role/host-ip/port are per-device local
  // config (see electron/syncConfig.cjs), separate from the shared settings.
  getSyncConfig: () => invoke('sync:getLocalConfig'),
  saveSyncConfig: (partial) => invoke('sync:setLocalConfig', partial),
  getSyncStatus: () => invoke('sync:getStatus'),
  restartSync: () => invoke('sync:restart'),
  relaunchApp: () => invoke('app:relaunch'),

  // KOT (Kitchen Order Ticket)
  openKotWindow: (id) => invoke('kot:openWindow', id),
  openKotRecordsFolder: () => invoke('kot:openRecordsFolder'),
  printKot: (id) => invoke('print:kot', id),

  // Reporting
  getSummary: (payload) => invoke('report:summary', payload),
  getSalesTrend: (payload) => invoke('report:trend', payload),
  getProfitLoss: (payload) => invoke('report:profitLoss', payload),

  // Purchases (spend tracking only — no stock/inventory management)
  listRawMaterials: () => invoke('inventory:listMaterials'),
  saveRawMaterial: (item) => invoke('inventory:saveMaterial', item),
  deleteRawMaterial: (id) => invoke('inventory:deleteMaterial', id),
  recordPurchase: (payload) => invoke('inventory:recordPurchase', payload),
  getPurchaseHistory: (filters) => invoke('inventory:purchaseHistory', filters),
  getPurchaseSummary: (payload) => invoke('inventory:purchaseSummary', payload),
  getPurchaseTrend: (payload) => invoke('inventory:purchaseTrend', payload),

  // Expenses (salary, rent, utilities, etc. — separate from stock Purchases)
  recordExpense: (payload) => invoke('inventory:recordExpense', payload),
  getExpenseHistory: (filters) => invoke('inventory:expenseHistory', filters),
  getExpenseSummary: (payload) => invoke('inventory:expenseSummary', payload),
  getExpenseTrend: (payload) => invoke('inventory:expenseTrend', payload),

  // Room Booking / PMS
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

  // Online Ordering / Channel-Manager integrations (Zomato/Swiggy/MMT) —
  // polling-based, see electron/integrations/pollingService.cjs.
  listIncomingOrders: () => invoke('integrations:listIncoming'),
  acceptIncomingOrder: (externalId) => invoke('integrations:accept', externalId),
  rejectIncomingOrder: (externalId, reason) => invoke('integrations:reject', externalId, reason),
  simulateTestOrder: (platform) => invoke('integrations:simulateTestOrder', platform),
  onIncomingOrder: (callback) => {
    const handler = (event, order) => callback(order);
    ipcRenderer.on('integrations:new-order', handler);
    return () => ipcRenderer.removeListener('integrations:new-order', handler);
  },

  // ---- Users / PIN login ----
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

  // WhatsApp (bill/booking confirmations + festival greetings) — see
  // electron/whatsapp.cjs. Not Meta's paid Business API; links the owner's
  // own WhatsApp account via QR code.
  getWhatsAppStatus: () => invoke('whatsapp:getStatus'),
  configureWhatsAppCloudApi: (accessToken, phoneNumberId) => invoke('whatsapp:configureCloudApi', accessToken, phoneNumberId),
  clearWhatsAppCloudApi: () => invoke('whatsapp:clearCloudApi'),
  connectWhatsApp: () => invoke('whatsapp:connect'),
  logoutWhatsApp: () => invoke('whatsapp:logout'),
  sendWhatsAppTest: (phone) => invoke('whatsapp:sendTest', phone),
  getWhatsAppSendLog: () => invoke('whatsapp:getSendLog'),
  applyWhatsAppWebhook: (payload) => invoke('whatsapp:applyWebhook', payload),
  listFestivals: () => invoke('whatsapp:listFestivals'),
  saveFestival: (festival) => invoke('whatsapp:saveFestival', festival),
  deleteFestival: (id) => invoke('whatsapp:deleteFestival', id),
  shareViaWhatsApp: (text, phoneNumber) => invoke('whatsapp:share', text, phoneNumber),
  onWhatsAppStatusChanged: (callback) => {
    const handler = (event, state) => callback(state);
    ipcRenderer.on('whatsapp:status-changed', handler);
    return () => ipcRenderer.removeListener('whatsapp:status-changed', handler);
  },

  // Offline machine-locked licensing (electron/licensing.cjs) — gates the
  // whole app before anything else loads (see App.jsx).
  getLicenseStatus: () => invoke('license:getStatus'),
  getMachineId: () => invoke('license:getMachineId'),
  activateLicense: (blob) => invoke('license:activate', blob),
  relaunchAfterActivation: () => invoke('app:relaunchAfterActivation'),
});
