// Android HOST_DEVICE HTTP server — JavaScript bridge layer.
//
// When this tablet is in HOST_DEVICE mode, MobileHostPlugin.java runs a real
// HTTP server on port 4001. Incoming /rpc and /health requests fire a
// "rpcRequest" event here. We resolve them using window.api (webApi.js) and
// call MobileHost.rpcRespond() to send the HTTP response back.
//
// Protocol is identical to electron/lanServer.cjs:
//   GET  /health  → { ok, hotelName, captainEnabled, tableManagementEnabled, version:1 }
//   POST /rpc     → { channel, args } → { ok, result } | { ok:false, error }
//
// This file is only ever imported on Android when mode === 'HOST_DEVICE'.

import { Capacitor } from '@capacitor/core';

const PLUGIN_NAME = 'MobileHost';

function getPlugin() {
  if (typeof Capacitor === 'undefined' || !Capacitor.isNativePlatform()) return null;
  // Capacitor.Plugins is populated after the bridge initialises
  return window.Capacitor?.Plugins?.MobileHost ?? null;
}

// ─── Dispatch table ──────────────────────────────────────────────────────────
// Maps incoming RPC channel names to window.api method calls.
// Mirrors electron/lanServer.cjs's approach of routing by channel name,
// but instead of ipcMain.handle() we call window.api directly (webApi.js).
async function dispatchRpc(channel, args) {
  const api = window.api;
  if (!api) throw new Error('window.api not ready');

  // All window.api methods take positional args matching remoteApi.js.
  // Most take 0–2 args; spread works for all of them.
  const fn = api[channelToMethod(channel)];
  if (!fn) throw new Error(`Unknown channel: ${channel}`);
  return fn(...(Array.isArray(args) ? args : []));
}

// Convert "table:list" → "listTables", "bill:create" → "createBill" etc.
// We use the exact same channel names as Electron, which map to the same
// method names in webApi.js / remoteApi.js.
function channelToMethod(channel) {
  const MAP = {
    'settings:get': 'getSettings',
    'settings:save': 'saveSettings',
    'categories:list': 'listCategories',
    'categories:add': 'addCategory',
    'food:list': 'listFood',
    'food:save': 'saveFood',
    'food:delete': 'deleteFood',
    'food:pickImage': 'pickImage',
    'bill:create': 'createBill',
    'bill:getById': 'getBillById',
    'bill:cancel': 'cancelBill',
    'bill:list': 'listBills',
    'bill:getGroupInvoice': 'getGroupInvoice',
    'table:list': 'listTables',
    'table:save': 'saveTable',
    'table:delete': 'deleteTable',
    'table:updateStatus': 'updateTableStatus',
    'table:assignWaiter': 'assignTableWaiter',
    'table:getOrder': 'getTableOrder',
    'table:saveOrder': 'saveTableOrder',
    'table:clearOrder': 'clearTableOrder',
    'report:summary': 'getSummary',
    'report:trend': 'getSalesTrend',
    'report:profitLoss': 'getProfitLoss',
    'room:list': 'listRooms',
    'room:save': 'saveRoom',
    'room:delete': 'deleteRoom',
    'room:toggleMaintenance': 'toggleRoomMaintenance',
    'room:availability': 'getRoomAvailability',
    'room:calendar': 'getRoomCalendar',
    'booking:create': 'createBooking',
    'booking:addRoomToGroup': 'addRoomToBookingGroup',
    'booking:update': 'updateBooking',
    'booking:checkIn': 'checkInBooking',
    'booking:checkOut': 'checkOutBooking',
    'booking:cancel': 'cancelBooking',
    'booking:cancelGroup': 'cancelGroupBooking',
    'booking:addAddon': 'addBookingAddon',
    'booking:removeAddon': 'removeBookingAddon',
    'booking:list': 'listBookings',
    'booking:getById': 'getBookingById',
    'user:hasOwnerAccount': 'hasOwnerAccount',
    'user:createOwnerAccount': 'createOwnerAccount',
    'user:createStaffAccount': 'createStaffAccount',
    'user:list': 'listUsers',
    'user:deactivate': 'deactivateUser',
    'user:resetPin': 'resetUserPin',
    'user:changePin': 'changeMyPin',
    'user:loginWithPin': 'loginWithPin',
    'user:updateAccess': 'updateUserAccess',
    'inventory:listMaterials': 'listRawMaterials',
    'inventory:saveMaterial': 'saveRawMaterial',
    'inventory:deleteMaterial': 'deleteRawMaterial',
    'inventory:recordPurchase': 'recordPurchase',
    'inventory:purchaseHistory': 'getPurchaseHistory',
    'inventory:purchaseSummary': 'getPurchaseSummary',
    'inventory:purchaseTrend': 'getPurchaseTrend',
    'inventory:recordExpense': 'recordExpense',
    'inventory:expenseHistory': 'getExpenseHistory',
    'inventory:expenseSummary': 'getExpenseSummary',
    'inventory:expenseTrend': 'getExpenseTrend',
    'integrations:listIncoming': 'listIncomingOrders',
    'integrations:accept': 'acceptIncomingOrder',
    'integrations:reject': 'rejectIncomingOrder',
    'integrations:simulateTestOrder': 'simulateTestOrder',
    'whatsapp:getStatus': 'getWhatsAppStatus',
    'whatsapp:connect': 'connectWhatsApp',
    'whatsapp:logout': 'logoutWhatsApp',
    'whatsapp:sendTest': 'sendWhatsAppTest',
    'whatsapp:getSendLog': 'getWhatsAppSendLog',
    'whatsapp:listFestivals': 'listFestivals',
    'whatsapp:saveFestival': 'saveFestival',
    'whatsapp:deleteFestival': 'deleteFestival',
    'whatsapp:share': 'shareViaWhatsApp',
  };
  return MAP[channel] || channel;
}

