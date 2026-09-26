import React, { useEffect, useState } from 'react';
import { APP_NAME } from '../../constants/brand';

// Owner-only: self-service "Change My PIN" (both platforms) plus, on
// desktop, the recovery email/App Password used to send a "Forgot PIN" OTP.
// Mobile has no backend to send real email from, so its Forgot PIN fallback
// is the one-time recovery code shown at setup instead (nothing to configure
// here for that).
const IS_DESKTOP = typeof window !== 'undefined' && !!window.api?.requestPinResetOtp;

export default function PinRecoverySection({ currentUser }) {
  return (
    <div className="settings-section pin-recovery-section">
      <h3>🔐 PIN &amp; Recovery</h3>
      {IS_DESKTOP && <RecoveryEmailForm />}
      <ChangePinForm currentUser={currentUser} />
    </div>
  );
}

function RecoveryEmailForm() {
  const [email, setEmail] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    window.api.getSettings().then((s) => {
      setEmail(s.recovery_email || '');
      setAppPassword(s.recovery_app_password || '');
    });
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    await window.api.saveSettings({ recovery_email: email.trim(), recovery_app_password: appPassword.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  return (
    <form onSubmit={handleSave} className="fm-form" style={{ maxWidth: 420, marginBottom: 20 }}>
      <p className="settings-sub">
        Sends a one-time reset code here if the Owner PIN is forgotten. Needs a Gmail{' '}
        <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">App Password</a>
        {' '}— stored only on this device.
      </p>
      <label>
        Recovery Gmail Address
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" />
      </label>
      <label className="label-with-help">
        Gmail App Password
        <button
          type="button"
          className="help-question-btn"
          onClick={() => setShowHelp((v) => !v)}
          title="How do I get this?"
          aria-label="How do I get this?"
        >?</button>
      </label>
      <input type="password" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} placeholder="16-character app password" />
      {showHelp && (
        <div className="help-panel">
          <strong>How to get your 16-character App Password (takes 2 minutes):</strong>
          <ol>
            <li>Open a browser and go to <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a>, and sign in with the Gmail account above.</li>
            <li>If it asks you to "turn on 2-Step Verification" first, tap that and follow the on-screen steps (usually just confirming with your phone).</li>
            <li>Back on the App Passwords page, type any name like <em>{APP_NAME}</em> and tap <strong>Create</strong>.</li>
            <li>Google will show you a code made of 16 letters, like <code>abcd efgh ijkl mnop</code>. Copy it.</li>
            <li>Paste it into the box above (spaces don't matter) — this is <em>not</em> your normal Gmail password, it only works for this one purpose and you can cancel it anytime from that same Google page.</li>
          </ol>
        </div>
      )}
      <div className="fm-form-actions fm-form-actions-center">
        <button type="submit" className="btn btn-secondary">Save Recovery Email</button>
      </div>
      {saved && <div className="toast-success">✅ Recovery email saved.</div>}
    </form>
  );
}

function ChangePinForm({ currentUser }) {
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!/^\d{4,6}$/.test(newPin)) {
      setError('New PIN must be 4 to 6 digits.');
      return;
    }
    if (newPin !== confirmPin) {
      setError('New PINs do not match.');
      return;
    }
    try {
      await window.api.changeMyPin(currentUser.id, currentPin, newPin);
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err.message || 'Could not change PIN.');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="fm-form pin-change-form" style={{ maxWidth: 620 }}>
      <h4 style={{ margin: '0 0 4px' }}>Change My PIN</h4>
      <div className="pin-fields-row">
        <label>
          Current PIN
          <input
            type="password" inputMode="numeric" maxLength={6}
            value={currentPin} onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ''))} required
          />
        </label>
        <label>
          New PIN (4-6 digits)
          <input
            type="password" inputMode="numeric" maxLength={6}
            value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))} required
          />
        </label>
        <label>
          Confirm New PIN
          <input
            type="password" inputMode="numeric" maxLength={6}
            value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))} required
          />
        </label>
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="fm-form-actions pin-form-actions-center">
        <button type="submit" className="btn btn-primary">Update PIN</button>
      </div>
      {success && <div className="toast-success">✅ PIN updated.</div>}
    </form>
  );
}
