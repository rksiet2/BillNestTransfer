import React, { useEffect, useState } from 'react';
import { APP_NAME } from '../../constants/brand';

// Shown instead of the whole app when this Host install's license is
// missing/invalid/expired/bound to a different machine (see
// electron/licensing.cjs + electron/main.cjs). A Client terminal or the
// mobile/web fallback never reaches this screen — their getLicenseStatus()
// always resolves { valid: true } (see webApi.js / remoteApi.js /
// preload-client.cjs), so this only ever appears on an unlicensed
// Host/standalone desktop install.
export default function ActivationScreen({ status }) {
  const [machineId, setMachineId] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    window.api.getMachineId().then(setMachineId).catch(() => setMachineId(''));
  }, []);

  function copyMachineId() {
    navigator.clipboard?.writeText(machineId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  async function handleActivate() {
    setError('');
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Please paste the license code you received.');
      return;
    }
    setBusy(true);
    try {
      await window.api.activateLicense(trimmed);
      // Relaunch so the exact same startup sequence re-runs cleanly with the
      // database/LAN server/backups etc. now unlocked, instead of trying to
      // hot-initialize a running process.
      await window.api.relaunchAfterActivation();
    } catch (e) {
      setError(e.message || 'Activation failed. Please check the code and try again.');
      setBusy(false);
    }
  }

  const reasonText = (() => {
    if (!status || status.reason === 'NOT_ACTIVATED') return `This copy of ${APP_NAME} hasn't been activated yet.`;
    if (status.reason === 'MACHINE_MISMATCH') return 'This license is bound to a different computer. Contact your vendor for a new license for this machine.';
    if (status.reason === 'EXPIRED') return `This license expired on ${status.expiresAt ? new Date(status.expiresAt).toLocaleDateString() : 'an earlier date'}. Contact your vendor to renew it.`;
    if (status.reason === 'CORRUPTED') return 'The license file on this computer appears to be corrupted or invalid.';
    return `This copy of ${APP_NAME} needs to be activated before it can be used.`;
  })();

  return (
    <div className="activation-screen">
      <div className="activation-card">
        <h1>🔒 Activation Required</h1>
        <p className="activation-reason">{reasonText}</p>

        <div className="activation-section">
          <label>Your Machine ID</label>
          <div className="activation-machine-id-row">
            <code className="activation-machine-id">{machineId || 'Loading…'}</code>
            <button type="button" className="btn-secondary" onClick={copyMachineId} disabled={!machineId}>
              {copied ? '✅ Copied' : '📋 Copy'}
            </button>
          </div>
          <p className="activation-hint">Send this Machine ID to your vendor to receive your license code.</p>
        </div>

        <div className="activation-section">
          <label htmlFor="license-code">License Code</label>
          <textarea
            id="license-code"
            rows={4}
            placeholder="Paste the license code you received here…"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={busy}
          />
        </div>

        {error && <p className="activation-error">⚠️ {error}</p>}

        <button type="button" className="btn-primary activation-submit" onClick={handleActivate} disabled={busy}>
          {busy ? 'Activating…' : 'Activate'}
        </button>
      </div>
    </div>
  );
}
