// Preload for the standalone "BillNest Reset" tool window only (see
// factoryReset.cjs). Deliberately tiny — just enough to drive the
// confirmation form in factory-reset.html — never shares any channel with
// the main app's preload.cjs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('freset', {
  getStatus: () => ipcRenderer.invoke('freset:get-status'),
  submit: (confirmText, ownerPin, keepBackup, fullWipe) => ipcRenderer.invoke('freset:submit', { confirmText, ownerPin, keepBackup, fullWipe }),
  openMainApp: () => ipcRenderer.invoke('freset:open-main-app'),
  openBackupFolder: () => ipcRenderer.invoke('freset:open-backup-folder'),
  quit: () => ipcRenderer.invoke('freset:quit'),
});
