import React, { useEffect, useState } from 'react';
import SettingsForm from './SettingsForm';
import billnestMark from '../../assets/billnest-mark.png';
import { getRemoteConfig, saveRemoteConfig } from '../../mobile/remoteConfig';
import { testHostConnection } from '../../mobile/remoteApi';
import { APP_NAME } from '../../constants/brand';

// Full-screen wizard shown once on first launch until hotel details are saved.
// Also creates the Owner PIN account here (step 2) so there's a working login
// from the very first run — no separate "add owner" step needed later.
export default function SetupWizard({ onComplete, licenseStatus }) {
  const licensedModules = licenseStatus?.payload?.modules || ['food', 'rooms'];
  const showFood = licensedModules.includes('food');
  const showRooms = licensedModules.includes('rooms');
  const [settings, setSettings] = useState(null);
  // 'mode-select' | 'join' | 'hotel' | 'backup' | 'owner-pin' | 'recovery-email' | 'recovery-code'
  const [step, setStep] = useState('mode-select');
  const [ownerName, setOwnerName] = useState('Owner');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [savedSettings, setSavedSettings] = useState(null);
  const [backupFolder, setBackupFolder] = useState(null);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [recoveryAppPassword, setRecoveryAppPassword] = useState('');
  const [recoveryError, setRecoveryError] = useState('');
  const [recoverySaving, setRecoverySaving] = useState(false);
  const [showAppPasswordHelp, setShowAppPasswordHelp] = useState(false);
  const [joinHostIp, setJoinHostIp] = useState('');
  const [joinPort, setJoinPort] = useState('4001');
  const [joinTesting, setJoinTesting] = useState(false);
  const [joinResult, setJoinResult] = useState(null);
  const [joinConnecting, setJoinConnecting] = useState(false);
  const isDesktop = typeof window !== 'undefined' && !!window.api?.chooseBackupFolder;

  useEffect(() => {
    window.api.getSettings().then(setSettings);
  }, []);

  useEffect(() => {
    if (!isDesktop) {
      const cfg = getRemoteConfig();
      if (cfg.hostIp) setJoinHostIp(cfg.hostIp);
      if (cfg.hostPort) setJoinPort(cfg.hostPort);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSaveHotelDetails(values) {
    const updated = await window.api.saveSettings(values);
    setSavedSettings(updated);
    setBackupFolder(updated.backup_folder || null);
    const alreadyHasOwner = await window.api.hasOwnerAccount();
    if (alreadyHasOwner) {
      onComplete(updated);
    } else if (isDesktop) {
      setStep('backup');
    } else {
      setStep('owner-pin');
    }
  }

  async function handleChooseBackupFolder() {
    const folder = await window.api.chooseBackupFolder();
    if (folder) setBackupFolder(folder);
  }

  function handleContinueFromBackup() {
    setStep('owner-pin');
  }

  async function handleCreateOwnerPin(e) {
    e.preventDefault();
    setPinError('');
    if (!/^\d{4,6}$/.test(pin)) {
      setPinError('PIN must be 4 to 6 digits.');
      return;
    }
    if (pin !== confirmPin) {
      setPinError('PINs do not match.');
      return;
    }
    try {
      const result = await window.api.createOwnerAccount({ name: ownerName || 'Owner', pin });
      if (isDesktop) {
        setStep('recovery-email');
      } else if (result?.recoveryCode) {
        setRecoveryCode(result.recoveryCode);
        setStep('recovery-code');
      } else {
        onComplete(savedSettings);
      }
    } catch (err) {
      setPinError(err.message || 'Could not create owner account.');
    }
  }

  async function handleSaveRecoveryEmail(e) {
    e.preventDefault();
    setRecoveryError('');
    if (!recoveryEmail.trim() || !recoveryAppPassword.trim()) {
      setRecoveryError('Enter both the Gmail address and its App Password, or use "Skip for now".');
      return;
    }
    if (!/^[^\s@]+@gmail\.com$/i.test(recoveryEmail.trim())) {
      setRecoveryError('Only a Gmail address (ending in @gmail.com) can be used to send the recovery code.');
      return;
    }
    setRecoverySaving(true);
    try {
      await window.api.saveSettings({
        recovery_email: recoveryEmail.trim(),
        recovery_app_password: recoveryAppPassword.trim(),
      });
      onComplete(savedSettings);
    } catch (err) {
      setRecoveryError(err.message || 'Could not save recovery email.');
    } finally {
      setRecoverySaving(false);
    }
  }

  function handleSkipRecoveryEmail() {
    onComplete(savedSettings);
  }

  async function handleTestJoinConnection() {
    setJoinTesting(true);
    setJoinResult(null);
    try {
      const data = await testHostConnection(joinHostIp, joinPort || '4001');
      setJoinResult({ ok: true, hotelName: data.hotelName });
    } catch {
      setJoinResult({ ok: false, error: 'Could not reach that address. Check the IP, port, and that both devices are on the same WiFi.' });
    } finally {
      setJoinTesting(false);
    }
  }

  async function handleConnectAndJoin() {
    setJoinConnecting(true);
    try {
      if (isDesktop) {
        // Role/host-ip live in this device's own local-only config (never
        // the shared `settings` table) — see electron/syncConfig.cjs. Every
        // future window this device opens will then use preload-client.cjs
        // instead of preload.cjs (see main.cjs's getPreloadConfig), which
        // transparently proxies hotel details, menu, staff PINs, bills —
        // everything — from the Host, so nothing needs re-entering here.
        await window.api.saveSyncConfig({ role: 'CLIENT', hostIp: joinHostIp, port: joinPort || '4001' });
        await window.api.relaunchApp();
      } else {
        saveRemoteConfig({ mode: 'HOST', hostIp: joinHostIp, hostPort: joinPort || '4001' });
        window.location.reload();
      }
    } catch (err) {
      setJoinResult({ ok: false, error: err.message || 'Could not connect.' });
      setJoinConnecting(false);
    }
  }

  if (!settings) return null;

  return (
    <div className="setup-wizard-overlay">
      <div className="login-bg-layer" aria-hidden="true">
        <span className="bg-icon" style={{ left: '2%', animationDelay: '0s' }}>🛎️</span>
        <span className="bg-icon" style={{ left: '12%', animationDelay: '3.5s' }}>🍴</span>
        <span className="bg-icon" style={{ left: '22%', animationDelay: '2s' }}>🍽️</span>
        <span className="bg-icon" style={{ left: '32%', animationDelay: '5.5s' }}>🧾</span>
        <span className="bg-icon" style={{ left: '42%', animationDelay: '4s' }}>🛏️</span>
        <span className="bg-icon" style={{ left: '52%', animationDelay: '1s' }}>🔑</span>
        <span className="bg-icon" style={{ left: '62%', animationDelay: '6s' }}>☕</span>
        <span className="bg-icon" style={{ left: '72%', animationDelay: '3s' }}>🛎️</span>
        <span className="bg-icon" style={{ left: '82%', animationDelay: '0.5s' }}>🍽️</span>
        <span className="bg-icon" style={{ left: '92%', animationDelay: '2.5s' }}>🧾</span>
        <span className="bg-icon" style={{ left: '7%', animationDelay: '7s' }}>🔑</span>
        <span className="bg-icon" style={{ left: '27%', animationDelay: '8.5s' }}>☕</span>
        <span className="bg-icon" style={{ left: '47%', animationDelay: '9.5s' }}>🍴</span>
        <span className="bg-icon" style={{ left: '67%', animationDelay: '7.5s' }}>🛏️</span>
        <span className="bg-icon" style={{ left: '87%', animationDelay: '10s' }}>🍽️</span>
        <span className="bg-icon" style={{ left: '17%', animationDelay: '4.5s' }}>🤖</span>
        <span className="bg-icon" style={{ left: '57%', animationDelay: '9s' }}>🤖</span>
      </div>
      <div className="setup-wizard-card">
        <div className="setup-wizard-brand">
          <img src={billnestMark} alt={APP_NAME} className="setup-wizard-logo" />
          <div>
            <span className="brand-wordmark small"><span className="brand-bill">Bill</span><span className="brand-nest">Nest</span></span>
            <div className="brand-tagline small">Smart Billing for Smart Businesses</div>
          </div>
        </div>
        {step === 'mode-select' && (
          <>
            <h2>👋 Welcome to {APP_NAME}</h2>
            <p className="settings-sub">How should this device be set up?</p>
            <div className="setup-mode-choices">
              <button type="button" className="setup-mode-card" onClick={() => setStep('hotel')}>
                <span className="setup-mode-header">
                  <span className="setup-mode-icon">✨</span>
                  <span className="setup-mode-title">New Hotel Setup</span>
                </span>
                <span className="setup-mode-desc">
                  First device for this property. Enter hotel details and create the Owner PIN.
                </span>
              </button>
              <button type="button" className="setup-mode-card" onClick={() => setStep('join')}>
                <span className="setup-mode-header">
                  <span className="setup-mode-icon">🔗</span>
                  <span className="setup-mode-title">Join an Existing Setup</span>
                </span>
                <span className="setup-mode-desc">
                  Add another counter or Captain/Waiter device to your existing hotel setup on this
                  WiFi. Your hotel details, menu, and staff PINs carry over automatically.
                </span>
              </button>
            </div>
          </>
        )}

        {step === 'join' && (
          <>
            <h2>🔗 Join an Existing Setup</h2>
            <p className="settings-sub">
              Connects this device to another counter's live data over WiFi — that counter must have
              Multi-Terminal Sync turned on and set as "Host" (Settings &gt; Features).
            </p>
            <label className="sync-field-label">
              Host counter's IP address
              <input
                type="text"
                placeholder="e.g. 192.168.1.5"
                value={joinHostIp}
                onChange={(e) => { setJoinHostIp(e.target.value); setJoinResult(null); }}
              />
            </label>
            <label className="sync-field-label">
              Port
              <input type="text" value={joinPort} onChange={(e) => setJoinPort(e.target.value)} />
            </label>
            {joinResult && (
              <p className={joinResult.ok ? 'sync-test-ok' : 'sync-test-fail'}>
                {joinResult.ok ? `✅ Connected to "${joinResult.hotelName || 'Host'}"` : `❌ ${joinResult.error}`}
              </p>
            )}
            <div className="fm-form-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setStep('mode-select')} disabled={joinConnecting}>
                Back
              </button>
              <button type="button" className="btn btn-secondary" onClick={handleTestJoinConnection} disabled={joinTesting || !joinHostIp || joinConnecting}>
                {joinTesting ? 'Testing…' : 'Test Connection'}
              </button>
              <button type="button" className="btn btn-primary" onClick={handleConnectAndJoin} disabled={!joinHostIp || joinConnecting}>
                {joinConnecting ? 'Connecting…' : 'Connect & Finish'}
              </button>
            </div>
          </>
        )}

        {step === 'hotel' && (
          <>
            <h2>👋 Let's set up your Business🏨</h2>
            <SettingsForm initial={settings} mode="setup" onSave={handleSaveHotelDetails} showFood={showFood} showRooms={showRooms} />
          </>
        )}

        {step === 'backup' && (
          <>
            <h2>💾 Where should we keep a backup?</h2>
            <p className="settings-optional-tag">Optional, but recommended</p>
            <p className="settings-sub">
              Select a Google Drive-synced folder for automatic, off-device protection — changeable
              anytime from Settings.
            </p>
            <p className="settings-hint">
              💡 Recommended: a folder named <code>{APP_NAME} Backups</code> inside Google Drive. If this
              PC is replaced, sign into the same Google account on the new one and restore from there.
            </p>
            <div className="settings-row backup-folder-row" style={{ maxWidth: 420 }}>
              <div>
                <strong>Backup folder:</strong>{' '}
                {backupFolder ? <code>{backupFolder}</code> : <em>Not set</em>}
              </div>
              <button type="button" className="btn btn-secondary btn-small" onClick={handleChooseBackupFolder}>
                📁 {backupFolder ? 'Change Folder' : 'Choose Folder'}
              </button>
            </div>
            <div className="fm-form-actions">
              <button type="button" className="btn btn-secondary" onClick={handleContinueFromBackup}>Skip for now</button>
              <button type="button" className="btn btn-primary" onClick={handleContinueFromBackup}>Continue</button>
            </div>
          </>
        )}

        {step === 'owner-pin' && (
          <>
            <h2>🔐 Create your Owner PIN</h2>
            <p className="settings-sub">
              The Owner PIN grants full access — Billing, Reporting, Settings and Menu/Room setup. Staff
              PINs can be added later from Settings, with access restricted to Food or Room billing as needed.
            </p>
            <form onSubmit={handleCreateOwnerPin} className="fm-form">
              <label>
                Your Name
                <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="e.g. Rajesh (Owner)" required />
              </label>
              <div className="settings-row">
                <label>
                  Choose a PIN (4-6 digits)
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                    placeholder="e.g. 1234"
                    required
                  />
                </label>
                <label>
                  Confirm PIN
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    value={confirmPin}
                    onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                    placeholder="Re-enter PIN"
                    required
                  />
                </label>
              </div>
              {pinError && <div className="form-error">{pinError}</div>}
              <div className="fm-form-actions">
                <button type="submit" className="btn btn-primary">
                  Create Owner PIN &amp; {isDesktop ? 'Continue' : 'Finish Setup'}
                </button>
              </div>
            </form>
          </>
        )}

        {step === 'recovery-email' && (
          <>
            <h2>📧 Set Up PIN Recovery</h2>
            <p className="settings-optional-tag">Optional, but strongly recommended</p>
            <p className="settings-sub">
              Enables a one-time email reset code if the Owner PIN is forgotten. If skipped, "Forgot PIN?"
              remains unavailable until configured later in Settings.
            </p>
            <form onSubmit={handleSaveRecoveryEmail} className="fm-form">
              <label>
                Recovery Gmail Address
                <input
                  type="email"
                  value={recoveryEmail}
                  onChange={(e) => setRecoveryEmail(e.target.value)}
                  placeholder="youraddress@gmail.com"
                />
              </label>
              <label className="label-with-help">
                Gmail App Password
                <button
                  type="button"
                  className="help-question-btn"
                  onClick={() => setShowAppPasswordHelp((v) => !v)}
                  title="How do I get this?"
                  aria-label="How do I get this?"
                >?</button>
              </label>
              <input
                type="password"
                value={recoveryAppPassword}
                onChange={(e) => setRecoveryAppPassword(e.target.value)}
                placeholder="16-character app password"
              />
              {showAppPasswordHelp && (
                <div className="help-panel">
                  <strong>How to get your 16-character App Password (takes 2 minutes):</strong>
                  <ol>
                    <li>Open a browser and go to <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a>, and sign in with the Gmail address above.</li>
                    <li>If it asks you to "turn on 2-Step Verification" first, tap that and follow the on-screen steps (usually just confirming with your phone).</li>
                    <li>Back on the App Passwords page, type any name like <em>{APP_NAME}</em> and tap <strong>Create</strong>.</li>
                    <li>Google will show you a code made of 16 letters, like <code>abcd efgh ijkl mnop</code>. Copy it.</li>
                    <li>Paste it into the box above (spaces don't matter) — this is <em>not</em> your normal Gmail password, it only works for this one purpose and you can cancel it anytime from that same Google page.</li>
                  </ol>
                </div>
              )}
              {recoveryError && <div className="form-error">{recoveryError}</div>}
              <div className="fm-form-actions">
                <button type="button" className="btn btn-secondary" onClick={handleSkipRecoveryEmail} disabled={recoverySaving}>
                  Skip for now
                </button>
                <button type="submit" className="btn btn-primary" disabled={recoverySaving}>
                  {recoverySaving ? 'Saving…' : 'Save & Finish Setup'}
                </button>
              </div>
            </form>
          </>
        )}

        {step === 'recovery-code' && (
          <>
            <h2>🔑 Save your Recovery Code</h2>
            <p className="settings-sub">
              If you ever forget your Owner PIN, this code is the only way to reset it on this device.
              <strong> It will not be shown again</strong> — write it down or take a screenshot now.
            </p>
            <div className="recovery-code-box">{recoveryCode}</div>
            <div className="fm-form-actions">
              <button type="button" className="btn btn-primary" onClick={() => onComplete(savedSettings)}>
                I've saved it — Finish Setup
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
