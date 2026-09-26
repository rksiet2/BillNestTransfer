import React, { lazy, Suspense, useEffect, useState } from 'react';
import {
  UilReceipt, UilRestaurant, UilUtensils, UilBox, UilChartBar,
  UilBedDouble, UilCalendarAlt, UilBuilding, UilSetting, UilHome,
} from '@iconscout/react-unicons';
import billnestMark from './assets/billnest-mark.png';
import { CartProvider } from './context/CartContext';
const BillingPage = lazy(() => import('./components/Billing/BillingPage'));
const Dashboard = lazy(() => import('./components/Dashboard/Dashboard'));
const FoodManagement = lazy(() => import('./components/FoodManagement/FoodManagement'));
const ReportingPage = lazy(() => import('./components/Reporting/ReportingPage'));
const SettingsPage = lazy(() => import('./components/Settings/SettingsPage'));
import SetupWizard from './components/Settings/SetupWizard';
import BillWindow from './components/Bill/BillWindow';
import GroupBillWindow from './components/Bill/GroupBillWindow';
import KotWindow from './components/Bill/KotWindow';
const InventoryPage = lazy(() => import('./components/Inventory/InventoryPage'));
const AvailabilityTab = lazy(() => import('./components/RoomBooking/AvailabilityTab'));
const BookingsTab = lazy(() => import('./components/RoomBooking/BookingsTab'));
const RoomsTab = lazy(() => import('./components/RoomBooking/RoomsTab'));
import LoginScreen from './components/Auth/LoginScreen';
import IncomingOrdersBell from './components/Integrations/IncomingOrdersBell';
import AssistantWidget from './components/Assistant/AssistantWidget';
import CounterConnectionStatus from './components/Settings/CounterConnectionStatus';
const TablesPage = lazy(() => import('./components/Tables/TablesPage'));
import ActivationScreen from './components/Licensing/ActivationScreen';
import { getRemoteConfig, saveRemoteConfig } from './mobile/remoteConfig';

// True only for a phone/tablet that connected to a Host as Captain/Waiter
// (src/mobile/remoteApi.js — never true in Electron, which always has
// `window.api.chooseBackupFolder`, and never true for a standalone mobile
// device still on its own local webApi.js data). Used below to show this
// device a deliberately MINIMAL nav — just table/order-taking — regardless
// of the logged-in user's own Owner/Staff role or access level, because a
// waiter's phone should never expose Billing history, Reporting, Inventory
// or Settings even if the PIN they used happens to have full access.
const IS_CAPTAIN_DEVICE = typeof window !== 'undefined' && !window.api?.chooseBackupFolder && getRemoteConfig().mode === 'CLIENT';

// Nav items a Captain/Waiter device is allowed to see at all — table view
// (to pick a table) and taking/editing its order via Billing.
const CAPTAIN_ALLOWED_KEYS = new Set(['tables', 'billing']);

// `staffOnly` marks nav items visible to both roles; anything NOT in this
// list is Owner-only and gets filtered out for a STAFF user in MainApp below.
const FOOD_NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: UilHome, staffOnly: true },
  { key: 'billing', label: 'Billing', icon: UilReceipt, staffOnly: true },
  { key: 'tables', label: 'Tables', icon: UilRestaurant, staffOnly: true, featureFlag: 'feature_table_management' },
  { key: 'food', label: 'Food Details', icon: UilUtensils },
  { key: 'inventory', label: 'Inventory', icon: UilBox },
  { key: 'reporting', label: 'Reporting', icon: UilChartBar },
];

const ROOM_NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: UilHome, staffOnly: true },
  { key: 'room-availability', label: 'Room View', icon: UilBedDouble, staffOnly: true },
  { key: 'room-bookings', label: 'Bookings', icon: UilCalendarAlt, staffOnly: true },
  { key: 'room-rooms', label: 'Rooms', icon: UilBuilding },
  { key: 'reporting', label: 'Reporting', icon: UilChartBar },
];

