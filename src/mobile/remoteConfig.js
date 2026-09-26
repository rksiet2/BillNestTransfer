// Lets the mobile/web build of BillNest optionally connect to a desktop
// "Host" over WiFi instead of using its own on-device localStorage database
// — this is what turns a phone into a genuine Captain/Waiter device that
// sees the SAME live tables/menu/orders as the billing counter, rather than
// its own separate, disconnected copy.
//
// Deliberately stored completely separately from the app's regular data
// (a distinct localStorage key, never touched by webApi.js's DB seed/backup
// logic) since this is connection config for THIS device, not restaurant
// data that should ever be exported/backed-up/wiped along with it.
import { parseHostAddress } from './remoteApi.js';

const STORAGE_KEY = 'billnest_remote_config';

// mode values:
//   'LOCAL'       — standalone, all data on this device (default)
//   'CLIENT'      — connect to another device's HOST server over WiFi
//   'HOST_DEVICE' — this Android/tablet IS the host; other phones connect to it
//
// Migration note: old builds stored mode='HOST' to mean "be a CLIENT connecting
// to a host". We rename that on first read so new code never sees the old value.
const DEFAULT_CONFIG = { mode: 'LOCAL', hostIp: '', hostPort: '4001', authToken: '' };

function migrate(config) {
  // Old 'HOST' meant "connect to a host as a client" — rename to 'CLIENT'
  if (config.mode === 'HOST') return { ...config, mode: 'CLIENT' };
  return config;
}

export function getRemoteConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const config = !raw ? { ...DEFAULT_CONFIG } : migrate({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
    if (!config.authToken && globalThis.crypto?.getRandomValues) {
      const bytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(bytes);
      config.authToken = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    }
    return config;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// Returns true when this device is configured as the HOST that other phones
// connect to. Used by main.jsx (webApi path) and FeaturesSection's SyncPanel.
export function isHostDevice() {
  return getRemoteConfig().mode === 'HOST_DEVICE';
}

export function saveRemoteConfig(partial) {
  const merged = { ...getRemoteConfig(), ...partial };
  // Defensive normalization: if `hostIp` still has a "ip:port" combo baked
  // in (e.g. a caller that doesn't pre-parse it via MobileConnectionSection's
  // own `updateHostIp`), split it out here too, so a saved config never ends
  // up with a broken `hostIp` that includes a port fetch() would choke on.
  const { hostIp, hostPort } = parseHostAddress(merged.hostIp, merged.hostPort);
  const next = { ...merged, hostIp, hostPort };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
