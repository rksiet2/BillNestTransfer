// Single source of truth for the product name used in the Electron MAIN
// process (window titles, tray tooltip, save-dialog titles, notifications,
// license/error copy, firewall rule name, etc.).
//
// Keep this in sync with src/constants/brand.js (the renderer/React copy).
// Two files exist only because the renderer runs as an ES module and the
// main process here runs as CommonJS — there's no clean way to share one
// file between them without adding a bundler step for the main process.
// Rename the app by editing BOTH files' APP_NAME, plus package.json's
// "name"/"productName"/"description"/"appId" (read by electron-builder at
// packaging time, before any app code runs).
module.exports = {
  APP_NAME: 'BillNest',
};