// Combined lookup used to render a page heading (icon + label) above
// whichever screen is currently active, so it's always obvious which page
// you're on — 'reporting' appears in both arrays with the same icon/label,
// so a plain find() across both works fine either way.
const ALL_NAV_ITEMS = [...FOOD_NAV_ITEMS, ...ROOM_NAV_ITEMS];
ALL_NAV_ITEMS.push({ key: 'settings', label: 'Settings', icon: UilSetting });

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();
  // Lifted up from MainApp so it survives hash-route navigation: opening a
  // bill/KOT (even on mobile, where there's no separate OS window and this
  // same component tree just swaps to <BillWindow>) used to unmount MainApp
  // entirely, wiping its local currentUser/appModule/active state — forcing
  // a fresh PIN login and dropping the user back on the Food Billing home
  // screen when they closed the invoice, instead of returning them to
  // whatever screen (e.g. Room Booking > Bookings) they came from.
  const [currentUser, setCurrentUser] = useState(null);
  const [appModule, setAppModule] = useState('food'); // 'food' | 'rooms' — top-level swap between the two software modes
  const [active, setActive] = useState('dashboard');
  const [newBookingRequest, setNewBookingRequest] = useState(0);

  // Separate lightweight window: renders only the printable receipt.
  const billMatch = hash.match(/^#\/bill\/(\d+)/);
  if (billMatch) {
    // key={hash} forces a full remount (and therefore a fresh re-fetch) on every
    // navigation, even when re-opening the same bill id whose data may have
    // changed since it was last viewed (see navigateWindow's cache-busting hash).
    return <BillWindow key={hash} billId={billMatch[1]} />;
  }

  // Combined Group Invoice: purely a visual merge of already-generated
  // per-room bills for one booking group — read-only, never creates a bill.
  const groupBillMatch = hash.match(/^#\/bill-group\/([^/?]+)/);
  if (groupBillMatch) {
    return <GroupBillWindow key={hash} groupId={groupBillMatch[1]} />;
  }

  // Separate lightweight window: renders only the printable Kitchen Order Ticket.
  const kotMatch = hash.match(/^#\/kot\/(\d+)/);
  if (kotMatch) {
    return <KotWindow key={hash} billId={kotMatch[1]} />;
  }

  return (
    <MainApp
      currentUser={currentUser}
      setCurrentUser={setCurrentUser}
      appModule={appModule}
      setAppModule={setAppModule}
      active={active}
      setActive={setActive}
      newBookingRequest={newBookingRequest}
      requestNewBooking={() => setNewBookingRequest((count) => count + 1)}
    />
  );
}

function MainApp({ currentUser, setCurrentUser, appModule, setAppModule, active, setActive, newBookingRequest, requestNewBooking }) {
  const [settings, setSettings] = useState(null);
  const [connectionError, setConnectionError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [licenseStatus, setLicenseStatus] = useState(null);
  const [expiryBannerDismissed, setExpiryBannerDismissed] = useState(
    () => sessionStorage.getItem('expiry-banner-dismissed') === '1'
  );

  const isStaff = currentUser?.role === 'STAFF';
  function navigateDashboardAction(target) {
    if (target === 'room-bookings-new') {
      setActive('room-bookings');
      requestNewBooking();
      return;
    }
    setActive(target);
  }
  // The Captain/Waiter nav restriction only ever applies to a STAFF login on
  // a phone/browser client — the Owner logging into that exact same device
  // (e.g. to check something, or because they use it as a second full
  // billing counter) always gets the same full access they'd get on desktop.
  const isCaptainRestricted = IS_CAPTAIN_DEVICE && isStaff;
  // Which modules THIS INSTALL's license key unlocks — set by the vendor at
  // sale time (see scripts/license-authority/generate-license.cjs). A
  // "Food Billing only" or "Hotel Billing only" key hides the other module
  // completely, for every user on this device, regardless of their own
  // per-staff access setting below. Mobile/Client/browser installs never
  // carry a license payload (getLicenseStatus() there always resolves
  // { valid: true } with no payload) — those default to unrestricted so a
  // Captain/Waiter phone connecting to a licensed Host isn't blocked here.
  const licensedModules = licenseStatus?.payload?.modules || ['food', 'rooms'];
  const licensedFood = licensedModules.includes('food');
  const licensedRooms = licensedModules.includes('rooms');

  // Show a dismissible top banner when the license has <= 14 days left.
  // Suppressed during the 7-day grace period (user must activate a renewal
  // to get back in — the ActivationScreen handles that state instead).
  const showExpiryBanner = (() => {
    if (expiryBannerDismissed) return false;
    const exp = licenseStatus?.payload?.expiresAt;
    if (!exp) return false;
    if (licenseStatus?.payload?.gracePeriodDaysLeft != null) return false;
    const days = Math.ceil((new Date(exp).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    return days > 0 && days <= 14;
  })();
  const expiryBannerDays = licenseStatus?.payload?.expiresAt
    ? Math.ceil((new Date(licenseStatus.payload.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : 0;
  const expiryBannerDate = licenseStatus?.payload?.expiresAt
    ? new Date(licenseStatus.payload.expiresAt).toLocaleDateString()
    : '';
  function dismissExpiryBanner() {
    sessionStorage.setItem('expiry-banner-dismissed', '1');
    setExpiryBannerDismissed(true);
  }
  // Per-staff module access (Owner is always 'BOTH'): FOOD-only staff never
  // see the Room Booking module, ROOMS-only staff never see Food Billing.
  const canFood = licensedFood && (!currentUser || currentUser.access !== 'ROOMS');
  // A Captain/Waiter *login* only ever deals with restaurant tables/orders —
  // the Room Booking module has no equivalent captain workflow, so it's
  // hidden entirely for that login rather than showing an empty nav there.
  const canRooms = licensedRooms && (!currentUser || currentUser.access !== 'FOOD') && !isCaptainRestricted;
  const navItems = (appModule === 'food' ? FOOD_NAV_ITEMS : ROOM_NAV_ITEMS)
    .filter((item) => !isStaff || item.staffOnly)
    .filter((item) => !item.featureFlag || settings?.[item.featureFlag] === 'true')
    // Login-level restriction (on top of the role one above): a Staff PIN
    // logged in on a Captain/Waiter phone only ever gets table-picking +
    // order-taking. An Owner PIN on that same device is unrestricted.
    .filter((item) => !isCaptainRestricted || CAPTAIN_ALLOWED_KEYS.has(item.key));

  function switchModule(m) {
    if (m === 'food' && !canFood) return;
    if (m === 'rooms' && !canRooms) return;
    setAppModule(m);
    setActive(m === 'food' ? 'billing' : 'room-availability');
    setSidebarOpen(false);
  }

  function handleLogout() {
    setCurrentUser(null);
    setActive('dashboard');
    setAppModule('food');
  }

  // Checked once up front, before even Setup/Login — an unlicensed Host
  // install shouldn't reach either of those. Client terminals and the
  // mobile/web fallback always resolve { valid: true } (see webApi.js /
  // remoteApi.js / preload-client.cjs), so this never blocks them.
  useEffect(() => {
    window.api.getLicenseStatus().then(setLicenseStatus).catch(() => setLicenseStatus({ valid: true }));
  }, []);

  // Only fetch settings once we know this install is licensed — an
  // unlicensed Host skips DB init entirely (see electron/main.cjs), so
  // calling this any earlier would hit a database that was never opened.
  useEffect(() => {
    if (!licenseStatus?.valid) return;
    let cancelled = false;
    const loadSettings = () => {
      setConnectionError('');
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Loading settings timed out. Check whether this device is configured as a Client and whether the Host app is reachable.')), 8000);
      });
      Promise.race([window.api.getSettings(), timeout])
        .then((value) => { if (!cancelled) setSettings(value); })
        .catch((err) => { if (!cancelled) setConnectionError(err?.message || 'Could not load application settings.'); });
    };
    loadSettings();
    const refresh = () => loadSettings();
    window.addEventListener('billnest:settings-updated', refresh);
    return () => { cancelled = true; window.removeEventListener('billnest:settings-updated', refresh); };
  }, [licenseStatus]);

  // When a user logs in whose access is restricted to one module, land them
  // straight on the module they're actually allowed to use instead of the
  // default Food Billing screen (which they'd otherwise briefly see, or be
  // stuck on if access is ROOMS-only).
  useEffect(() => {
    if (!currentUser) return;
    if (currentUser.access === 'ROOMS' && appModule !== 'rooms') {
      setAppModule('rooms');
      setActive('room-availability');
    } else if (currentUser.access === 'FOOD' && appModule !== 'food') {
      setAppModule('food');
      setActive('dashboard');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  // A single-module license key (Food Billing only, or Hotel Billing only)
  // means the OTHER module is hidden for every user on this install — make
  // sure we never leave the app parked on a module its own license doesn't
  // unlock (the default state starts on 'food', which would be wrong for a
  // rooms-only key).
  useEffect(() => {
    if (!licenseStatus?.valid) return;
    if (appModule === 'food' && !canFood && canRooms) {
      setAppModule('rooms');
      setActive('room-availability');
    } else if (appModule === 'rooms' && !canRooms && canFood) {
      setAppModule('food');
      setActive('dashboard');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licenseStatus, canFood, canRooms]);


  if (!licenseStatus) {
    return (
      <div className="app-loading">
        <img src={billnestMark} alt="" />
        <span className="app-loading-text">Loading…</span>
      </div>
    );
  }

  if (!licenseStatus.valid) {
    return <ActivationScreen status={licenseStatus} />;
  }

  if (connectionError) {
    return (
      <div className="app-loading app-connection-error">
        <img src={billnestMark} alt="" />
        <h2>BillNest could not finish loading</h2>
        <p>{connectionError}</p>
        <p>If this is a Client device, check the Host IP, port, shared access key, WiFi, firewall, and that the Host app is open.</p>
        <div className="app-loading-actions">
          <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>Retry connection</button>
          {typeof window.api?.saveSyncConfig === 'function' && (
            <button
              className="btn btn-secondary"
              type="button"
              onClick={async () => {
                await window.api.saveSyncConfig({ role: '', hostIp: '', authToken: '' });
                if (typeof window.api.relaunchApp === 'function') await window.api.relaunchApp();
                else window.location.reload();
              }}
            >
              Use this computer offline
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="app-loading">
        <img src={billnestMark} alt="" />
        <span className="app-loading-text">Loading…</span>
      </div>
    );
  }

  if (settings.setup_completed !== 'true') {
    return <SetupWizard onComplete={setSettings} licenseStatus={licenseStatus} />;
  }

  if (!currentUser) {
    // Anyone can connect this device to a counter (see MobileConnectionSection) —
    // that's just Multi-Terminal Sync. But a Staff PIN specifically logging in
    // AS a Captain/Waiter only makes sense once the Owner has actually turned
    // that feature on; until then, only the Owner PIN can use a connected
    // phone/browser (e.g. as a second full billing counter).
    const attemptLogin = (user) => {
      if (IS_CAPTAIN_DEVICE && user.role === 'STAFF' && settings.feature_captain_app !== 'true') {
        return "Captain/Waiter App isn't enabled yet. Ask the Owner to turn it on in Settings \u2192 Features on the counter, or log in with the Owner PIN instead.";
      }
      setCurrentUser(user);
      return null;
    };
    return <LoginScreen onLogin={attemptLogin} />;
  }

  // If Staff lands on a route only Owner can see (e.g. was viewing Reporting,
  // then logged out and a staff member logged back in), bounce them to a
  // safe default instead of showing a blank/forbidden screen.
  if (isStaff && !navItems.some((item) => item.key === active)) {
    setActive(appModule === 'food' ? 'billing' : 'room-availability');
  }

  return (
    <CartProvider>
      <Suspense fallback={<div className="app-loading">Loading…</div>}>
        <div className="app-shell">
        {showExpiryBanner && (
          <div className="expiry-warning-banner">
            <span>
              ⚠️ Your license expires on {expiryBannerDate}
              {expiryBannerDays <= 7 ? ` — only ${expiryBannerDays} day${expiryBannerDays === 1 ? '' : 's'} left!` : ' — contact your vendor to renew.'}
            </span>
            <button className="expiry-warning-banner-dismiss" onClick={dismissExpiryBanner} title="Dismiss">✕</button>
          </div>
        )}
        <header className="topbar">
          <button className="hamburger" onClick={() => setSidebarOpen((v) => !v)} aria-label="Toggle menu">☰</button>
          <div className="app-brand">
            <span className="app-brand-mark"><img src={billnestMark} alt="" /></span>
            <h1>{appModule === 'rooms' ? (settings.room_biz_name || settings.hotel_name) : settings.hotel_name}</h1>
          </div>
          {(canFood && canRooms) && (
            <div className="module-switch">
              <button className={appModule === 'food' ? 'active' : ''} onClick={() => switchModule('food')}>
                🍽️ <span className="module-switch-label">Food Billing</span>
              </button>
              <button className={appModule === 'rooms' ? 'active' : ''} onClick={() => switchModule('rooms')}>
                🛏️ <span className="module-switch-label">Room Booking</span>
              </button>
            </div>
          )}
          <div className="topbar-right">
            <CounterConnectionStatus />
            {!isStaff && <IncomingOrdersBell />}
            <span className="current-user-badge">
              {currentUser.role === 'OWNER' ? '👑' : '🧑‍💼'} <span className="user-name-text">{currentUser.name}</span>
            </span>
            <button className="icon-btn" onClick={handleLogout} title="Switch User / Lock">🔒</button>
          </div>
        </header>

        <div className="app-body">
          <nav className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
            <div className="sidebar-nav">
              {navItems.map((item) => (
                <button
                  key={item.key}
                  className={`nav-item ${active === item.key ? 'active' : ''}`}
                  onClick={() => { setActive(item.key); setSidebarOpen(false); }}
                >
                  <span className="nav-icon"><item.icon size={18} /></span>
                  <span className="nav-label">{item.label}</span>
                </button>
              ))}
            </div>
            <div className="sidebar-bottom">
              {!isStaff && (
                <button
                  className={`nav-item nav-item-settings ${active === 'settings' ? 'active' : ''}`}
                  onClick={() => { setActive('settings'); setSidebarOpen(false); }}
                >
                  <span className="nav-icon"><UilSetting size={18} /></span>
                  <span className="nav-label">Settings</span>
                </button>
              )}
              <div className="sidebar-footer">
                <img src={billnestMark} alt="" />
                <span className="nav-label">Powered by BillNest</span>
              </div>
            </div>
          </nav>

          <main className="content">
            {(() => {
              const pageMeta = ALL_NAV_ITEMS.find((i) => i.key === active);
              if (!pageMeta) return null;
              return (
                <div className="page-heading">
                  <span className="page-heading-icon"><pageMeta.icon size={22} /></span>
                  <h1 className="page-heading-title">{pageMeta.label}</h1>
                </div>
              );
            })()}
            {active === 'dashboard' && <Dashboard appModule={appModule} currentUser={currentUser} settings={settings} onNavigate={navigateDashboardAction} />}
            {active === 'billing' && <BillingPage />}
            {active === 'tables' && <TablesPage onOpenTable={() => setActive('billing')} isOwner={currentUser?.role === 'OWNER'} currentUser={currentUser} />}
            {active === 'food' && !isStaff && <FoodManagement />}
            {active === 'inventory' && !isStaff && <InventoryPage />}
            {active === 'room-availability' && <AvailabilityTab />}
            {active === 'room-bookings' && <BookingsTab canCancel={!isStaff} newBookingRequest={newBookingRequest} />}
            {active === 'room-rooms' && !isStaff && <RoomsTab />}
            {active === 'reporting' && !isStaff && <ReportingPage />}
            {active === 'settings' && !isStaff && <SettingsPage currentUser={currentUser} licenseStatus={licenseStatus} />}
          </main>
        </div>

        <AssistantWidget />
        </div>
      </Suspense>
    </CartProvider>
  );
}