// ─── Event listener ───────────────────────────────────────────────────────────
let listenerHandle = null;

async function handleRpcRequest(event) {
  const plugin = getPlugin();
  if (!plugin) return;

  const { requestId, type, body } = event;

  if (type === 'health') {
    // Health check — return hotel name + feature flags
    try {
      const settings = await window.api.getSettings();
      const responseBody = JSON.stringify({
        ok: true,
        hotelName: settings?.hotel_name || '',
        captainEnabled: settings?.feature_captain_app === 'true',
        tableManagementEnabled: settings?.feature_table_management === 'true',
        version: 1,
      });
      await plugin.rpcRespond({ requestId, body: responseBody, status: 200 });
    } catch (err) {
      await plugin.rpcRespond({
        requestId,
        body: JSON.stringify({ ok: true, hotelName: '', captainEnabled: false, tableManagementEnabled: false, version: 1 }),
        status: 200,
      });
    }
    return;
  }

  // type === 'rpc'
  try {
    const { channel, args } = JSON.parse(body || '{}');
    const result = await dispatchRpc(channel, args);
    await plugin.rpcRespond({
      requestId,
      body: JSON.stringify({ ok: true, result }),
      status: 200,
    });
  } catch (err) {
    await plugin.rpcRespond({
      requestId,
      body: JSON.stringify({ ok: false, error: (err && err.message) || String(err) }),
      status: 500,
    });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startHostServer(port = 4001, authToken = '') {
  const plugin = getPlugin();
  if (!plugin) {
    console.warn('[hostServer] MobileHost plugin not available — running on non-Android platform?');
    return { ok: false, error: 'Plugin not available' };
  }

  // Register listener for incoming RPC events from Java
  if (!listenerHandle) {
    listenerHandle = await plugin.addListener('rpcRequest', handleRpcRequest);
  }

  const result = await plugin.start({ port, authToken });
  console.log('[hostServer] Started:', result);
  return result;
}

export async function stopHostServer() {
  const plugin = getPlugin();
  if (!plugin) return;

  if (listenerHandle) {
    listenerHandle.remove();
    listenerHandle = null;
  }
  return plugin.stop();
}

export async function getHostServerStatus() {
  const plugin = getPlugin();
  if (!plugin) return { running: false, ip: '', port: 4001 };
  return plugin.isRunning();
}

export async function getDeviceLocalIp() {
  const plugin = getPlugin();
  if (!plugin) return '127.0.0.1';
  const result = await plugin.getLocalIp();
  return result.ip || '127.0.0.1';
}
