import React, { useEffect, useState } from 'react';
import SettingsForm from './SettingsForm';
import ManageStaffSection from './ManageStaffSection';
import IntegrationsSection from './IntegrationsSection';
import WhatsAppSection from './WhatsAppSection';
import BackupSection from './BackupSection';
import PinRecoverySection from './PinRecoverySection';
import FeaturesSection from './FeaturesSection';
import MobileConnectionSection from './MobileConnectionSection';
import MobileFactoryResetSection from './MobileFactoryResetSection';
import LicenseInfoSection from './LicenseInfoSection';
import PrinterSettingsSection from './PrinterSettingsSection';

class SettingsErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error('Settings page failed to render:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="settings-section settings-error-boundary" role="alert">
        <h2>Settings could not be opened</h2>
        <p>Close and reopen Settings. If the problem continues, reload the app.</p>
        <code>{this.state.error.message || 'Unknown Settings error'}</code>
        <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>
          Reload app
        </button>
      </div>
    );
  }
}

export default function SettingsPage({ currentUser, licenseStatus }) {
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(false);

  // Which modules THIS INSTALL's license unlocks — see App.jsx. Defaults to
  // both when no payload is present (mobile/client/browser builds never
  // carry one, and older licenses issued before this feature existed are
  // treated as unrestricted).
  const licensedModules = licenseStatus?.payload?.modules || ['food', 'rooms'];
  const showFood = licensedModules.includes('food');
  const showRooms = licensedModules.includes('rooms');

  useEffect(() => {
    window.api.getSettings().then(setSettings);
    // FeaturesSection toggles save+dispatch independently of this page's own
    // handleSave, so listen here too — otherwise this page's own `settings`
    // state (used by SettingsForm etc.) would go stale until a full reopen.
    const refresh = () => window.api.getSettings().then(setSettings);
    window.addEventListener('billnest:settings-updated', refresh);
    return () => window.removeEventListener('billnest:settings-updated', refresh);
  }, []);

  async function handleSave(values) {
    const updated = await window.api.saveSettings(values);
    setSettings(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
    // Let other already-mounted screens (e.g. the Cart's UPI QR box, the
    // topbar hotel name) know settings changed so they refetch instead of
    // showing stale data for the rest of the session.
    window.dispatchEvent(new CustomEvent('billnest:settings-updated', { detail: updated }));
  }

  return (
    <SettingsErrorBoundary>
    <div className="settings-page">
      <header className="settings-hero">
        <div className="settings-hero-icon">⚙️</div>
        <div>
          <span className="settings-eyebrow">WORKSPACE CONTROL CENTRE</span>
          <h1>Settings</h1>
          <p>Set up your business, devices, printing, messaging and data protection in one place.</p>
        </div>
      </header>
      <nav className="settings-quick-nav" aria-label="Settings sections">
        <a href="#business-details">🏢 Business</a>
        <a href="#connections">📱 Devices</a>
        <a href="#whatsapp">💬 WhatsApp</a>
        <a href="#printer-settings">🖨️ Printing</a>
        <a href="#data-security">🛡️ Data &amp; security</a>
      </nav>
      <div className="settings-section">
        <span id="business-details" className="settings-anchor" />
        <h2>Business Details</h2>
        {settings && <SettingsForm initial={settings} mode="edit" onSave={handleSave} showFood={showFood} showRooms={showRooms} />}
        {saved && <div className="toast-success">✅ Settings saved.</div>}
      </div>

      <ManageStaffSection />
      <FeaturesSection />
      <div id="connections" className="settings-anchor-section"><MobileConnectionSection /></div>
      <PinRecoverySection currentUser={currentUser} />
      <div id="data-security" className="settings-anchor-section"><BackupSection /></div>
      <IntegrationsSection />
      <div id="whatsapp" className="settings-anchor-section"><WhatsAppSection /></div>
      <div id="printer-settings" className="settings-anchor-section"><PrinterSettingsSection settings={settings || {}} onSave={handleSave} /></div>

      <LicenseInfoSection licenseStatus={licenseStatus} />

      {typeof window.api?.openRecordsFolder === 'function' && (
      <div className="settings-section">
        <h2>📁 Files & Records</h2>
        <div className="settings-extra">
          <button className="btn btn-secondary" onClick={() => window.api.openRecordsFolder()}>
            📁 Open "Bill Records" Folder
          </button>
          <button className="btn btn-secondary" onClick={() => window.api.openKotRecordsFolder()}>
            🧑‍🍳 Open "KOT Records" Folder
          </button>
        </div>
      </div>
      )}

      <MobileFactoryResetSection />
    </div>
    </SettingsErrorBoundary>
  );
}
