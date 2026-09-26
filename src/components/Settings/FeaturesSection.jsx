import React, { useEffect, useState } from 'react';
import { APP_NAME } from '../../constants/brand';
import { getRemoteConfig } from '../../mobile/remoteConfig';

// Opt-in feature toggles for the multi-tenant/SaaS roadmap. Every install
// starts with all of these OFF so a plain single-counter restaurant sees no
// UI change; the Owner can enable them here per-install. Once BillNest is
// cloud-hosted for multiple customers, these same flags become per-customer
// plan/license settings instead of a manual toggle — the app code doesn't
// need to change, only where the flag value comes from.
//
// `dependsOn`: Captain/Waiter App is NOT standalone — a waiter's phone has
// nothing to attach an order to without Table Management, and no counter to
// actually reach without Multi-Terminal Sync (Host) running. So its toggle
// stays locked until both of those are already ON, and turning either of
// those back OFF auto-disables Captain App too (see toggle() below) instead
// of silently leaving it in a broken half-enabled state.
const FEATURES = [
  {
    key: 'feature_table_management',
    label: '🍽️ Table / Area Management',
    description: 'Assign orders to dine-in tables/areas instead of just counter billing.',
    dependsOn: [],
  },
  {
    key: 'feature_multi_terminal_sync',
    label: '🔗 Counter connection',
    description: 'Choose a Host counter and connect other counters to the same live orders and tables.',
    dependsOn: [],
  },
  {
    key: 'feature_captain_app',
    label: '🧑‍🍳 Captain / Waiter App',
    description: 'Let Staff PINs log in from a connected phone/browser as Captain/Waiter (tables + order-taking only). The Owner PIN always has full access on any connected device regardless of this toggle.',
    dependsOn: ['feature_table_management', 'feature_multi_terminal_sync'],
  },
];

const LABEL_BY_KEY = Object.fromEntries(FEATURES.map((f) => [f.key, f.label.replace(/^\S+\s/, '')]));

export default function FeaturesSection() {
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.api.getSettings().then(setSettings);
  }, []);

  async function toggle(feature) {
    const next = settings[feature.key] === 'true' ? 'false' : 'true';
    const partial = { [feature.key]: next };
    // Turning a dependency OFF must also turn off anything that depends on
    // it, so we never end up with e.g. Captain App "on" but Table
    // Management "off" underneath it.
    if (next === 'false') {
      for (const f of FEATURES) {
        if (f.dependsOn.includes(feature.key) && settings[f.key] === 'true') partial[f.key] = 'false';
      }
    }
    const updated = await window.api.saveSettings(partial);
    setSettings(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    window.dispatchEvent(new CustomEvent('billnest:settings-updated', { detail: updated }));
  }

  if (!settings) return null;

  return (
    <div className="settings-section features-section">
      <h3>🚀 Features</h3>
      <p className="settings-sub">
        Optional modules for scaling operations.
      </p>
      <div className="features-list">
        {FEATURES.map((f) => {
          const missingDeps = f.dependsOn.filter((dep) => settings[dep] !== 'true');
          const locked = missingDeps.length > 0;
          return (
            <div key={f.key} className={`feature-toggle-row ${locked ? 'feature-locked' : ''}`}>
              <div className="feature-toggle-text">
                <span className="feature-toggle-label">{f.label}</span>
                <span className="feature-toggle-desc">
                  {locked
                    ? `🔒 Requires ${missingDeps.map((d) => LABEL_BY_KEY[d]).join(' + ')} enabled first.`
                    : f.description}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings[f.key] === 'true'}
                className={`toggle-switch ${settings[f.key] === 'true' ? 'on' : ''}`}
                disabled={locked}
                onClick={() => toggle(f)}
              >
                <span className="toggle-switch-knob" />
              </button>
            </div>
          );
        })}
      </div>
      {saved && <div className="toast-success">✅ Feature setting saved.</div>}
      {settings.feature_multi_terminal_sync === 'true' && <SyncConfigPanel />}
    </div>
  );
}

