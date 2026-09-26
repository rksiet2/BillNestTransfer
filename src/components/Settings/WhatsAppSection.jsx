import React, { useEffect, useRef, useState } from 'react';
import { APP_NAME } from '../../constants/brand';
import { isHostDevice } from '../../mobile/remoteConfig';

// Desktop-only (Electron): links the owner's own WhatsApp account (scan a
// QR code, same as WhatsApp Web) to auto-send food-bill / room-booking /
// room-checkout confirmations, plus a throttled festival-greeting broadcast
// to every past customer. Uses the free, open-source Baileys library (see
// electron/whatsapp.cjs) — not Meta's paid Business API — so there's no
// per-message cost or send limit, but the linked number could in theory be
// rate-limited by WhatsApp if used for very high-volume bulk sends.
function hasWhatsAppStatusApi() {
  return typeof window !== 'undefined' && typeof window.api?.getWhatsAppStatus === 'function';
}
function hasFestivalApi() {
  return typeof window !== 'undefined'
    && typeof window.api?.listFestivals === 'function'
    && typeof window.api?.saveFestival === 'function'
    && typeof window.api?.deleteFestival === 'function';
}
function hasSendLogApi() {
  return typeof window !== 'undefined' && typeof window.api?.getWhatsAppSendLog === 'function';
}
function isMobileWhatsAppHandoff() {
  return typeof window !== 'undefined' && (
    (typeof window.Capacitor?.isNativePlatform === 'function' && window.Capacitor.isNativePlatform())
    || (typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent))
  );
}
const ROOM_TEMPLATE_PLACEHOLDERS = [
  ['{guest_name}', 'Guest name'],
  ['{hotel_name}', 'Hotel name'],
  ['{booking_number}', 'Booking ID'],
  ['{check_in}', 'Check-in date'],
  ['{check_out}', 'Check-out date'],
  ['{room}', 'Room / bed'],
  ['{total}', 'Total amount'],
  ['{advance}', 'Amount paid'],
  ['{hotel_phone}', 'Hotel phone'],
  ['{hotel_address}', 'Hotel address / location'],
];
const FOOD_TEMPLATE_PLACEHOLDERS = [
  ['{customer_name}', 'Customer name'],
  ['{business_name}', 'Business name'],
  ['{bill_number}', 'Bill number'],
  ['{total}', 'Bill total'],
];
const DEFAULT_FOOD_TEMPLATE = 'Hi {customer_name}, please find bill {bill_number} from {business_name}. Total: {total}. Thank you!';
const DEFAULT_ROOM_TEMPLATES = {
  whatsapp_room_booking_template: '✅ Hi {guest_name}, Your Booking is Confirmed at {hotel_name} 🎉\n\n📅 Your Booking Details:\n\nBooking ID: {booking_number}\nCheck-in: {check_in}\nCheck-out: {check_out}\nRoom/Bed: {room}\n\nTotal Amount: {total}\nAmount Paid: {advance}\n\n📞 For any queries, please contact the property: {hotel_phone}. You can reply to this message to chat with hotel team directly!\n📍 Location: {hotel_address}\n\nLooking forward to hosting you!\n{hotel_name} Team',
  whatsapp_room_checkin_template: '✅ Welcome {guest_name} to {hotel_name}! 🎉\n\nBooking ID: {booking_number}\nRoom/Bed: {room}\nCheck-out: {check_out}\n\n📞 For queries: {hotel_phone}\n📍 Location: {hotel_address}\n\nWe hope you have a pleasant stay!\n{hotel_name} Team',
  whatsapp_room_checkout_template: '✅ Thank you for staying with {hotel_name}, {guest_name}!\n\nBooking ID: {booking_number}\nRoom/Bed: {room}\nTotal Amount: {total}\nAmount Paid: {advance}\n\n📞 For queries: {hotel_phone}\n📍 Location: {hotel_address}\n\nWe look forward to hosting you again!\n{hotel_name} Team',
};

