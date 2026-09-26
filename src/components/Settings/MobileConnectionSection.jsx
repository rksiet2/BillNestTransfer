import React, { useEffect, useState } from 'react';
import { getRemoteConfig, saveRemoteConfig } from '../../mobile/remoteConfig';
import { testHostConnection, parseHostAddress, describeNetworkError } from '../../mobile/remoteApi';

// Only meaningful on the mobile/web build — lets this phone either stay
// fully standalone (its own on-device data, today's default) or connect to
// a desktop counter's shared live data over WiFi, which is what turns this
// phone into a genuine Captain/Waiter device: it then sees the exact same
// tables/menu/orders as the counter, in real time, using the same LAN sync
// server built for Multi-Terminal Sync (see electron/lanServer.cjs).
const IS_DESKTOP = typeof window !== 'undefined' && !!window.api?.chooseBackupFolder;

export default function MobileConnectionSection() {
  const [config, setConfig] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [hostInfo, setHostInfo] = useState(null);

  useEffect(() => {
    if (!IS_DESKTOP) setConfig(getRemoteConfig());
  }, []);

  useEffect(() => {
    if (!config || config.mode !== 'HOST_DEVICE' || typeof window.api?.getSyncStatus !== 'function') {
      setHostInfo(null);
      return undefined;
    }
    let cancelled = false;
    const load = () => window.api.getSyncStatus()
      .then((status) => { if (!cancelled) setHostInfo(status); })
      .catch(() => { if (!cancelled) setHostInfo(null); });
    load();
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [config?.mode]);

  if (IS_DESKTOP || !config) return null;

  function update(partial) {
    setConfig({ ...config, ...partial });
  }

  // Lets the IP field itself accept a pasted "192.168.1.5:4001" (some
  // Owners share the address that way) without the user needing to split
  // it into the two fields manually — the Port field can still override it.
  function updateHostIp(value) {
    const { hostIp, hostPort } = parseHostAddress(value, config.hostPort || '4001');
    update({ hostIp, hostPort });
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const data = await testHostConnection(config.hostIp, config.hostPort || '4001', config.authToken);
      // The Host advertises `captainEnabled` once its Owner has turned ON
      // Settings > Features > Captain/Waiter App. Connecting itself is never
      // blocked by this — it only affects whether a Staff PIN can log in
      // here afterward (the Owner PIN always gets full access regardless).
      setTestResult({ ok: true, hotelName: data.hotelName, captainEnabled: !!data.captainEnabled });
    } catch (err) {
      setTestResult({ ok: false, error: err.message || describeNetworkError(err, config.hostIp, config.hostPort) });
    } finally {
      setTesting(false);
    }
  }

  function saveAndReload(partial) {
    saveRemoteConfig({ ...config, ...partial });
    // Unlike the desktop app, this is just a webview reload — instant, and
    // simpler than requiring the whole native app to be relaunched.
    window.location.reload();
  }

  return (
    <div className="settings-section">
      <h3 className="label-with-help">
        📡 Counter connection
        <button
          type="button"
          className="help-question-btn"
          onClick={() => setShowHelp((v) => !v)}
          title="More about counter modes"
          aria-label="More about counter modes"
        >?</button>
      </h3>
      <p className="settings-sub">
        Choose whether this device is standalone, the Host sharing live counter data, or a Client connected to a Host.
      </p>
      {showHelp && (
        <div className="help-panel">
          <strong>Standalone:</strong> This device keeps its own data and does not share orders with another counter.<br /><br />
          <strong>Host:</strong> This is the main counter holding the shared data. Keep it open and connected to WiFi while Clients are working.<br /><br />
          <strong>Client:</strong> This device uses the Host's live menu, tables and orders. It needs the Host address, access key and a working WiFi connection.
        </div>
      )}
      <div className="sync-role-row">
        <label>
          <input
            type="radio"
            name="remote_mode"
            checked={config.mode === 'LOCAL'}
            onChange={() => saveAndReload({ mode: 'LOCAL' })}
          />
          Standalone · data stays on this device
        </label>
        <label>
          <input
            type="radio"
            name="remote_mode"
            checked={config.mode === 'HOST_DEVICE'}
            onChange={() => saveAndReload({ mode: 'HOST_DEVICE' })}
          />
          Host · share this counter's live data
        </label>
        <label>
          <input
            type="radio"
            name="remote_mode"
            checked={config.mode === 'CLIENT'}
            onChange={() => update({ mode: 'CLIENT' })}
          />
          Client · connect to a Host counter
        </label>
      </div>

      {config.mode === 'HOST_DEVICE' && (
        <div className="sync-host-info">
          <p>
            <strong>Other devices should connect to this tablet on port {hostInfo?.port || config.hostPort || 4001}.</strong>
          </p>
          <div className="host-address-card">
            <span className="host-address-label">Host address for other devices</span>
            <code>{hostInfo?.ip && hostInfo.ip !== '127.0.0.1' ? `${hostInfo.ip}:${hostInfo.port || config.hostPort || 4001}` : 'Finding this device on WiFi…'}</code>
            <small>{hostInfo?.running ? 'Host server is running' : 'Starting host server…'}</small>
          </div>
          <p className="settings-sub">
            Enter the address shown above in the other phones' “Connect to a Host” field. All devices must be connected to the same WiFi network.
          </p>
          <p className="settings-sub">
            ⚠️ Make sure all devices are connected to the <strong>same WiFi network</strong>.
          </p>
          <label className="sync-field-label">
            Shared access key (give this only to approved BillNest devices)
            <input type="text" value={config.authToken || ''} readOnly />
          </label>
        </div>
      )}

      {config.mode === 'CLIENT' && (
        <div className="sync-client-info">
          <label className="sync-field-label">
            Host device's IP address
            <input
              type="text"
              placeholder="e.g. 192.168.1.5 or 192.168.1.5:4001"
              value={config.hostIp}
              onChange={(e) => updateHostIp(e.target.value)}
            />
          </label>
          <label className="sync-field-label">
            Port
            <input type="text" value={config.hostPort} onChange={(e) => update({ hostPort: e.target.value })} />
          </label>
          <label className="sync-field-label">
            Shared access key
            <input type="password" value={config.authToken || ''} onChange={(e) => update({ authToken: e.target.value })} />
          </label>
          <div className="settings-extra">
            <button type="button" className="btn-secondary" onClick={testConnection} disabled={testing || !config.hostIp}>
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => saveAndReload({ mode: 'CLIENT' })}
              disabled={!config.hostIp}
            >
              Connect &amp; Reload
            </button>
          </div>
          {testResult && (
            testResult.ok ? (
              <>
                <p className="sync-test-ok">✅ Connected to "{testResult.hotelName || 'Host'}"</p>
                {!testResult.captainEnabled && (
                  <p className="sync-test-note">
                    ℹ️ This counter's Owner hasn't turned on Captain/Waiter App yet, so Staff PINs can't log in
                    on this device until they enable it in Settings &gt; Features. The Owner PIN works right away.
                  </p>
                )}
              </>
            ) : (
              <p className="sync-test-fail">❌ {testResult.error}</p>
            )
          )}
        </div>
      )}
    </div>
  );
}
