// Electron main process.
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { APP_NAME } = require('./brand.cjs');

// The standalone "BillNest Reset" desktop shortcut launches this very same
// .exe with a --factory-reset flag (see build/installer.nsh) — branch into
// its own tiny, independent window/IPC flow immediately and skip every bit
// of the normal app's setup below (registering the full IPC surface, LAN
// server, auto-backup timer etc. would be pointless overhead for a tool
// whose only job is to wipe data and quit).
if (process.argv.includes('--factory-reset')) {
  require('./factoryReset.cjs').run();
  return;
}

const { initDatabase, getBillRecordsDir, getKotRecordsDir, getDb } = require('../db/database.cjs');
const service = require('../db/service.cjs');
const roomService = require('../db/roomService.cjs');
const userService = require('../db/userService.cjs');
const backupService = require('../db/backupService.cjs');
const mobileSyncService = require('../db/mobileSyncService.cjs');
const fs = require('fs');
const { exec } = require('child_process');
const integrations = require('./integrations/pollingService.cjs');
const { startLanServer, stopLanServer, isLanServerRunning, getLocalIp, getLastStartError } = require('./lanServer.cjs');
const syncConfig = require('./syncConfig.cjs');
const appLock = require('./appLock.cjs');
const whatsapp = require('./whatsapp.cjs');
const licensing = require('./licensing.cjs');

// Every ipcMain.handle(channel, fn) call anywhere below also gets captured
// here, keyed by channel name. This lets the Multi-Terminal Sync LAN server
// (see lanServer.cjs) re-use the exact same handler functions over HTTP for
// other devices on the network, instead of duplicating every single one as
// a separate REST endpoint — any new IPC channel added later is automatically
// available to Client devices with zero extra wiring.
const registeredHandlers = {};
const realHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  registeredHandlers[channel] = handler;
  return realHandle(channel, handler);
};

const isDev = !app.isPackaged;
let mainWindow;

// In dev mode, Vite picks the first available port starting at 5173. If 5173
// is already in use (e.g. a prior session left a zombie), it increments until
// it finds a free one. We probe ports 5173–5185 at startup and latch onto
// whichever one responds, so all loadURL() calls use the real live port.
if (isDev) {
  const http = require('http');
  const PROBE_PORTS = [5173,5174,5175,5176,5177,5178,5179,5180,5181,5182,5183,5184,5185];
  const probe = (port) => new Promise((res) => {
    const req = http.get({ host: 'localhost', port, path: '/', timeout: 600 }, () => res(port));
    req.on('error', () => res(null));
    req.on('timeout', () => { req.destroy(); res(null); });
  });
  // Run all probes in parallel and pick the first that answers. This runs
  // synchronously-ish before createWindow() because app.whenReady resolves
  // after this module-level code runs — but since it's async we set the global
  // before createWindow() is called inside whenReady().
  global.VITE_PORT_READY = Promise.all(PROBE_PORTS.map(probe)).then((results) => {
    const found = results.find((p) => p !== null);
    global.VITE_PORT = found || 5173;
    return global.VITE_PORT;
  });
}

// `build/*.ico` isn't part of `files`/asar (electron-builder's `build`
// directory is normally build-time-only, used just to embed the app's own
// exe icon) — shipped separately via `extraResources` instead (see
// package.json build.extraResources) specifically so this path resolves at
// runtime in a packaged app too, not only in dev where `build/` sits on disk
// right next to `electron/`.
function getIconPath(fileName) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'build', fileName)
    : path.join(__dirname, '../build', fileName);
}

// Bill/KOT windows are expensive to spin up from scratch (new renderer process +
// full bundle load), which is what was making "Generate Bill" feel slow. Instead we
// keep one hidden, pre-loaded window of each kind alive and just flip its hash route
// (the app already listens for `hashchange`), which re-renders instantly with no reload.
let billWindow = null;
let kotWindow = null;
let currentBillId = null;
let currentKotId = null;

function getPreloadConfig() {
  // On a Client device, the whole app (main window, bill window, KOT window)
  // needs to talk to the Host over HTTP instead of the local DB — so every
  // window it opens uses preload-client.cjs instead of preload.cjs. A plain
  // standalone install (role === '' or 'HOST') is completely unaffected and
  // keeps using the normal local preload.cjs, unchanged. Role/host-ip live in
  // the local-only syncConfig file (see syncConfig.cjs for why).
  const cfg = syncConfig.getConfig();
  if (cfg.role === 'CLIENT' && cfg.hostIp) {
    return {
      preload: path.join(__dirname, 'preload-client.cjs'),
      additionalArguments: [
        `--sync-host-ip=${cfg.hostIp}`,
        `--sync-port=${cfg.port || '4001'}`,
        `--sync-token=${cfg.authToken || ''}`,
      ],
    };
  }
  return { preload: path.join(__dirname, 'preload.cjs'), additionalArguments: [] };
}

