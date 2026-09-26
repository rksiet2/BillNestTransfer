// Single source of truth for the product name shown throughout the React
// UI (Settings copy, login/setup screens, the in-app Assistant persona,
// exported file names, error messages, etc.).
//
// To rebrand the app, change APP_NAME here — every screen that imports it
// picks up the new name automatically. You'll also need to update these
// two places that can't read this file (different build systems):
//   1. electron/brand.cjs        — same name, used by the main process
//      (window titles, tray, dialogs, notifications) since it's CommonJS
//      and can't import this ES module directly.
//   2. package.json              — "name"/"productName"/"description"/
//      "appId" fields are read by electron-builder at packaging time,
//      before any app code runs, so they must stay in sync manually.
export const APP_NAME = 'BillNest';
export const APP_TAGLINE = 'Smart Billing for Hotels & Restaurants';
