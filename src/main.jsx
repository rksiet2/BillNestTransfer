import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/poppins/500.css'
import '@fontsource/poppins/600.css'
import '@fontsource/poppins/700.css'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/700.css'
import './index.css'
import App from './App.jsx'
import { APP_NAME } from './constants/brand.js'
import { getRemoteConfig } from './mobile/remoteConfig.js'
import { createRemoteApi } from './mobile/remoteApi.js'

// When running inside Electron, `window.api` is already injected by
// electron/preload.cjs and talks to the real SQLite database. When running
// in a plain browser tab or inside a Capacitor mobile shell, there's no
// Electron/Node backend available — fall back to either:
//  - a localStorage-backed implementation with the same API surface (see
//    src/mobile/webApi.js), the default, fully offline, standalone mode; or
//  - a "Connect to Host" remote client (src/mobile/remoteApi.js) if the user
//    has configured this device (from Settings) to join a desktop counter's
//    shared data over WiFi — this is what makes a phone a genuine
//    Captain/Waiter device instead of an island with its own separate data.
async function bootstrap() {
  document.title = APP_NAME;
  if (!window.api) {
    const remoteConfig = getRemoteConfig();
    if (remoteConfig.mode === 'CLIENT' && remoteConfig.hostIp) {
      // This device connects to another device's HOST server over WiFi
      window.api = createRemoteApi(remoteConfig);
    } else {
      // Standalone (LOCAL) or HOST_DEVICE — both use the local webApi.
      const { createWebApi } = await import('./mobile/webApi.js');
      window.api = createWebApi();

      // HOST_DEVICE: also start the Android HTTP server so other phones can
      // connect to this tablet over WiFi (same protocol as electron/lanServer.cjs).
      if (remoteConfig.mode === 'HOST_DEVICE') {
        try {
          const { startHostServer } = await import('./mobile/hostServer.js');
          const port = Number(remoteConfig.hostPort) || 4001;
          await startHostServer(port, remoteConfig.authToken);
        } catch (err) {
          console.warn('[bootstrap] Could not start host server:', err);
          // Non-fatal — tablet still works as standalone even if server fails to bind
        }
      }
    }
  }

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

bootstrap();