function RoomTemplateEditor({ label, value, defaultValue, onChange, onSave, placeholders = ROOM_TEMPLATE_PLACEHOLDERS }) {
  const textareaRef = useRef(null);

  function insertPlaceholder(placeholder) {
    const input = textareaRef.current;
    if (!input) return;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${placeholder}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      input.focus();
      const caret = start + placeholder.length;
      input.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="whatsapp-template-editor">
      <div className="whatsapp-template-editor-heading">
        <strong>{label}</strong>
        <button type="button" className="btn-link" onClick={() => { onChange(defaultValue); onSave(defaultValue); }}>
          Use default
        </button>
      </div>
      <textarea
        ref={textareaRef}
        rows={7}
        className="whatsapp-template-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onSave(e.target.value)}
        aria-label={`${label} WhatsApp template`}
      />
      <div className="whatsapp-placeholder-list">
        <span className="settings-hint">Click to insert:</span>
        {placeholders.map(([placeholder, description]) => (
          <button
            type="button"
            key={placeholder}
            className="whatsapp-placeholder-chip"
            title={`Insert ${description}`}
            onClick={() => insertPlaceholder(placeholder)}
          >
            {placeholder}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function WhatsAppSection() {
  const mobileWhatsAppHandoff = isMobileWhatsAppHandoff();
  const festivalApiAvailable = hasFestivalApi();
  const sendLogApiAvailable = hasSendLogApi();
  const statusApiAvailable = hasWhatsAppStatusApi();
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [festivals, setFestivals] = useState([]);
  const [editingFestival, setEditingFestival] = useState(null);
  const [sendLog, setSendLog] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const [saved, setSaved] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [cloudToken, setCloudToken] = useState('');
  const [cloudPhoneId, setCloudPhoneId] = useState('');

  useEffect(() => {
    window.api.getSettings().then(setSettings);
    if (statusApiAvailable) window.api.getWhatsAppStatus().then(setStatus).catch(() => setStatus(null));
    if (festivalApiAvailable) window.api.listFestivals().then(setFestivals).catch(() => setFestivals([]));
    if (statusApiAvailable && typeof window.api.onWhatsAppStatusChanged === 'function') {
      const unsubscribe = window.api.onWhatsAppStatusChanged(setStatus);
      return unsubscribe;
    }
    return undefined;
  }, [festivalApiAvailable, statusApiAvailable]);

  if (!statusApiAvailable && !mobileWhatsAppHandoff) return null;
  if (!settings) return null;

  async function toggleTrigger(key, checked) {
    setSettingsError('');
    try {
      const updated = await window.api.saveSettings({ [key]: String(checked) });
      setSettings(updated);
    } catch (err) {
      setSettingsError(err.message || 'Could not save the WhatsApp setting.');
    }
  }

  async function saveMessageTemplate(key, value) {
    setSettingsError('');
    try {
      const updated = await window.api.saveSettings({ [key]: value });
      setSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSettingsError(err.message || 'Could not save the WhatsApp message.');
    }
  }

  async function handleConnect() {
    setStatus({ status: 'CONNECTING' });
    const next = await window.api.connectWhatsApp();
    setStatus(next);
    setSettings((s) => ({ ...s, feature_whatsapp_enabled: 'true' }));
  }

  async function handleDisconnect() {
    if (!window.confirm('Disconnect WhatsApp? Bill/booking messages and festival greetings will stop sending until reconnected.')) return;
    await window.api.logoutWhatsApp();
    setStatus({ status: 'DISCONNECTED' });
    setSettings((s) => ({ ...s, feature_whatsapp_enabled: 'false' }));
  }

  async function handleSendTest(e) {
    e.preventDefault();
    setTesting(true);
    setTestResult(null);
    try {
      await window.api.sendWhatsAppTest(testPhone);
      setTestResult({ ok: true });
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  }

  async function handleSaveFestival(e) {
    e.preventDefault();
    const updated = await window.api.saveFestival(editingFestival);
    setFestivals(updated);
    setEditingFestival(null);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  async function handleDeleteFestival(id) {
    if (!window.confirm('Delete this festival greeting?')) return;
    await window.api.deleteFestival(id);
    window.api.listFestivals().then(setFestivals);
  }

  async function openSendLog() {
    setShowLog((v) => !v);
    if (!showLog && sendLogApiAvailable) setSendLog(await window.api.getWhatsAppSendLog());
  }

  const isConnected = status?.status === 'CONNECTED';
  const isConnecting = status?.status === 'CONNECTING';
  const hasQr = status?.status === 'QR_READY' && status.qr;

  return (
    <div className="settings-section">
      <h3 className="label-with-help">
        💬 Integrate WhatsApp
        <button
          type="button"
          className="help-question-btn"
          onClick={() => setShowHelp((v) => !v)}
          title="More about WhatsApp messaging"
          aria-label="More about WhatsApp messaging"
        >?</button>
      </h3>
      <p className="settings-sub">
        {mobileWhatsAppHandoff
          ? 'Choose which checkout and room events should open WhatsApp. Messages are prepared for the cashier to review.'
          : 'Configure automatic messages from the connected WhatsApp account.'}
      </p>
      {showHelp && (
        <div className="help-panel">
          {mobileWhatsAppHandoff
            ? 'On this mobile device, enabled events open the WhatsApp account already signed in here with the customer number and message prepared. Checkout attaches the saved PDF bill. A cashier must review and press Send; BillNest does not send it automatically.'
            : "Uses the same technology as WhatsApp Web — scan the QR code below with WhatsApp on your phone (Settings > Linked Devices > Link a Device) to connect your hotel's WhatsApp number. This is not Meta's official paid Business API, so it's completely free with no per-message cost — but very high-volume bulk sends (like festival greetings) are throttled automatically to reduce the chance of WhatsApp flagging the number."}
        </div>
      )}

      {!mobileWhatsAppHandoff && <div className="integration-card whatsapp-provider-card">
        <div className="integration-card-header">
          <span>WhatsApp Provider</span>
          <span className={`status-badge ${isConnected ? 'status-active' : 'status-inactive'}`}>
            {settings.whatsapp_provider === 'CLOUD_API'
              ? (isConnected ? 'Cloud API ready' : 'Cloud API not configured')
              : (isConnected ? `Connected (${status.number})` : isConnecting ? 'Connecting…' : 'Not Connected')}
          </span>
        </div>

        <label className="settings-select-label">
          Sending method
          <select
            value={settings.whatsapp_provider || 'BAILEYS'}
            onChange={async (e) => {
              const updated = await window.api.saveSettings({ whatsapp_provider: e.target.value });
              setSettings(updated);
              const next = await window.api.getWhatsAppStatus();
              setStatus(next);
            }}
          >
            <option value="BAILEYS">Baileys — free linked-device connection</option>
            <option value="CLOUD_API">WhatsApp Cloud API — official Business account</option>
          </select>
        </label>

        {settings.whatsapp_provider === 'CLOUD_API' ? (
          <>
            <div className="settings-extra whatsapp-cloud-settings">
              <label>
                Approved Meta template name (optional)
                <input
                  type="text"
                  value={settings.whatsapp_cloud_template_name || ''}
                  onChange={(e) => setSettings((current) => ({ ...current, whatsapp_cloud_template_name: e.target.value }))}
                  onBlur={(e) => saveMessageTemplate('whatsapp_cloud_template_name', e.target.value)}
                  placeholder="e.g. billnest_notification"
                />
              </label>
              <label>
                Template language code
                <input
                  type="text"
                  value={settings.whatsapp_cloud_template_language || 'en_US'}
                  onChange={(e) => setSettings((current) => ({ ...current, whatsapp_cloud_template_language: e.target.value }))}
                  onBlur={(e) => saveMessageTemplate('whatsapp_cloud_template_language', e.target.value)}
                  placeholder="en_US"
                />
              </label>
              <p className="settings-hint">
                When set, Cloud API sends this approved template with the rendered message as its first body variable.
                Without it, free-form text/document captions work only inside Meta’s 24-hour customer-service window.
              </p>
              <div className="help-panel">
                <strong>Where do I set the Cloud API credentials?</strong>
                <p>On Windows, enter the credentials in the secure fields below. Environment variables are also supported for unattended deployments:</p>
                <code className="settings-code">[Environment]::SetEnvironmentVariable('WHATSAPP_CLOUD_ACCESS_TOKEN', 'YOUR_META_ACCESS_TOKEN', 'User')<br />[Environment]::SetEnvironmentVariable('WHATSAPP_CLOUD_PHONE_NUMBER_ID', 'YOUR_PHONE_NUMBER_ID', 'User')</code>
                <p>For an Android Host device, enter the token and Phone Number ID in the secure fields below. They are stored in Android Keystore and are not sent to client devices.</p>
              </div>
            </div>
            {typeof window.api.configureWhatsAppCloudApi === 'function' && (isHostDevice() || !!window.api.chooseBackupFolder) ? (
              <form className="settings-extra whatsapp-cloud-credentials" onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await window.api.configureWhatsAppCloudApi(cloudToken, cloudPhoneId);
                  setCloudToken('');
                  setStatus(await window.api.getWhatsAppStatus());
                  setTestResult({ ok: true, message: 'Cloud API credentials saved securely on this host.' });
                } catch (err) {
                  setTestResult({ ok: false, error: err.message });
                }
              }}>
                <input
                  type="password"
                  placeholder="Meta access token"
                  value={cloudToken}
                  onChange={(e) => setCloudToken(e.target.value)}
                  autoComplete="off"
                  required
                />
                <input
                  type="text"
                  placeholder="WhatsApp phone number ID"
                  value={cloudPhoneId}
                  onChange={(e) => setCloudPhoneId(e.target.value)}
                  required
                />
                <button type="submit" className="btn btn-primary">Save Cloud API credentials</button>
                {isConnected && (
                  <button type="button" className="btn btn-danger btn-small" onClick={async () => {
                    await window.api.clearWhatsAppCloudApi();
                    setStatus(await window.api.getWhatsAppStatus());
                  }}>Remove credentials</button>
                )}
                <p className="settings-hint">
                  Stored in Android Keystore on the Android Host or encrypted with Windows secure storage on the desktop. The token is never returned after saving.
                  The token is never returned to JavaScript after saving.
                </p>
              </form>
            ) : (
              <p className="settings-hint">
                Cloud API credentials are read securely from the EXE/host environment. Configure the host with
                <code>WHATSAPP_CLOUD_ACCESS_TOKEN</code> and <code>WHATSAPP_CLOUD_PHONE_NUMBER_ID</code>, then restart the app.
              </p>
            )}
          </>
        ) : !isConnected && !hasQr && (
          <button type="button" className="btn btn-primary" onClick={handleConnect} disabled={isConnecting}>
            {isConnecting ? 'Connecting…' : '🔗 Connect WhatsApp'}
          </button>
        )}

        {!isConnecting && !isConnected && status?.error && (
          <p className="settings-hint whatsapp-provider-error">
            ⚠️ {status.error}
          </p>
        )}

        {hasQr && (
          <div className="whatsapp-qr-wrap">
            <p className="settings-hint">Scan with WhatsApp &gt; Linked Devices &gt; Link a Device</p>
            <img src={status.qr} alt="WhatsApp QR code" width={220} height={220} />
          </div>
        )}

        {isConnected && settings.whatsapp_provider !== 'CLOUD_API' && (
          <button type="button" className="btn btn-danger btn-small" onClick={handleDisconnect}>
            Disconnect
          </button>
        )}
      </div>}

      {(isConnected || mobileWhatsAppHandoff) && (
        <>
          <section className="integration-card whatsapp-trigger-card">
            <div className="integration-card-header">
              <span>{mobileWhatsAppHandoff ? 'Open WhatsApp for these events' : 'Automatic message triggers'}</span>
            </div>
            {mobileWhatsAppHandoff && (
              <div className="whatsapp-handoff-notice" role="note">
                <strong>WhatsApp will open, but the message is not sent automatically.</strong>
                <span>BillNest prepares the customer number, message and PDF when applicable. The cashier reviews it and taps Send in WhatsApp. Messages use the WhatsApp account signed in on this device.</span>
              </div>
            )}
            <div className="whatsapp-trigger-grid">
              {[
                ['whatsapp_send_food_bill', 'Food checkout', mobileWhatsAppHandoff ? 'Open WhatsApp with the existing PDF bill attached. A customer phone number is required.' : 'Send the food bill automatically when a customer phone number is available.'],
                ['whatsapp_send_room_booking', 'Room booking', mobileWhatsAppHandoff ? 'Open WhatsApp with the booking confirmation message.' : 'Send the booking confirmation automatically.'],
                ['whatsapp_send_room_checkin', 'Guest check-in', mobileWhatsAppHandoff ? 'Open WhatsApp with the welcome message.' : 'Send the check-in welcome message automatically.'],
                ['whatsapp_send_room_checkout', 'Room checkout', mobileWhatsAppHandoff ? 'Open WhatsApp with the checkout message and this checkout’s PDF bill.' : 'Send the checkout message and PDF bill automatically.'],
              ].map(([key, label, description]) => (
                <label className="whatsapp-trigger-option" key={key}>
                  <input
                    type="checkbox"
                    checked={settings[key] === 'true'}
                    onChange={(e) => toggleTrigger(key, e.target.checked)}
                  />
                  <span className="whatsapp-trigger-option-copy">
                    <strong>{label}</strong>
                    <span>{description}</span>
                  </span>
                </label>
              ))}
            </div>
            {settingsError && <p className="whatsapp-settings-error" role="alert">{settingsError}</p>}
          </section>

          <div className="integration-card whatsapp-template-card">
            <div className="integration-card-header">
              <span>Food bill message</span>
            </div>
            <p className="settings-hint">This text is prepared for food checkout. The same generated bill PDF is attached on mobile.</p>
            <RoomTemplateEditor
              label="Food bill message"
              value={settings.whatsapp_food_bill_template || DEFAULT_FOOD_TEMPLATE}
              defaultValue={DEFAULT_FOOD_TEMPLATE}
              placeholders={FOOD_TEMPLATE_PLACEHOLDERS}
              onChange={(value) => setSettings((current) => ({ ...current, whatsapp_food_bill_template: value }))}
              onSave={(value) => saveMessageTemplate('whatsapp_food_bill_template', value)}
            />
          </div>

          <div className="integration-card whatsapp-template-card">
            <div className="integration-card-header">
              <span>Room WhatsApp Message Templates</span>
            </div>
            <p className="settings-hint">
              Edit the text prepared for room booking, check-in, and checkout. Use placeholders:
              {' {guest_name}, {hotel_name}, {booking_number}, {check_in}, {check_out}, {room}, {total}, {advance}, {hotel_phone}, {hotel_address}'}.
            </p>
            {[
              ['whatsapp_room_booking_template', 'Booking confirmation'],
              ['whatsapp_room_checkin_template', 'Check-in welcome'],
              ['whatsapp_room_checkout_template', 'Checkout message'],
            ].map(([key, label]) => (
              <RoomTemplateEditor
                key={key}
                label={label}
                value={settings[key] || ''}
                defaultValue={DEFAULT_ROOM_TEMPLATES[key]}
                onChange={(value) => setSettings((current) => ({ ...current, [key]: value }))}
                onSave={(value) => saveMessageTemplate(key, value)}
              />
            ))}
            <p className="settings-hint">Templates save automatically when you leave each text box. Placeholders are replaced with the booking’s real details before sending.</p>
          </div>

          <div className="integration-card whatsapp-template-card">
            <div className="integration-card-header"><span>Checkout review request</span></div>
            <label className="integration-toggle">
              <input
                type="checkbox"
                checked={settings.whatsapp_checkout_review_request === 'true'}
                onChange={(e) => toggleTrigger('whatsapp_checkout_review_request', e.target.checked)}
              />
              <span>Ask guests to rate their stay after checkout</span>
            </label>
            <label className="whatsapp-review-link">
              Google review link
              <input
                type="url"
                value={settings.whatsapp_room_review_link || ''}
                onChange={(e) => setSettings((current) => ({ ...current, whatsapp_room_review_link: e.target.value }))}
                onBlur={(e) => saveMessageTemplate('whatsapp_room_review_link', e.target.value)}
                placeholder="Paste the review link when ready"
              />
            </label>
            <p className="settings-hint">The checkout message will show a neutral “Please rate us here” link. No website name is added.</p>
          </div>

          {!mobileWhatsAppHandoff && <form onSubmit={handleSendTest} className="fm-form whatsapp-test-form">
            <label>
              Send a test message
              <input
                type="tel"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                placeholder="e.g. 9876543210"
              />
            </label>
            <div className="fm-form-actions">
              <button type="submit" className="btn btn-secondary" disabled={testing || !testPhone}>
                {testing ? 'Sending…' : 'Send Test Message'}
              </button>
            </div>
            {testResult && (testResult.ok
              ? <p className="sync-test-ok">✅ {testResult.message || 'Test message sent.'}</p>
              : <p className="sync-test-fail">❌ {testResult.error}</p>)}
          </form>}

          {sendLogApiAvailable && <div className="settings-extra">
            <button type="button" className="btn btn-secondary btn-small" onClick={openSendLog}>
              {showLog ? 'Hide' : 'View'} Send History
            </button>
          </div>}
          {sendLogApiAvailable && showLog && (
            <div className="whatsapp-send-log">
              {sendLog.length === 0 && <p className="settings-hint">No messages sent yet.</p>}
              {sendLog.map((row) => (
                <div key={row.id} className="whatsapp-log-row">
                  <span>{row.created_at}</span>
                  <span>{row.phone}</span>
                  <span>{row.type}</span>
                  <span className={['SENT', 'DELIVERED', 'READ'].includes(row.status) ? 'sync-test-ok' : 'sync-test-fail'}>{row.status}</span>
                </div>
              ))}
            </div>
          )}

          {festivalApiAvailable && <><h4 className="whatsapp-festival-heading">🎉 Festival Greetings</h4>
          <p className="settings-sub">
            Sent once a year, automatically, to every customer whose phone number {APP_NAME} has on file
            (from bills or room bookings). Disabled by default — review the message text and enable each
            one you want to send.
          </p>
          <div className="festival-list">
            {festivals.map((f) => (
              <div key={f.id} className="integration-card">
                <div className="integration-card-header">
                  <label className="integration-toggle">
                    <input
                      type="checkbox"
                      checked={!!f.enabled}
                      onChange={async (e) => {
                        const updated = await window.api.saveFestival({ id: f.id, name: f.name, monthDay: f.month_day, messageTemplate: f.message_template, enabled: e.target.checked });
                        setFestivals(updated);
                      }}
                    />
                    <span>{f.name} ({f.month_day})</span>
                  </label>
                  <div className="settings-extra">
                    <button type="button" className="btn-link" onClick={() => setEditingFestival({ id: f.id, name: f.name, monthDay: f.month_day, messageTemplate: f.message_template, enabled: !!f.enabled })}>Edit</button>
                    <button type="button" className="btn-link danger" onClick={() => handleDeleteFestival(f.id)}>Delete</button>
                  </div>
                </div>
                <p className="settings-hint">{f.message_template}</p>
              </div>
            ))}
          </div>

          <div className="settings-extra">
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => setEditingFestival({ id: null, name: '', monthDay: '', messageTemplate: '', enabled: true })}
            >
              + Add Festival / Occasion
            </button>
          </div>

          {editingFestival && (
            <form onSubmit={handleSaveFestival} className="fm-form whatsapp-festival-form">
              <label>
                Name
                <input
                  value={editingFestival.name}
                  onChange={(e) => setEditingFestival({ ...editingFestival, name: e.target.value })}
                  placeholder="e.g. Diwali"
                  required
                />
              </label>
              <label>
                Date (MM-DD, repeats every year)
                <input
                  value={editingFestival.monthDay}
                  onChange={(e) => setEditingFestival({ ...editingFestival, monthDay: e.target.value })}
                  placeholder="e.g. 11-01"
                  pattern="\d{2}-\d{2}"
                  required
                />
              </label>
              <label>
                Message ({'{hotel_name}'} is replaced automatically)
                <textarea
                  value={editingFestival.messageTemplate}
                  onChange={(e) => setEditingFestival({ ...editingFestival, messageTemplate: e.target.value })}
                  rows={3}
                  required
                />
              </label>
              <div className="fm-form-actions">
                <button type="submit" className="btn btn-primary">Save</button>
                <button type="button" className="btn btn-secondary" onClick={() => setEditingFestival(null)}>Cancel</button>
              </div>
            </form>
          )}
          </>}
          {saved && <div className="toast-success">✅ Festival greeting saved.</div>}
        </>
      )}
    </div>
  );
}
