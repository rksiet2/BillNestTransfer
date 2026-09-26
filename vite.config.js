import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative base so the built index.html works when loaded via file:// inside Electron.
  base: './',
  server: {
    watch: {
      // Vendor-only licensing CLI tools (electron/licensing.cjs's signing
      // keypair + generated .lic files) are never imported by the app itself
      // and can be locked by other processes — no need for Vite to watch them.
      // android/ is a Capacitor BUILD OUTPUT (populated by `npx cap sync
      // android`, never hand-edited) — watching it is pointless and, worse,
      // `cap sync` can transiently lock files there (Windows EBUSY), which
      // previously crashed the whole `npm run electron:dev` dev server.
      ignored: ['**/scripts/license-authority/**', '**/android/**', '**/release/**'],
    },
  },
})
