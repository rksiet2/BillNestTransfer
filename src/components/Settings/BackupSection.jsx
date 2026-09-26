import React, { useEffect, useRef, useState } from 'react';
import { APP_NAME } from '../../constants/brand';

// Local, no-cloud backup/restore ("data continuity") section for Settings.
//
// Desktop (Electron): copies the SQLite DB + Bill/KOT Records into a folder
// the owner chooses. Point that folder at a local Google Drive desktop-sync
// folder and it uploads automatically — no Google API/OAuth code needed
// here. Restoring on a new PC: install Drive with the same Gmail, let it
// sync the folder down, then use "Restore from Backup".
//
// Mobile (Capacitor/browser demo): there's no persistent folder handle on
// Android, so instead "Export" opens the native Share Sheet (Google Drive
// shows up there automatically) and "Import" opens the native document
// picker (Google Drive shows up there too) — both are plain Web APIs, no
// extra native plugin required.
const IS_DESKTOP = typeof window !== 'undefined' && !!window.api?.chooseBackupFolder;

export default function BackupSection() {
  return IS_DESKTOP ? <DesktopBackup /> : <MobileBackup />;
}

function DesktopBackup() {
  const [settings, setSettings] = useState({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [mobileBusy, setMobileBusy] = useState(false);
  const [mobileStatus, setMobileStatus] = useState('');
  const [showBackupHelp, setShowBackupHelp] = useState(false);
  const [showMobileHelp, setShowMobileHelp] = useState(false);

  useEffect(() => { window.api.getSettings().then(setSettings); }, []);

  async function chooseFolder() {
    const folder = await window.api.chooseBackupFolder();
    if (folder) setSettings((s) => ({ ...s, backup_folder: folder }));
  }

  async function backupNow() {
    setBusy(true);
    setStatus('');
    try {
      const manifest = await window.api.backupNow();
      setSettings((s) => ({ ...s, backup_last_at: manifest.backedUpAt }));
      setStatus('✅ Backup completed just now.');
    } catch (err) {
      setStatus(`❌ ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleAuto(enabled) {
    const updated = await window.api.saveSettings({ backup_auto_enabled: enabled ? 'true' : 'false' });
    setSettings(updated);
  }

  async function changeInterval(hours) {
    const updated = await window.api.saveSettings({ backup_interval_hours: hours });
    setSettings(updated);
  }

  async function restore() {
    const ok = window.confirm(
      'Restoring will REPLACE all current data (menu, bills, bookings, staff, everything) ' +
      'with what is in the chosen backup folder, then restart the app. This cannot be undone. Continue?'
    );
    if (!ok) return;
    try {
      await window.api.restoreBackup();
    } catch (err) {
      setStatus(`❌ ${err.message}`);
    }
  }

  async function exportForMobile() {
    setMobileBusy(true);
    setMobileStatus('');
    try {
      const filePath = await window.api.exportForMobile();
      if (filePath) setMobileStatus(`✅ Saved to: ${filePath}`);
    } catch (err) {
      setMobileStatus(`❌ ${err.message}`);
    } finally {
      setMobileBusy(false);
    }
  }

  const autoEnabled = settings.backup_auto_enabled !== 'false';

  return (
    <div className="settings-section backup-section">
      <h3 className="label-with-help">
        💾 Backup &amp; Data Continuity
        <button
          type="button"
          className="help-question-btn"
          onClick={() => setShowBackupHelp((v) => !v)}
          title="More about backups"
          aria-label="More about backups"
        >?</button>
      </h3>
      <p className="settings-sub">
        No cloud account required — sync the backup folder via desktop Google Drive for automatic protection.
      </p>
      {showBackupHelp && (
        <div className="help-panel">
          Point the backup folder at a folder synced by the Google Drive desktop app for free, automatic,
          off-device protection. If this PC is ever replaced, install Google Drive on the new machine
          (same account), allow it to sync the folder down, then use "Restore from Backup" below to
          resume operation immediately with all existing data intact.
        </div>
      )}

      <div className="settings-row backup-folder-row">
        <div>
          <strong>Backup folder:</strong>{' '}
          {settings.backup_folder ? <code>{settings.backup_folder}</code> : <em>Not set yet</em>}
        </div>
        <button className="btn btn-secondary btn-small" onClick={chooseFolder}>📁 {settings.backup_folder ? 'Change Folder' : 'Choose Folder'}</button>
      </div>

      <label className="backup-checkbox-row">
        <input type="checkbox" checked={autoEnabled} onChange={(e) => toggleAuto(e.target.checked)} />
        Automatically back up in the background
      </label>

      {autoEnabled && (
        <label>
          Backup frequency
          <select value={settings.backup_interval_hours || '24'} onChange={(e) => changeInterval(e.target.value)}>
            <option value="6">Every 6 hours</option>
            <option value="24">Daily</option>
            <option value="168">Weekly</option>
          </select>
        </label>
      )}

      <div className="settings-extra">
        <button className="btn btn-primary" onClick={backupNow} disabled={busy || !settings.backup_folder}>
          {busy ? 'Backing up…' : '⬆️ Backup Now'}
        </button>
        <button className="btn btn-secondary" onClick={() => window.api.openBackupFolder()} disabled={!settings.backup_folder}>
          📂 Open Backup Folder
        </button>
        <button className="btn btn-danger" onClick={restore}>
          ♻️ Restore from Backup…
        </button>
      </div>

      <h4 className="label-with-help" style={{ margin: '18px 0 4px' }}>
        📱 Set Up the Mobile App With This Same Data
        <button
          type="button"
          className="help-question-btn"
          onClick={() => setShowMobileHelp((v) => !v)}
          title="More about mobile export"
          aria-label="More about mobile export"
        >?</button>
      </h4>
      <p className="settings-sub">
        Export a single data file to transfer menu, rooms, bills, bookings and staff logins to the mobile app.
      </p>
      {showMobileHelp && (
        <div className="help-panel">
          Produces one file containing the menu, rooms, bills, bookings and staff logins — including
          existing PINs, so no reset is required. Transfer the file to the phone by any method (WhatsApp
          to self, email, a synced Google Drive folder, USB), then open the mobile app's Settings screen
          and use "Import Backup" to select that file.
        </div>
      )}
      <div className="settings-extra">
        <button className="btn btn-secondary" onClick={exportForMobile} disabled={mobileBusy}>
          {mobileBusy ? 'Preparing…' : '📱 Export Data for Mobile App'}
        </button>
      </div>
      {mobileStatus && <div className="toast-success">{mobileStatus}</div>}

      {settings.backup_last_at && (
        <p className="settings-hint">Last backup: {new Date(settings.backup_last_at).toLocaleString()}</p>
      )}
      {status && <div className="toast-success">{status}</div>}
    </div>
  );
}

function MobileBackup() {
  const [status, setStatus] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const fileInputRef = useRef(null);

  async function exportData() {
    setStatus('');
    try {
      const json = await window.api.exportAllData();
      const file = new File([json], `billnest-backup-${Date.now()}.json`, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `${APP_NAME} Backup` });
        setStatus('✅ Export shared. Choose "Google Drive" in the share sheet to save it there.');
      } else {
        // Fallback for browsers/WebViews without file sharing support.
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
        setStatus('✅ Backup file downloaded.');
      }
    } catch (err) {
      if (err?.name !== 'AbortError') setStatus(`❌ ${err.message}`);
    }
  }

  function pickImportFile() {
    fileInputRef.current?.click();
  }

  async function handleFileChosen(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const ok = window.confirm(
      'Importing will REPLACE all data currently on this device with the contents of that backup file. Continue?'
    );
    if (!ok) return;
    setStatus('');
    try {
      const text = await file.text();
      await window.api.importAllData(text);
      setStatus('✅ Data imported. Reloading…');
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      setStatus(`❌ ${err.message}`);
    }
  }

  return (
    <div className="settings-section backup-section">
      <h3 className="label-with-help">
        💾 Backup &amp; Data Continuity
        <button
          type="button"
          className="help-question-btn"
          onClick={() => setShowHelp((v) => !v)}
          title="More about mobile backup"
          aria-label="More about mobile backup"
        >?</button>
      </h3>
      <p className="settings-sub">
        Data is stored only on this device — export/import to move to a new phone or restore it.
      </p>
      {showHelp && (
        <div className="help-panel">
          Export saves a backup file to Google Drive via the share sheet; on the new device, import the
          same file the same way — Google Drive appears as a source automatically. The "Export Data for
          Mobile App" file created from the desktop app's Settings screen can also be imported here, to
          start this phone with the desktop's existing menu, bookings and staff PINs.
        </div>
      )}
      <div className="settings-extra">
        <button className="btn btn-primary" onClick={exportData}>⬆️ Export / Share Backup</button>
        <button className="btn btn-secondary" onClick={pickImportFile}>⬇️ Import Backup…</button>
      </div>
      <input ref={fileInputRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={handleFileChosen} />
      {status && <div className="toast-success">{status}</div>}
    </div>
  );
}