function createMainWindow() {
  const { preload, additionalArguments } = getPreloadConfig();
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0f172a',
    icon: getIconPath('icon.ico'),
    webPreferences: {
      preload,
      additionalArguments,
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.setMenuBarVisibility(false);
  // Bill/KOT windows hide instead of destroying themselves (for instant reuse), so they
  // won't count toward window-all-closed. Force quit explicitly when the main window closes.
  mainWindow.on('closed', () => {
    if (billWindow && !billWindow.isDestroyed()) billWindow.destroy();
    if (kotWindow && !kotWindow.isDestroyed()) kotWindow.destroy();
    app.quit();
  });

  if (isDev) {
    mainWindow.loadURL(`http://localhost:${global.VITE_PORT || 5173}`);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

function navigateWindow(win, hashRoute) {
  return new Promise((resolve) => {
    const go = () => {
      // Append a cache-busting suffix so the hash value is always unique per
      // navigation (even when re-opening the exact same bill/KOT id). Combined
      // with `key={hash}` on <BillWindow>/<KotWindow> in App.jsx, this forces a
      // full remount + re-fetch every time, instead of silently reusing stale,
      // previously-fetched data when the target id hasn't changed.
      const uniqueHash = `${hashRoute}?_=${Date.now()}`;
      win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(uniqueHash)}`).catch(() => {});
      resolve();
    };
    if (win.webContents.isLoadingMainFrame()) {
      win.webContents.once('did-finish-load', go);
    } else {
      go();
    }
  });
}

function ensureBillWindow() {
  if (billWindow && !billWindow.isDestroyed()) return billWindow;
  const { preload, additionalArguments } = getPreloadConfig();
  billWindow = new BrowserWindow({
    width: 480,
    height: 720,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload,
      additionalArguments,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  billWindow.setMenuBarVisibility(false);
  // Hide (don't destroy) on close so the already-loaded bundle can be reused instantly
  // the next time a bill is generated, instead of paying the full load cost again.
  billWindow.on('close', (e) => {
    e.preventDefault();
    billWindow.hide();
  });
  if (isDev) {
    billWindow.loadURL(`http://localhost:${global.VITE_PORT || 5173}/#/bill/0`);
  } else {
    billWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: '/bill/0' });
  }
  return billWindow;
}

function ensureKotWindow() {
  if (kotWindow && !kotWindow.isDestroyed()) return kotWindow;
  const { preload, additionalArguments } = getPreloadConfig();
  kotWindow = new BrowserWindow({
    width: 420,
    height: 640,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload,
      additionalArguments,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  kotWindow.setMenuBarVisibility(false);
  kotWindow.on('close', (e) => {
    e.preventDefault();
    kotWindow.hide();
  });
  if (isDev) {
    kotWindow.loadURL(`http://localhost:${global.VITE_PORT || 5173}/#/kot/0`);
  } else {
    kotWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: '/kot/0' });
  }
  return kotWindow;
}

async function showBillWindow(billId) {
  const win = ensureBillWindow();
  currentBillId = billId;
  await navigateWindow(win, `#/bill/${billId}`);
  // The route change is synchronous, but BillWindow fetches the record
  // asynchronously. Do not reveal the window while it is still a blank
  // renderer or before the bill content has had a chance to mount.
  await new Promise((resolve) => setTimeout(resolve, 400));
  win.show();
  win.focus();
}

// Renders the exact same on-screen receipt used for printing/preview and
// screenshots it as a PNG — this is what lets WhatsApp send the *actual*
// bill (looks identical to the printed receipt) instead of a typed-out text
// summary. Reuses the pre-warmed bill window rather than opening a new one,
// same as print:bill does. Best-effort: any failure here should never break
// bill creation/checkout, so callers are expected to catch/log, not throw.
async function captureBillImage(billId) {
  const win = ensureBillWindow();
  await navigateWindow(win, `#/bill/${billId}`);
  await new Promise((r) => setTimeout(r, 350)); // let the receipt data render before capturing
  await waitForQrReady(win);
  const image = await win.webContents.capturePage();
  return image.toPNG();
}

// Polls the bill window's DOM for QRCodeImage's `data-qr-state` marker (see
// src/components/common/QRCodeImage.jsx) so the screenshot isn't taken while
// the UPI QR is still mid-generation — that race is exactly what used to
// sometimes capture the "Generating QR…" placeholder text instead of the
// real QR code. 'ready'/'failed'/'none' are all terminal (safe to capture);
// only 'loading' means "keep waiting". Capped at maxWaitMs so a QR that
// somehow never resolves can never block/fail the bill capture itself —
// it just captures whatever's on screen once the timeout is reached.
async function waitForQrReady(win, maxWaitMs = 2500, pollMs = 100) {
  const deadline = Date.now() + maxWaitMs;
  const checkScript = `
    (function() {
      var els = document.querySelectorAll('[data-qr-state]');
      if (els.length === 0) return true;
      for (var i = 0; i < els.length; i++) {
        if (els[i].getAttribute('data-qr-state') === 'loading') return false;
      }
      return true;
    })();
  `;
  while (Date.now() < deadline) {
    try {
      const ready = await win.webContents.executeJavaScript(checkScript);
      if (ready) return;
    } catch {
      return; // if we can't even query the DOM, don't block capture over it
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// Combined Group Invoice: reuses the same pre-warmed bill BrowserWindow, just
// pointed at the `#/bill-group/{groupId}` route instead of `#/bill/{id}` —
// it's a purely visual merge of already-generated per-room bills, not a new
// bill/window type.
async function showGroupBillWindow(groupId) {
  const win = ensureBillWindow();
  currentBillId = null;
  await navigateWindow(win, `#/bill-group/${groupId}`);
  win.show();
  win.focus();
}

async function showKotWindow(billId) {
  const win = ensureKotWindow();
  currentKotId = billId;
  await navigateWindow(win, `#/kot/${billId}`);
  win.show();
  win.focus();
}

// Pre-warm both windows in the background right after the main window is ready, so the
// one-time bundle-load cost happens during idle startup time, not during the user's
// first "Generate Bill" click.
function prewarmBillWindows() {
  ensureBillWindow();
  ensureKotWindow();
}

let autoBackupTimer = null;

// Windows blocks unsolicited inbound connections to a new port by default,
// which is the #1 cause of "Could not reach the address" on mobile/Client
// devices even after the app itself is configured correctly. Rather than
// requiring every customer to manually open PowerShell/Firewall settings,
// we try to add the allow-rule ourselves the first time Host mode starts.
// This only needs ONE UAC "Yes" click ever (the rule persists after that) —
// we never run the whole app elevated, just this single netsh command.
let firewallPromptShownThisSession = false;
function ensureFirewallRule(port) {
  if (process.platform !== 'win32' || firewallPromptShownThisSession) return;
  const ruleName = `${APP_NAME} LAN Sync`;
  exec(`netsh advfirewall firewall show rule name="${ruleName}"`, (err, stdout) => {
    const alreadyExists = stdout && !/no rules match/i.test(stdout);
    if (alreadyExists) return; // rule was added previously (e.g. earlier session/install) — nothing to do
    firewallPromptShownThisSession = true; // only ask once per app run, even if the user declines
    const addRuleCmd = `netsh advfirewall firewall add rule name=\\"${ruleName}\\" dir=in action=allow protocol=TCP localport=${port}`;
    // Elevates just this one command via UAC, instead of the whole app.
    const psCmd = `Start-Process cmd -ArgumentList '/c ${addRuleCmd}' -Verb RunAs -WindowStyle Hidden`;
    exec(`powershell -NoProfile -Command "${psCmd}"`, (elevErr) => {
      if (elevErr) {
        console.error('[firewall] Could not add rule automatically (user may have declined the UAC prompt). Manual fallback: run as Administrator ->', addRuleCmd.replace(/\\"/g, '"'));
      } else {
        console.log(`[firewall] Requested inbound rule for port ${port} (approve the UAC prompt if shown).`);
      }
    });
  });
}

// Only the device explicitly set as "Host" (Settings > Features >
// Multi-Terminal Sync) runs the LAN server — every other install stays
// exactly as it is today (standalone, its own local database).
function maybeStartLanServer() {
  const settings = service.getSettings();
  if (settings.feature_multi_terminal_sync !== 'true') return;
  const cfg = syncConfig.getConfig();
  if (cfg.role !== 'HOST') return;
  const port = Number(cfg.port) || 4001;
  ensureFirewallRule(port);
  startLanServer({
    port,
    authToken: cfg.authToken,
    handlers: registeredHandlers,
    getHotelName: () => service.getSettings().hotel_name,
    getFeatureFlags: () => {
      const s = service.getSettings();
      return {
        feature_captain_app: s.feature_captain_app === 'true',
        feature_table_management: s.feature_table_management === 'true',
      };
    },
  });
}

// Runs once shortly after launch, then re-checks hourly whether it's time for
// the next scheduled backup (interval configurable in Settings). A silent
// failure (folder unplugged/renamed) is logged only — we never want a backup
// hiccup to interrupt billing.
function scheduleAutoBackup() {
  if (autoBackupTimer) clearInterval(autoBackupTimer);
  const tryAutoBackup = () => {
    try {
      const settings = service.getSettings();
      if (settings.backup_auto_enabled === 'false' || !settings.backup_folder) return;
      const intervalHours = Number(settings.backup_interval_hours) || 24;
      const lastAt = settings.backup_last_at ? new Date(settings.backup_last_at).getTime() : 0;
      if (Date.now() - lastAt < intervalHours * 60 * 60 * 1000) return;
      const manifest = backupService.performBackup(settings.backup_folder);
      service.saveSettings({ backup_last_at: manifest.backedUpAt });
    } catch (err) {
      console.error('Auto-backup skipped:', err.message);
    }
  };
  setTimeout(tryAutoBackup, 15000); // give the app a moment to fully start up
  autoBackupTimer = setInterval(tryAutoBackup, 60 * 60 * 1000);
}

app.whenReady().then(async () => {
  // Wait for the Vite port probe to settle before opening any window, so
  // global.VITE_PORT is guaranteed to be set before the first loadURL() call.
  if (global.VITE_PORT_READY) await global.VITE_PORT_READY;

  syncConfig.init(app.getPath('userData'));

  // A Client device (Multi-Terminal Sync "connect to Host") never owns a
  // database of its own — it's just a terminal for an already-licensed Host
  // over the LAN, so it needs no license of its own. Only the Host/standalone
  // role (the machine that actually holds the business's data) is gated.
  const cfg = syncConfig.getConfig();
  const isClientRole = cfg.role === 'CLIENT';

  // License IPC handlers are registered FIRST, unconditionally — the
  // Activation screen needs these even before anything else in the app is
  // initialized (there is no database yet at this point if unlicensed).
  // getStatus always reports "valid" for a Client device (see above) so the
  // shared renderer's license gate never blocks a Client terminal.
  ipcMain.handle('license:getMachineId', () => licensing.getMachineId());
  ipcMain.handle('license:getStatus', () => (isClientRole ? { valid: true } : licensing.getLicenseStatus()));
  ipcMain.handle('license:activate', (event, blob) => licensing.activateLicense(blob));
  // A fresh activation only takes effect after a full relaunch (simplest,
  // most reliable way to re-run this exact startup sequence with the
  // database/IPC surface/LAN server etc. now unlocked, instead of trying to
  // hot-initialize a running process).
  ipcMain.handle('app:relaunchAfterActivation', () => {
    app.relaunch();
    app.exit(0);
  });

  const licenseStatus = isClientRole ? { valid: true } : licensing.getLicenseStatus();

  if (!licenseStatus.valid) {
    // Skip DB init, LAN server, backups, WhatsApp, everything — an
    // unlicensed install gets nothing but the Activation screen. The
    // renderer calls license:getStatus on startup and renders that screen
    // instead of the normal app whenever this is false.
    createMainWindow();
    return;
  }

  initDatabase(app.getPath('userData'));
  appLock.acquire(app.getPath('userData'));
  createMainWindow();
  prewarmBillWindows();
  scheduleAutoBackup();
  maybeStartLanServer();

  // Re-check the license every hour so that if the vendor issues a revoked
  // (expired) blob and the customer applies it, the app detects it on the
  // next recheck and relaunches into the Activation screen — no manual
  // restart required. Only for Host/standalone; Client terminals are never
  // gated (their getLicenseStatus always returns valid).
  setInterval(() => {
    const recheckStatus = licensing.getLicenseStatus();
    if (!recheckStatus.valid) {
      app.relaunch();
      app.exit(0);
    }
  }, 60 * 60 * 1000);

  // Push new-order/booking events straight to the renderer as they're found,
  // so the topbar bell + native notification appear immediately without the
  // renderer needing to poll the main process itself.
  integrations.setOnNewOrder((order) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('integrations:new-order', order);
    }
  });
  integrations.start();

  // WhatsApp auto-reconnects using its saved session (see whatsapp.cjs) so
  // the owner only has to scan the QR code once, ever — not on every app
  // restart. Push connection/QR updates straight to the renderer as they
  // happen so Settings > Integrations > WhatsApp updates live.
  whatsapp.setOnStatusChange((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('whatsapp:status-changed', state);
    }
  });
  const settingsAtStartup = service.getSettings();
  if (settingsAtStartup.feature_whatsapp_enabled === 'true' && settingsAtStartup.whatsapp_provider !== 'CLOUD_API') {
    whatsapp.connect(app.getPath('userData')).catch((err) => console.error('WhatsApp connect failed:', err.message));
    whatsapp.startFestivalScheduler();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', () => {
  appLock.release(app.getPath('userData'));
  whatsapp.stopFestivalScheduler();
});

app.on('window-all-closed', () => {
  appLock.release(app.getPath('userData'));
  if (process.platform !== 'darwin') app.quit();
});

// The bill/kot windows are hidden (not destroyed) on close so they can be reused, which
// means they wouldn't naturally trigger `window-all-closed`. Force a full quit once the
// main window itself goes away instead (see createMainWindow's 'closed' handler).

// ---------------- IPC Handlers ----------------
ipcMain.handle('settings:get', () => service.getSettings());
ipcMain.handle('settings:save', (e, partial) => {
  const updated = service.saveSettings(partial);
  integrations.pollNow();
  return updated;
});
ipcMain.handle('printer:list', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return [];
  return mainWindow.webContents.getPrintersAsync();
});
ipcMain.handle('printer:test', async (e, options = {}) => {
  const width = Number(options.paperWidth) || 80;
  const scale = Number(options.scale) || 100;
  const type = options.type || 'FOOD_BILL';
  const isRoom = type === 'ROOM';
  const isKot = type === 'KOT';
  const deviceName = options.deviceName || undefined;
  const business = options.business || {};
  const safe = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const foodName = safe(business.foodName || 'Your Restaurant Name');
  const foodAddress = business.foodAddress ? `<p>${safe(business.foodAddress)}</p>` : '';
  const foodPhone = business.foodPhone ? `<p>Ph: ${safe(business.foodPhone)}</p>` : '';
  const foodGstin = business.foodGstin ? `<p>${safe(business.foodGstin)}</p>` : '';
  const roomName = safe(business.roomName || 'Your Hotel Name');
  const roomAddress = business.roomAddress ? `<p>${safe(business.roomAddress)}</p>` : '';
  const roomPhone = business.roomPhone ? `<p>Ph: ${safe(business.roomPhone)}</p>` : '';
  const roomGstin = business.roomGstin ? `<p>${safe(business.roomGstin)}</p>` : '';
  const foodBillTotals = '<div class="line"></div><div class="row total"><span>TOTAL</span><span>₹641.00</span></div>';
  const testWindow = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const page = isRoom ? 'A4 portrait' : `${width}mm auto`;
  const pageSize = isRoom
    ? { width: 210000, height: 297000 }
    : { width: Math.round(width * 1000), height: 300000 };
  const body = isRoom
   ? `<h1>${roomName}</h1>${roomAddress}${roomPhone}${roomGstin}<h2>ROOM INVOICE</h2><p>Guest: Rahul Sharma</p><p>Room: 204 · Deluxe</p><p>Stay: 19 Sep 2026 – 21 Sep 2026</p><div class="line"></div><div class="row"><span>Room charges (2 nights)</span><span>₹6,000.00</span></div><div class="row"><span>Tax</span><span>₹720.00</span></div><div class="line"></div><div class="row total"><span>GRAND TOTAL</span><span>₹6,720.00</span></div><p>${safe(business.roomFooter || 'Thank you for staying with us.')}</p>`
   : isKot
     ? '<h2>KITCHEN ORDER TICKET</h2><p>Order #104 · Table 4</p><div class="line"></div><div class="row total"><span>Paneer Tikka x2</span></div><div class="row total"><span>Veg Biryani x1</span></div><div class="line"></div><p>Please prepare immediately</p>'
     : `<h2>${foodName}</h2>${foodAddress}${foodPhone}${foodGstin}<p>${isKot ? 'KITCHEN ORDER TICKET · Order #104 · Table 4' : 'TAX INVOICE · THERMAL PRINTER TEST'}</p><div class="line"></div><div class="row"><span>Paneer Tikka x2</span>${isKot ? '' : '<span>₹440.00</span>'}</div><div class="row"><span>Veg Biryani x1</span>${isKot ? '' : '<span>₹180.00</span>'}</div>${isKot ? '' : foodBillTotals}<p>${safe(isKot ? 'Please prepare immediately' : (business.foodFooter || 'Thank you! Visit again.'))}</p>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${page}; margin: ${isRoom ? '12mm' : '0'}; }
    html, body { margin: 0; padding: 0; ${isRoom ? 'width: 100%;' : `width: ${width}mm;`} }
    body { font-family: ${isRoom ? 'Arial, sans-serif' : 'Consolas, monospace'}; font-size: ${isRoom ? '12pt' : `${scale}%`}; padding: ${isRoom ? '0' : '3mm'}; box-sizing: border-box; }
    h1, h2, p { margin: 0 0 3mm; text-align: center; } .line { border-top: 1px dashed #000; margin: 3mm 0; }
    .row { display: flex; justify-content: space-between; gap: 3mm; margin-bottom: 2mm; } .total { font-weight: 700; font-size: 1.15em; }
  </style></head><body>${body}</body></html>`;
  try {
    await testWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await new Promise((resolve, reject) => testWindow.webContents.print({
      silent: false,
      printBackground: true,
      pageSize,
      ...(deviceName ? { deviceName } : {}),
    }, (success, reason) => (success ? resolve() : reject(new Error(reason || 'Print dialog was cancelled.')))));
    return true;
  } finally {
    if (!testWindow.isDestroyed()) testWindow.close();
  }
});

// ---- Local backup / restore (no cloud service — see db/backupService.cjs) ----
ipcMain.handle('backup:chooseFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  const folder = result.filePaths[0];
  service.saveSettings({ backup_folder: folder });
  return folder;
});
ipcMain.handle('backup:now', () => {
  const settings = service.getSettings();
  if (!settings.backup_folder) throw new Error('Choose a backup folder first.');
  const manifest = backupService.performBackup(settings.backup_folder);
  service.saveSettings({ backup_last_at: manifest.backedUpAt });
  return manifest;
});
ipcMain.handle('backup:openFolder', () => {
  const settings = service.getSettings();
  if (!settings.backup_folder) return false;
  shell.openPath(backupService.resolveBackupRoot(settings.backup_folder));
  return true;
});
ipcMain.handle('backup:restore', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  backupService.restoreBackup(result.filePaths[0]);
  // The live DB file was just overwritten on disk while the old handle is
  // still open in memory — relaunch so everything re-reads from the restored
  // files cleanly instead of risking a half-old/half-new in-memory state.
  app.relaunch();
  app.exit(0);
  return true;
});

// ---- Desktop -> Mobile data export (see db/mobileSyncService.cjs) ----
// One-way: reshapes the live SQLite data into the exact JSON shape mobile's
// webApi.js expects, then lets the owner save it as a file anywhere (their
// synced Google Drive folder, a USB transfer, WhatsApp to themselves,
// etc.) to be opened on the phone via the mobile app's "Import Backup" button.
ipcMain.handle('data:exportForMobile', async () => {
  const data = mobileSyncService.exportForMobile();
  const dateStamp = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: `Save ${APP_NAME} Mobile Export`,
    defaultPath: `${APP_NAME}-Mobile-Export-${dateStamp}.json`,
    filters: [{ name: `${APP_NAME} Mobile Export`, extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
  return result.filePath;
});

ipcMain.handle('categories:list', () => service.getCategories());
ipcMain.handle('categories:add', (e, name) => service.addCategory(name));

ipcMain.handle('food:list', (e, filters) => service.getFoodItems(filters));
ipcMain.handle('food:popular', (e, limit) => service.getPopularFood(limit));
ipcMain.handle('food:save', (e, item) => service.saveFoodItem(item));
ipcMain.handle('food:delete', (e, id) => service.deleteFoodItem(id));
ipcMain.handle('food:pickImage', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Guest ID-proof document picker (photo or scanned PDF). Can be attached at
// booking time or added/changed later via Edit Booking.
ipcMain.handle('room:pickIdDocument', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'ID Documents', extensions: ['png', 'jpg', 'jpeg', 'webp', 'pdf'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const documentsDir = path.join(app.getPath('userData'), 'data', 'id-documents');
  fs.mkdirSync(documentsDir, { recursive: true });
  return result.filePaths.map((sourcePath) => {
    const extension = path.extname(sourcePath).toLowerCase();
    const id = `id:${require('crypto').randomUUID()}${extension}`;
    fs.copyFileSync(sourcePath, path.join(documentsDir, id.slice(3)));
    return id;
  });
});
ipcMain.handle('room:openIdDocument', (e, fileRef) => {
  if (typeof fileRef !== 'string' || !fileRef) throw new Error('Invalid ID document reference.');
  const documentsDir = path.resolve(path.join(app.getPath('userData'), 'data', 'id-documents'));
  const name = fileRef.startsWith('id:') ? fileRef.slice(3) : path.basename(fileRef);
  if (!/^[a-zA-Z0-9_-]+\.(png|jpe?g|webp|pdf)$/i.test(name)) {
    throw new Error('ID document is not an approved app-owned file.');
  }
  const target = path.resolve(path.join(documentsDir, name));
  if (!target.startsWith(`${documentsDir}${path.sep}`) || !fs.existsSync(target)) {
    throw new Error('ID document is unavailable.');
  }
  return shell.openPath(target);
});

ipcMain.handle('bill:create', async (e, payload) => {
  const bill = service.createBill(payload);
  // The renderer owns the post-billing action: it either opens the bill
  // preview or sends the bill/KOT through the hidden native print windows.
  // Do not open both windows here as well; concurrent navigation of the
  // prewarmed windows can leave the bill preview blank.
  // Best-effort — a WhatsApp send failure (not connected, no phone, etc.)
  // must never block or fail the bill itself, which is already saved/printed.
  const settings = service.getSettings();
  if (settings.feature_whatsapp_enabled === 'true' && settings.whatsapp_send_food_bill === 'true' && bill.customerPhone) {
    // Send the actual receipt image (screenshot of the same bill window used
    // for print/preview) with a short caption, rather than a typed-out text
    // summary. If the screenshot fails for any reason, imageBuffer stays
    // null and sendBillMessage falls back to the original full text message.
    (async () => {
      let imageBuffer = null;
      try {
        imageBuffer = await captureBillImage(bill.id);
      } catch (err) {
        console.error('Bill screenshot for WhatsApp failed, falling back to text:', err.message);
      }
      await whatsapp.sendBillMessage(bill, imageBuffer);
    })().catch((err) => console.error('WhatsApp bill send failed:', err.message));
  }
  return bill;
});
ipcMain.handle('bill:getById', (e, id) => service.getBillById(id));
ipcMain.handle('bill:cancel', (e, id, reason) => service.cancelBill(id, reason));
ipcMain.handle('bill:list', (e, filters) => service.getBills(filters));
ipcMain.handle('bill:openRecordsFolder', () => shell.openPath(getBillRecordsDir()));
ipcMain.handle('bill:openWindow', (e, id) => {
  showBillWindow(id);
  return true;
});
ipcMain.handle('bill:getGroupInvoice', (e, groupId) => roomService.getGroupInvoiceData(groupId));
ipcMain.handle('bill:openGroupWindow', (e, groupId) => {
  showGroupBillWindow(groupId);
  return true;
});

// ---------------- Restaurant Tables (Table/Area Management — opt-in) ----------------
ipcMain.handle('table:list', () => service.getTables());
ipcMain.handle('table:save', (e, table) => service.saveTable(table));
ipcMain.handle('table:delete', (e, id) => service.deleteTable(id));
ipcMain.handle('table:updateStatus', (e, id, status) => service.updateTableStatus(id, status));
ipcMain.handle('table:assignWaiter', (e, id, waiterName) => service.assignTableWaiter(id, waiterName));
// The table's shared, live not-yet-billed order — lets a second counter or
// a Captain's phone (Multi-Terminal Sync) resume the SAME order another
// device already started, instead of unknowingly starting a second one.
ipcMain.handle('table:getOrder', (e, id) => service.getTableOrder(id));
ipcMain.handle('table:saveOrder', (e, id, payload) => service.saveTableOrder(id, payload));
ipcMain.handle('table:clearOrder', (e, id) => service.clearTableOrder(id));

// ---------------- Multi-Terminal Sync (opt-in, per-device role) ----------------
// role/hostIp/port are local-only (see syncConfig.cjs) — never part of the
// shared `settings` table, so a Client device always reads/writes ITS OWN
// role here, never the Host's.
ipcMain.handle('sync:getLocalConfig', () => syncConfig.getConfig());
ipcMain.handle('sync:setLocalConfig', (e, partial) => syncConfig.saveConfig(partial));ipcMain.handle('sync:getStatus', () => ({
  running: isLanServerRunning(),
  ip: getLocalIp(),
  port: Number(syncConfig.getConfig().port) || 4001,
  role: syncConfig.getConfig().role,
  error: isLanServerRunning() ? null : getLastStartError(),
  supported: true,
}));
// Called after Settings saves a change to role/port/the feature toggle
// itself, so the server starts/stops immediately without requiring the
// whole app to be restarted.
ipcMain.handle('sync:restart', async () => {
  stopLanServer();
  maybeStartLanServer();
  // `listen()` binds asynchronously (fires its 'listening'/'error' event a
  // tick or two later) — a short wait here lets the real outcome (success or
  // e.g. EADDRINUSE) settle before we report status back, instead of always
  // reporting the old/false state from immediately after the call.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { running: isLanServerRunning(), ip: getLocalIp(), error: isLanServerRunning() ? null : getLastStartError(), supported: true };
});

// Switching this device's role (e.g. Setup Wizard's "Join an existing
// setup") swaps which preload script every future window uses (see
// getPreloadConfig above) — that can only take effect for windows created
// AFTER the change, so a full process relaunch is required rather than just
// reloading the current renderer.
ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('kot:openWindow', (e, id) => {
  showKotWindow(id);
  return true;
});
ipcMain.handle('kot:openRecordsFolder', () => shell.openPath(getKotRecordsDir()));

ipcMain.handle('report:summary', (e, payload) => service.getSummary(payload));
ipcMain.handle('report:trend', (e, payload) => service.getSalesTrend(payload));

ipcMain.handle('print:bill', async (e, billId) => {
  // Fully self-contained: renders the right bill in the hidden print window
  // and prints it in one click — no extra bill
  // preview window is shown from the billing screen.
  const printWindow = ensureBillWindow();
  printWindow.hide();
  await navigateWindow(printWindow, `#/bill/${billId}`);
  await new Promise((r) => setTimeout(r, 350)); // let the receipt data render before printing
  const settings = service.getSettings();
  const bill = service.getBillById(billId);
  const isRoom = bill?.source === 'ROOM';
  const paperWidth = Math.max(48, Math.min(112, Number(settings.printer_paper_width) || 80));
  const deviceName = (isRoom ? settings.room_printer_name : settings.food_printer_name) || undefined;
  await new Promise((resolve, reject) => {
    printWindow.webContents.print({
      silent: false,
      printBackground: true,
      pageSize: isRoom
        ? { width: 210000, height: 297000 }
        : { width: Math.round(paperWidth * 1000), height: 300000 },
      ...(deviceName ? { deviceName } : {}),
    }, (success, reason) => (success ? resolve() : reject(new Error(reason || 'Print dialog was cancelled.'))));
  });
  return true;
});

ipcMain.handle('print:kot', async (e, billId) => {
  const printWindow = ensureKotWindow();
  printWindow.hide();
  await navigateWindow(printWindow, `#/kot/${billId}`);
  await new Promise((r) => setTimeout(r, 350));
  const settings = service.getSettings();
  const deviceName = settings.kot_printer_name || undefined;
  await new Promise((resolve, reject) => {
    printWindow.webContents.print({
      silent: false,
      printBackground: true,
      pageSize: { width: 80000, height: 300000 },
      ...(deviceName ? { deviceName } : {}),
    }, (success, reason) => (success ? resolve() : reject(new Error(reason || 'Print dialog was cancelled.'))));
  });
  return true;
});

// ---- Download Receipt (Food bills -> PNG image; Room bills -> A4 PDF) ----
// Reuses the exact same pre-warmed bill window + QR-ready wait used for
// WhatsApp image capture/printing, so what gets saved always matches what's
// on screen/gets printed.
ipcMain.handle('bill:downloadImage', async (e, billId) => {
  const bill = service.getBillById(billId);
  const buffer = await captureBillImage(billId);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Receipt Image',
    defaultPath: `Receipt-${bill?.bill_number || billId}-${dateStamp}.png`,
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, buffer);
  return result.filePath;
});

async function captureBillPdf(route) {
  const win = ensureBillWindow();
  currentBillId = null;
  await navigateWindow(win, route);
  await new Promise((r) => setTimeout(r, 350));
  await waitForQrReady(win);
  return win.webContents.printToPDF({
    pageSize: 'A4',
    printBackground: true,
    margins: { marginType: 'none' },
  });
}

ipcMain.handle('bill:downloadPdf', async (e, billId) => {
  const bill = service.getBillById(billId);
  const buffer = await captureBillPdf(`#/bill/${billId}`);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Invoice PDF',
    defaultPath: `Invoice-${bill?.bill_number || billId}-${dateStamp}.pdf`,
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, buffer);
  return result.filePath;
});

ipcMain.handle('bill:downloadGroupPdf', async (e, groupId) => {
  const buffer = await captureBillPdf(`#/bill-group/${groupId}`);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Group Invoice PDF',
    defaultPath: `Group-Invoice-${groupId}-${dateStamp}.pdf`,
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, buffer);
  return result.filePath;
});

// ---------------- Purchases (spend tracking only) ----------------
ipcMain.handle('inventory:listMaterials', () => service.getRawMaterials());
ipcMain.handle('inventory:saveMaterial', (e, item) => service.saveRawMaterial(item));
ipcMain.handle('inventory:deleteMaterial', (e, id) => service.deleteRawMaterial(id));

ipcMain.handle('inventory:recordPurchase', (e, payload) => service.recordPurchase(payload));
ipcMain.handle('inventory:purchaseHistory', (e, filters) => service.getPurchaseHistory(filters));
ipcMain.handle('inventory:purchaseSummary', (e, payload) => service.getPurchaseSummary(payload));
ipcMain.handle('inventory:purchaseTrend', (e, payload) => service.getPurchaseTrend(payload));

// ---------------- Expenses (salary, rent, utilities, etc.) ----------------
ipcMain.handle('inventory:recordExpense', (e, payload) => service.recordExpense(payload));
ipcMain.handle('inventory:expenseHistory', (e, filters) => service.getExpenseHistory(filters));
ipcMain.handle('inventory:expenseSummary', (e, payload) => service.getExpenseSummary(payload));
ipcMain.handle('inventory:expenseTrend', (e, payload) => service.getExpenseTrend(payload));

// ---------------- Profit & Loss ----------------
ipcMain.handle('report:profitLoss', (e, payload) => service.getProfitAndLoss(payload));

// ---------------- Zomato/Swiggy/MMT Order Manager integrations ----------------
// Polling-based (not webhook) — see electron/integrations/pollingService.cjs.
// The poller restarts its enabled/disabled/credential check automatically on
// its own interval, but we also re-poll immediately whenever Settings are
// saved so a freshly-enabled platform doesn't wait up to 8s for its first check.
ipcMain.handle('integrations:listIncoming', () => integrations.listIncoming());
ipcMain.handle('integrations:accept', (e, externalId) => integrations.acceptIncoming(externalId));
ipcMain.handle('integrations:reject', (e, externalId, reason) => integrations.rejectIncoming(externalId, reason));
ipcMain.handle('integrations:simulateTestOrder', (e, platform) => integrations.simulateTestOrder(platform));

// ---------------- Room Booking / PMS ----------------
ipcMain.handle('room:list', () => roomService.getRooms());
ipcMain.handle('room:save', (e, room) => roomService.saveRoom(room));
ipcMain.handle('room:delete', (e, id) => roomService.deleteRoom(id));
ipcMain.handle('room:toggleMaintenance', (e, { id, underMaintenance }) => roomService.toggleRoomMaintenance(id, underMaintenance));
ipcMain.handle('room:availability', (e, payload) => roomService.getRoomAvailability(payload || {}));
ipcMain.handle('room:calendar', (e, payload) => roomService.getRoomCalendar(payload || {}));

ipcMain.handle('booking:create', (e, payload) => {
  const result = roomService.createBooking(payload);
  const settings = service.getSettings();
  if (settings.feature_whatsapp_enabled === 'true' && settings.whatsapp_send_room_booking === 'true') {
    const bookings = Array.isArray(result) ? result : [result];
    for (const booking of bookings) {
      whatsapp.sendBookingMessage(booking).catch((err) => console.error('WhatsApp booking send failed:', err.message));
    }
  }
  return result;
});
ipcMain.handle('booking:update', (e, { id, payload }) => roomService.updateBooking(id, payload));
ipcMain.handle('booking:checkIn', async (e, id) => {
  const booking = roomService.checkIn(id);
  const settings = service.getSettings();
  if (settings.feature_whatsapp_enabled === 'true' && settings.whatsapp_send_room_checkin === 'true') {
    whatsapp.sendCheckinMessage(booking)
      .catch((err) => console.error('WhatsApp check-in send failed:', err.message));
  }
  return booking;
});
ipcMain.handle('booking:checkOut', async (e, { id, paymentMethod } = {}) => {
  const result = roomService.checkOut(id, paymentMethod);
  // Show (but don't print) the generated invoice so staff can review/print it,
  // mirroring the regular billing flow's post-generation preview.
  showBillWindow(result.bill.id);
  const settings = service.getSettings();
  if (settings.feature_whatsapp_enabled === 'true' && settings.whatsapp_send_room_checkout === 'true') {
    // Send the actual room invoice as a PDF document, rather than an image.
    // Falls back to the existing text message if PDF generation fails.
    (async () => {
      let pdfBuffer = null;
      try {
        pdfBuffer = await captureBillPdf(`#/bill/${result.bill.id}`);
      } catch (err) {
        console.error('Checkout bill PDF for WhatsApp failed, falling back to text:', err.message);
      }
      await whatsapp.sendCheckoutMessage(result.booking, result.bill, pdfBuffer);
    })().catch((err) => console.error('WhatsApp checkout send failed:', err.message));
  }
  return result;
});
ipcMain.handle('booking:addRoomToGroup', (e, { groupId, room }) => roomService.addRoomToBookingGroup(groupId, room));
ipcMain.handle('booking:cancel', (e, { id, reason, refund, refundMethod }) => roomService.cancelBooking(id, reason, refund, refundMethod));
ipcMain.handle('booking:cancelGroup', (e, { groupId, reason, refund, refundMethod }) => roomService.cancelGroupBooking(groupId, reason, refund, refundMethod));
ipcMain.handle('booking:addAddon', (e, { bookingId, addon }) => roomService.addAddon(bookingId, addon));
ipcMain.handle('booking:removeAddon', (e, addonId) => roomService.removeAddon(addonId));
ipcMain.handle('booking:list', (e, filters) => roomService.listBookings(filters || {}));
ipcMain.handle('booking:getById', (e, id) => roomService.getBookingById(id));

// ---------------- Users / PIN login (Owner vs Staff access control) ----------------
ipcMain.handle('user:hasOwnerAccount', () => userService.hasOwnerAccount());
ipcMain.handle('user:createOwnerAccount', (e, payload) => userService.createOwnerAccount(payload));
ipcMain.handle('user:createStaffAccount', (e, payload) => userService.createStaffAccount(payload));
ipcMain.handle('user:list', () => userService.listUsers());
ipcMain.handle('user:deactivate', (e, id) => userService.deactivateUser(id));
ipcMain.handle('user:resetPin', (e, { id, newPin }) => userService.resetPin(id, newPin));
ipcMain.handle('user:changePin', (e, { id, currentPin, newPin }) => userService.changePin(id, currentPin, newPin));
ipcMain.handle('user:requestPinResetOtp', () => userService.requestOwnerPinResetOtp());
ipcMain.handle('user:verifyPinResetOtp', (e, { otp, newPin }) => userService.verifyOwnerPinResetOtp(otp, newPin));
ipcMain.handle('user:updateAccess', (e, { id, access }) => userService.updateUserAccess(id, access));
ipcMain.handle('user:loginWithPin', (e, pin) => userService.loginWithPin(pin));

// ---------------- WhatsApp (bill/booking confirmations + festival greetings) ----------------
// Not a paid API — links the owner's own WhatsApp account via QR pairing
// (see electron/whatsapp.cjs). Enabling the feature toggle both connects
// immediately and starts the hourly festival-greeting scheduler; disabling
// it disconnects and stops the scheduler, so no background WhatsApp activity
// happens at all unless explicitly turned on.
ipcMain.handle('whatsapp:getStatus', () => whatsapp.getStatus());
ipcMain.handle('whatsapp:configureCloudApi', (e, accessToken, phoneNumberId) => whatsapp.configureCloudApi(accessToken, phoneNumberId));
ipcMain.handle('whatsapp:clearCloudApi', () => whatsapp.clearCloudApi());
ipcMain.handle('whatsapp:connect', async () => {
  await service.saveSettings({ feature_whatsapp_enabled: 'true' });
  whatsapp.startFestivalScheduler();
  return whatsapp.connect(app.getPath('userData'), true);
});
ipcMain.handle('whatsapp:logout', async () => {
  await service.saveSettings({ feature_whatsapp_enabled: 'false' });
  whatsapp.stopFestivalScheduler();
  return whatsapp.logout();
});
ipcMain.handle('whatsapp:sendTest', (e, phone) => whatsapp.sendMessage(phone, `This is a test message from ${APP_NAME} ✅`, 'TEST'));
ipcMain.handle('whatsapp:getSendLog', () => getDb().prepare('SELECT * FROM whatsapp_log ORDER BY created_at DESC LIMIT 50').all());
// This accepts a webhook payload only when an operator supplies it from a
// separately hosted/public Meta webhook receiver; Electron is not public.
ipcMain.handle('whatsapp:applyWebhook', (e, payload) => whatsapp.applyCloudWebhook(payload));

// Festival greetings CRUD (Settings > Integrations > WhatsApp)
ipcMain.handle('whatsapp:listFestivals', () => getDb().prepare('SELECT * FROM festival_greetings ORDER BY month_day').all());
ipcMain.handle('whatsapp:saveFestival', (e, festival) => {
  const db = getDb();
  if (festival.id) {
    db.prepare('UPDATE festival_greetings SET name=?, month_day=?, message_template=?, enabled=? WHERE id=?')
      .run(festival.name, festival.monthDay, festival.messageTemplate, festival.enabled ? 1 : 0, festival.id);
  } else {
    db.prepare('INSERT INTO festival_greetings (name, month_day, message_template, enabled) VALUES (?,?,?,?)')
      .run(festival.name, festival.monthDay, festival.messageTemplate, festival.enabled ? 1 : 0);
  }
  return db.prepare('SELECT * FROM festival_greetings ORDER BY month_day').all();
});
ipcMain.handle('whatsapp:deleteFestival', (e, id) => {
  getDb().prepare('DELETE FROM festival_greetings WHERE id = ?').run(id);
  return true;
});
ipcMain.handle('whatsapp:share', async (e, text, phoneNumber) => {
  const encoded = encodeURIComponent(text);
  const url = phoneNumber
    ? `https://api.whatsapp.com/send?phone=${phoneNumber}&text=${encoded}`
    : `https://wa.me/?text=${encoded}`;
  await shell.openExternal(url);
  return true;
});
