import React, { useState, useEffect } from 'react';
import billnestMark from '../../assets/billnest-mark.png';
import { APP_NAME } from '../../constants/brand';

// Only background look: Icon Bokeh — floating hospitality icons drifting
// upward. (Gradient Waves / Glass Blobs / Parallax Depth were preview-only
// alternatives and have been removed now that Icon Bokeh was picked.)

// Detects which "Forgot PIN" flow this build supports: desktop sends a real
// email OTP (electron/preload.cjs exposes requestPinResetOtp); the mobile
// demo build has no backend to send email from, so it falls back to the
// one-time recovery code shown at setup (verifyRecoveryCodeAndResetPin).
const HAS_EMAIL_OTP = typeof window !== 'undefined' && !!window.api?.requestPinResetOtp;

// Full-screen PIN lock shown at every app launch (and after "Switch User").
// Fully offline — validated against the local users table via userService.cjs.
// No username list is shown at this screen by design, so staff PINs stay
// private from one another; whoever's PIN matches simply logs in as them.
export default function LoginScreen({ onLogin }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  function press(digit) {
    if (pin.length >= 6) return;
    setError('');
    setPin((p) => p + digit);
  }

  function backspace() {
    setError('');
    setPin((p) => p.slice(0, -1));
  }

  async function submit(pinValue) {
    if (!pinValue || pinValue.length < 4) {
      setError('Enter your 4-6 digit PIN.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const user = await window.api.loginWithPin(pinValue);
      if (!user) {
        setError('Incorrect PIN. Please try again.');
        setPin('');
      } else {
        // onLogin can veto a PIN that authenticated fine but isn't allowed to
        // use THIS device right now (e.g. a Staff PIN on a phone before the
        // Owner has enabled Captain/Waiter App) — it returns an error string
        // instead of logging in when that happens.
        const rejection = onLogin(user);
        if (rejection) {
          setError(rejection);
          setPin('');
        }
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeypadSubmit() {
    submit(pin);
  }

  // PINs can be 4-6 digits, so we can't auto-submit at every possible length
  // — but once the 6-digit maximum is reached there's nothing left to type,
  // so auto-unlock immediately instead of making the user tap "Unlock" too.
  useEffect(() => {
    if (pin.length === 6 && !submitting) {
      submit(pin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  return (
    <div className="login-screen" data-bg="icons">
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

      <div className="login-card">
        <img src={billnestMark} alt={APP_NAME} className="login-logo-mark" />
        <h2 className="brand-wordmark"><span className="brand-bill">Bill</span><span className="brand-nest">Nest</span></h2>
        <p className="brand-tagline">— Smart Billing for Smart Businesses —</p>
        <p className="settings-sub">Enter your PIN to continue</p>

        <div className="pin-dots">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} className={`pin-dot ${i < pin.length ? 'filled' : ''}`} />
          ))}
        </div>

        {error && <div className="form-error" style={{ textAlign: 'center' }}>{error}</div>}

        <div className="pin-keypad">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
            <button key={n} type="button" onClick={() => press(String(n))} disabled={submitting}>{n}</button>
          ))}
          <button type="button" className="pin-key-clear" onClick={() => setPin('')} disabled={submitting}>Clear</button>
          <button type="button" onClick={() => press('0')} disabled={submitting}>0</button>
          <button type="button" className="pin-key-back" onClick={backspace} disabled={submitting}>⌫</button>
        </div>

        <button className="btn btn-primary login-submit" onClick={handleKeypadSubmit} disabled={submitting || pin.length < 4}>
          {submitting ? 'Checking…' : 'Unlock'}
        </button>

        <button type="button" className="btn-link forgot-pin-link" onClick={() => setForgotOpen(true)}>
          Forgot PIN?
        </button>
      </div>

      {forgotOpen && <ForgotPinModal onClose={() => setForgotOpen(false)} onReset={() => { setForgotOpen(false); setPin(''); setError(''); }} />}
    </div>
  );
}

// Owner-only "Forgot PIN" recovery. Desktop sends a real email OTP (Node's
// SMTP client — see db/mailer.cjs); the mobile demo build instead asks for
// the one-time recovery code shown once at setup, since there's no backend
// here to send real email from.
function ForgotPinModal({ onClose, onReset }) {
  const [stage, setStage] = useState(HAS_EMAIL_OTP ? 'request' : 'code'); // 'request' | 'code' | 'done'
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSendOtp() {
    setBusy(true);
    setError('');
    try {
      const { sentTo } = await window.api.requestPinResetOtp();
      setSentTo(sentTo);
      setStage('code');
    } catch (err) {
      setError(err.message || 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(e) {
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
    setBusy(true);
    try {
      if (HAS_EMAIL_OTP) {
        await window.api.verifyPinResetOtp(code.trim(), newPin);
      } else {
        await window.api.verifyRecoveryCodeAndResetPin(code.trim(), newPin);
      }
      setStage('done');
    } catch (err) {
      setError(err.message || 'Could not reset PIN.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 380 }}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h3>🔐 Forgot PIN?</h3>

        {stage === 'request' && (
          <>
            <p className="settings-sub">
              We'll email a one-time code to the Owner's recovery Gmail configured in Settings.
            </p>
            {error && <div className="form-error">{error}</div>}
            <div className="fm-form-actions">
              <button type="button" className="btn btn-primary" onClick={handleSendOtp} disabled={busy}>
                {busy ? 'Sending…' : 'Send Code to Email'}
              </button>
            </div>
          </>
        )}

        {stage === 'code' && (
          <form onSubmit={handleVerify} className="fm-form">
            {sentTo && <p className="settings-sub">Code sent to {sentTo}. It expires in 10 minutes.</p>}
            {!HAS_EMAIL_OTP && (
              <p className="settings-sub">Enter the recovery code you saved when you first set up the Owner account.</p>
            )}
            <label>
              {HAS_EMAIL_OTP ? 'Enter the 6-digit code' : 'Recovery Code'}
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={HAS_EMAIL_OTP ? '123456' : 'XXXX-XXXX'}
                autoFocus
                required
              />
            </label>
            <label>
              New PIN (4-6 digits)
              <input type="password" inputMode="numeric" maxLength={6} value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))} required />
            </label>
            <label>
              Confirm New PIN
              <input type="password" inputMode="numeric" maxLength={6} value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))} required />
            </label>
            {error && <div className="form-error">{error}</div>}
            <div className="fm-form-actions">
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Resetting…' : 'Reset PIN'}</button>
            </div>
          </form>
        )}

        {stage === 'done' && (
          <>
            <p className="toast-success">✅ Your PIN has been reset. You can log in with it now.</p>
            <div className="fm-form-actions">
              <button type="button" className="btn btn-primary" onClick={onReset}>Back to Login</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
