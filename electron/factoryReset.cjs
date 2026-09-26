// Standalone "BillNest Reset" tool — entirely separate entry point from the
// normal app flow in main.cjs, launched via a second desktop/Start-Menu
// shortcut that runs the very same packaged .exe with a `--factory-reset`
// argument (see build/installer.nsh + package.json build.nsis.include).
// Deliberately its own tiny window/UI (factory-reset.html, vanilla JS, no
// React/Vite dependency) so it still works even if the main app is broken,
// the Owner is locked out, or Settings is unreachable for any reason.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { initDatabase, getDb, factoryReset: wipeAllData } = require('../db/database.cjs');
const userService = require('../db/userService.cjs');
const backupService = require('../db/backupService.cjs');
const appLock = require('./appLock.cjs');
const { APP_NAME } = require('./brand.cjs');

let dbReady = false;
let lastBackupPath = null;

function ensureDb() {
  if (!dbReady) {
    initDatabase(app.getPath('userData'));
    dbReady = true;
  }
}

// Closes the DB connection right after each check/reset finishes, instead
// of holding it open for as long as this tool's window happens to be sitting
// idle — better-sqlite3 opens the file with an exclusive-ish OS-level handle,
// so leaving it open here was blocking the main BillNest app from starting
// up normally while this tool was simply left open in the background.
function closeDb() {
  if (dbReady) {
    try { getDb().close(); } catch { /* already closed/never fully opened */ }
    dbReady = false;
  }
}

function hasOwnerAccount() {
  ensureDb();
  const row = getDb().prepare("SELECT COUNT(*) c FROM users WHERE role = 'OWNER'").get();
  return row.c > 0;
}

// A safety-net backup taken automatically right before wiping — separate
// from (and in addition to) the owner's own Settings > Backup folder, so
// data is always recoverable even if that was never configured. Lives
// inside userData itself (not touching whatever the owner picked in
// Settings), one dated folder per reset so previous safety backups are
// never overwritten.
function takeSafetyBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = path.join(app.getPath('userData'), 'Pre-Reset Backups', stamp);
  fs.mkdirSync(folder, { recursive: true }); // performBackup requires the folder to already exist
  backupService.performBackup(folder);
  lastBackupPath = backupService.resolveBackupRoot(folder);
  return lastBackupPath;
}

function openMainApp() {
  // Re-launches the exact same .exe this tool is bundled inside, minus the
  // --factory-reset flag, so it comes up as the normal BillNest app.
  const args = app.isPackaged ? [] : [app.getAppPath()];
  spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'build', 'icon-reset.ico')
    : path.join(__dirname, '../build/icon-reset.ico');
}

function run() {
  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 460,
      height: 640,
      resizable: false,
      title: `${APP_NAME} Reset`,
      icon: iconPath(),
      webPreferences: {
        preload: path.join(__dirname, 'preload-factory-reset.cjs'),
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'factory-reset.html'));

    ipcMain.handle('freset:get-status', () => {
      const userDataPath = app.getPath('userData');
      if (appLock.isMainAppRunning(userDataPath)) {
        return { appRunning: true };
      }
      const result = { appRunning: false, hasOwnerAccount: hasOwnerAccount() };
      closeDb();
      return result;
    });

    ipcMain.handle('freset:submit', (_e, { confirmText, ownerPin, keepBackup, fullWipe }) => {
      const userDataPath = app.getPath('userData');
      if (appLock.isMainAppRunning(userDataPath)) {
        return { ok: false, error: `${APP_NAME} is currently open on this device. Close it fully first.` };
      }
      if ((confirmText || '').trim().toUpperCase() !== 'RESET') {
        return { ok: false, error: 'Please type RESET exactly to confirm.' };
      }
      if (hasOwnerAccount()) {
        const user = userService.loginWithPin((ownerPin || '').trim());
        if (!user || user.role !== 'OWNER') {
          closeDb();
          return { ok: false, error: 'Incorrect Owner PIN.' };
        }
      }
      let backupPath = null;
      try {
        if (keepBackup) backupPath = takeSafetyBackup();
      } catch (err) {
        // Data safety comes first — if we can't confirm a backup was taken,
        // refuse to wipe anything rather than risk unrecoverable data loss.
        closeDb();
        return { ok: false, error: `Could not take safety backup, reset cancelled: ${err.message}` };
      }
      try {
        wipeAllData({ fullWipe: !!fullWipe });
        return { ok: true, backupPath };
      } catch (err) {
        return { ok: false, error: `Reset failed: ${err.message}` };
      } finally {
        closeDb();
      }
    });

    ipcMain.handle('freset:open-main-app', () => openMainApp());
    ipcMain.handle('freset:quit', () => app.quit());
    ipcMain.handle('freset:open-backup-folder', () => {
      if (lastBackupPath) shell.openPath(lastBackupPath);
    });
  });

  app.on('window-all-closed', () => app.quit());
}

module.exports = { run };
