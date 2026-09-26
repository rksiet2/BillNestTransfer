import React, { useState } from 'react';

// Mobile/standalone counterpart to the desktop "BillNest Reset" tool
// (electron/factoryReset.cjs, a separate .exe + shortcut). A phone can't
// ship a second app icon the same way, so this lives as a normal Settings
// section instead — but only when this phone actually holds its own local
// data. `window.api.factoryReset` only exists on the mobile/webApi.js build
// in Standalone mode (see src/main.jsx's bootstrap): it's absent both in
// Electron (desktop uses the separate tool) and in "Connect to a Counter"
// mode (remoteApi.js has nothing local to wipe — that reset must happen on
// the Host itself).
const SUPPORTED = typeof window !== 'undefined' && typeof window.api?.factoryReset === 'function';

export default function MobileFactoryResetSection() {
  const [confirmText, setConfirmText] = useState('');
  const [ownerPin, setOwnerPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (!SUPPORTED) return null;

  async function handleReset(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await window.api.factoryReset({ confirmText, ownerPin });
      setDone(true);
    } catch (err) {
      setError(err.message || 'Could not reset app data.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="settings-section">
        <h3>♻️ Reset App Data</h3>
        <p className="toast-success">✅ This phone's data has been reset to a fresh install.</p>
        <div className="settings-extra">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload App
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h3>♻️ Reset App Data</h3>
      <p className="settings-sub">
        Wipes this phone's bills, bookings, purchases/expenses, and all Owner/Staff PINs — the app will
        behave like a fresh install and ask you to set up a new Owner PIN. Your food menu, categories,
        raw materials catalog, and rooms/tables lists are kept (only stock levels and table/room status
        are reset). This cannot be undone.
      </p>
      <form onSubmit={handleReset} className="fm-form" style={{ maxWidth: 420 }}>
        <label>
          Type <strong>RESET</strong> to confirm
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="RESET"
            required
          />
        </label>
        <label>
          Owner PIN
          <input
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={ownerPin}
            onChange={(e) => setOwnerPin(e.target.value.replace(/\D/g, ''))}
            placeholder="Leave blank if no Owner account exists yet"
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="fm-form-actions">
          <button type="submit" className="btn btn-danger" disabled={busy || confirmText.trim().toUpperCase() !== 'RESET'}>
            {busy ? 'Resetting…' : 'Reset This Phone\'s Data'}
          </button>
        </div>
      </form>
    </div>
  );
}
