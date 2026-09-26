import React, { useState, useEffect } from 'react';
import { APP_NAME } from '../../constants/brand';

// Framework-only placeholders for future online-ordering / channel-manager
// integrations. These platforms require official partner-API approval
// (Zomato/Swiggy POS partner program, MMT/Goibibo channel-manager partner
// program) before any real connection is possible — so today this just lets
// the owner store their credentials and flip a toggle ready for later, with
// no live connection made yet. Nothing here calls any external API.
const PLATFORMS = [
  {
    key: 'zomato',
    label: '🍽️ Zomato Order Manager',
    idLabel: 'Zomato Restaurant / Partner ID',
    keyLabel: 'Zomato API Key',
    helpUrl: 'https://www.zomato.com/business/order-manager',
  },
  {
    key: 'swiggy',
    label: '🛵 Swiggy Order Manager',
    idLabel: 'Swiggy Restaurant / Partner ID',
    keyLabel: 'Swiggy API Key',
    helpUrl: 'https://partner.swiggy.com',
  },
  {
    key: 'mmt',
    label: '🏨 MakeMyTrip / Goibibo Channel Manager',
    idLabel: 'MMT/Goibibo Property ID',
    keyLabel: 'Channel Manager API Key',
    helpUrl: 'https://hotels.makemytrip.com',
  },
];

export default function IntegrationsSection() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({});
  const [showHelp, setShowHelp] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.api.getSettings().then((s) => {
      setSettings(s);
      const next = {};
      for (const p of PLATFORMS) {
        next[`${p.key}_enabled`] = s[`${p.key}_enabled`] === 'true';
        next[`${p.key}_partner_id`] = s[`${p.key}_partner_id`] || '';
        next[`${p.key}_api_key`] = s[`${p.key}_api_key`] || '';
      }
      setForm(next);
    });
  }, []);

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSave(e) {
    e.preventDefault();
    const payload = {};
    for (const [k, v] of Object.entries(form)) payload[k] = typeof v === 'boolean' ? String(v) : v;
    const updated = await window.api.saveSettings(payload);
    setSettings(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  if (!settings) return null;

  return (
    <div className="settings-section integrations-section">
      <h3 className="label-with-help">
        🔌 Online Ordering &amp; Channel Integrations
        <button
          type="button"
          className="help-question-btn"
          onClick={() => setShowHelp((v) => !v)}
          title="More about integrations"
          aria-label="More about integrations"
        >?</button>
      </h3>
      <p className="settings-sub">
        Disabled by default; requires partner approval before activation.
      </p>
      {showHelp && (
        <div className="help-panel">
          Connect Zomato, Swiggy, or MakeMyTrip/Goibibo once your property is approved as a partner on
          the respective platform. Credentials can be saved in advance; integrations remain inactive
          until explicitly enabled, so activation is immediate once approval is granted.
        </div>
      )}

      <form onSubmit={handleSave} className="integrations-form">
        {PLATFORMS.map((p) => (
          <div className="integration-card" key={p.key}>
            <div className="integration-card-header">
              <label className="integration-toggle">
                <input
                  type="checkbox"
                  checked={!!form[`${p.key}_enabled`]}
                  onChange={(e) => update(`${p.key}_enabled`, e.target.checked)}
                />
                <span>{p.label}</span>
              </label>
              <span className={`status-badge ${form[`${p.key}_enabled`] ? 'status-active' : 'status-inactive'}`}>
                {form[`${p.key}_enabled`] ? 'Enabled' : 'Not Connected'}
              </span>
            </div>
            <div className="settings-row">
              <label>
                {p.idLabel}
                <input
                  value={form[`${p.key}_partner_id`] || ''}
                  onChange={(e) => update(`${p.key}_partner_id`, e.target.value)}
                  placeholder="e.g. 123456"
                  disabled={!form[`${p.key}_enabled`]}
                />
              </label>
              <label>
                {p.keyLabel}
                <input
                  type="password"
                  value={form[`${p.key}_api_key`] || ''}
                  onChange={(e) => update(`${p.key}_api_key`, e.target.value)}
                  placeholder="Paste key once approved"
                  disabled={!form[`${p.key}_enabled`]}
                />
              </label>
            </div>
            <p className="settings-hint">
              Requires partner approval — apply at{' '}
              <a href={p.helpUrl} target="_blank" rel="noreferrer">{p.helpUrl}</a>. Once approved, paste your
              credentials above and enable this toggle — {APP_NAME} will start checking for new orders/bookings
              automatically every few seconds and notify you to Accept/Reject them.
            </p>
            {form[`${p.key}_enabled`] && window.api.simulateTestOrder && (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={async () => {
                  await window.api.simulateTestOrder(p.key.toUpperCase());
                }}
              >
                🧪 Simulate Test Order (no real API needed)
              </button>
            )}
          </div>
        ))}

        <div className="modal-actions">
          <button type="submit" className="btn btn-primary">Save Integration Settings</button>
        </div>
        {saved && <div className="toast-success">✅ Integration settings saved.</div>}
      </form>
    </div>
  );
}