// Only rendered once "Multi-Terminal Sync" is switched on above. Lets the
// Owner pick this device's role:
//  - Host: the one device holding the real database + running the LAN
//    server. Its own LAN IP is shown so other devices can be pointed at it.
//  - Client: every other counter/device — just needs the Host's IP typed in
//    once. A "Test Connection" button hits the Host's /health endpoint
//    directly from this device, so a wrong IP/unplugged-router problem is
//    caught immediately instead of during actual billing.
//
// Role/host-ip/port are per-DEVICE config, deliberately kept separate from
// the shared hotel `settings` (see electron/syncConfig.cjs) — a Client's own
// role must always be readable/writable locally, even though every other
// settings call on a Client device is transparently forwarded to the Host.
function SyncConfigPanel() {
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const supported = window.api.getSyncConfig != null;

  useEffect(() => {
    if (!supported) return;
    window.api.getSyncConfig().then(setConfig);
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const load = () => window.api.getSyncStatus().then((s) => { if (!cancelled) setStatus(s); });
    load();
    const id = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [supported, config?.role]);

  async function saveAndRestart(partial) {
    const updated = await window.api.saveSyncConfig(partial);
    setConfig(updated);
    // On mobile (no live server process), just reload so main.jsx re-bootstraps
    // with the new mode. On desktop, restartSync hot-restarts the LAN server.
    if (window.api.restartSync) {
      const s = await window.api.restartSync();
      setStatus((prev) => ({ ...prev, ...s }));
    } else {
      window.location.reload();
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const port = config.port || '4001';
      const res = await fetch(`http://${config.hostIp}:${port}/health`, {
        method: 'GET', headers: { 'X-BillNest-Token': config.authToken || '' },
      });
      const data = await res.json();
      setTestResult({ ok: true, hotelName: data.hotelName });
    } catch {
      setTestResult({ ok: false, error: 'Could not reach that address. Check the IP, port, and that both devices are on the same WiFi.' });
    } finally {
      setTesting(false);
    }
  }

  if (!supported) {
    const remoteMode = typeof window !== 'undefined' ? getRemoteConfig().mode : 'LOCAL';
    const isHost = remoteMode === 'HOST_DEVICE';
    return (
      <div className="sync-panel">
        <p className="settings-sub">
          {isHost
            ? 'ℹ️ This tablet is set as the Host. Other phones can connect to it via Settings → Counter Mode. Multi-Terminal Sync role is managed automatically.'
            : `ℹ️ Multi-Terminal Sync is configured from the main counter. Open ${APP_NAME} on the Host counter to set it up; this device can then join as a Client from its own Settings → Counter Mode screen.`}
        </p>
      </div>
    );
  }

  if (!config) return null;

  return (
    <div className="sync-panel">
      <h4>🔗 Counter connection setup</h4>
      <div className="sync-role-row">
        <label>
          <input
            type="radio"
            name="sync_role"
            checked={config.role === 'HOST'}
            onChange={() => saveAndRestart({ role: 'HOST' })}
          />
          This is the Host (main counter — holds the shared data)
        </label>
        <label>
          <input
            type="radio"
            name="sync_role"
            checked={config.role === 'CLIENT'}
            onChange={() => saveAndRestart({ role: 'CLIENT' })}
          />
          This is a Client (connects to another counter's Host)
        </label>
      </div>

      {config.role === 'HOST' && (
        <div className="sync-host-info">
          <p>
            Other counters should connect to: <strong>{status?.ip || '…'}:{status?.port || config.port || '4001'}</strong>
          </p>
          <label className="sync-field-label">
            Shared access key (give this only to approved BillNest devices)
            <input type="text" value={config.authToken || ''} readOnly />
          </label>
          <p className="settings-sub">
            Server status: {status?.running ? '🟢 Running' : '🔴 Not running'}
          </p>
          {!status?.running && status?.error && (
            <p className="settings-sub" style={{ color: '#b91c1c' }}>
              ⚠️ {status.error}
            </p>
          )}
        </div>
      )}

      {config.role === 'CLIENT' && (
        <div className="sync-client-info">
          <label className="sync-field-label">
            Host IP address
            <input
              type="text"
              placeholder="e.g. 192.168.1.5"
              value={config.hostIp}
              onChange={(e) => setConfig({ ...config, hostIp: e.target.value })}
              onBlur={(e) => saveAndRestart({ hostIp: e.target.value })}
            />
          </label>
          <label className="sync-field-label">
            Port
            <input
              type="text"
              value={config.port}
              onChange={(e) => setConfig({ ...config, port: e.target.value })}
              onBlur={(e) => saveAndRestart({ port: e.target.value })}
            />
          </label>
          <label className="sync-field-label">
            Shared access key
            <input
              type="password"
              value={config.authToken || ''}
              onChange={(e) => setConfig({ ...config, authToken: e.target.value })}
              onBlur={(e) => saveAndRestart({ authToken: e.target.value })}
            />
          </label>
          <button type="button" className="btn-secondary" onClick={testConnection} disabled={testing || !config.hostIp}>
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
          {testResult && (
            <p className={testResult.ok ? 'sync-test-ok' : 'sync-test-fail'}>
              {testResult.ok ? `✅ Connected to "${testResult.hotelName || 'Host'}"` : `❌ ${testResult.error}`}
            </p>
          )}
        </div>
      )}
      <p className="settings-sub">
        ⚠️ After changing the role above, fully close and reopen {APP_NAME} on this device once for it to take effect.
      </p>
    </div>
  );
}
