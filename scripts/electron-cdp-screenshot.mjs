// Raw-CDP screenshot helper — avoids puppeteer-core's `pages()` hang when a
// DevTools target is also open. Talks directly to Electron's remote
// debugging protocol over a plain WebSocket.
import WebSocket from 'ws';
import fs from 'fs';

const OUT_DIR = 'C:\\Users\\e101361';

async function getMainPageTarget() {
  const res = await fetch('http://localhost:9222/json/list');
  const list = await res.json();
  // Prefer the root app window (not KOT/bill print sub-windows, not DevTools).
  const main = list.find((t) => t.type === 'page' && t.url === 'http://localhost:5173/');
  if (!main) {
    // fall back to any billnest page target that isn't a kot/bill print window
    const alt = list.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5173') && !t.url.includes('#/'));
    if (alt) return alt;
    throw new Error('Main BillNest page target not found. Targets: ' + JSON.stringify(list.map((t) => t.url)));
  }
  return main;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { maxPayload: 100 * 1024 * 1024 });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function sendCmd(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off('message', handler);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const result = await sendCmd(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.result.value;
}

async function shot(ws, name) {
  const result = await sendCmd(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT_DIR}\\${name}.png`, Buffer.from(result.data, 'base64'));
  console.log('saved', name);
}

async function main() {
  const target = await getMainPageTarget();
  const ws = await connect(target.webSocketDebuggerUrl);
  await sendCmd(ws, 'Page.enable');
  await sendCmd(ws, 'Runtime.enable');
  await new Promise((r) => setTimeout(r, 2500));

  const bodyText = await evaluate(ws, 'document.body.innerText.slice(0,400)');
  console.log('body snippet:', JSON.stringify(bodyText).slice(0, 400));
  await shot(ws, 'electron-01-home');

  // Fresh profile: fill the hotel setup wizard if shown.
  if (bodyText && (bodyText.includes("Let's set up") || bodyText.includes('Hotel Name') || bodyText.includes('Setup'))) {
    await evaluate(ws, `
      (function() {
        const inputs = Array.from(document.querySelectorAll('input, textarea'));
        const setVal = (el, val) => {
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        for (const el of inputs) {
          const ph = (el.placeholder || '').toLowerCase();
          if (ph.includes('hotel name')) setVal(el, 'Test Hotel');
          else if (ph.includes('address')) setVal(el, '123 Test Street');
        }
        return inputs.length;
      })()
    `);
    await evaluate(ws, `
      (function() {
        const btns = Array.from(document.querySelectorAll('button'));
        const b = btns.find((x) => /save|continue|start|next|finish|done/i.test(x.textContent));
        if (b) b.click();
        return !!b;
      })()
    `);
    await new Promise((r) => setTimeout(r, 900));
  }
  await shot(ws, 'electron-01b-after-wizard');

  let ownerBodyText = await evaluate(ws, 'document.body.innerText.slice(0,400)');
  // Fresh profile: create-owner-PIN screen — this one uses plain text inputs.
  if (ownerBodyText && /create.*owner.*pin/i.test(ownerBodyText)) {
    await evaluate(ws, `
      (function() {
        const inputs = Array.from(document.querySelectorAll('input'));
        const setVal = (el, val) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        for (const el of inputs) {
          const ph = (el.placeholder || '').toLowerCase();
          if (ph.includes('1234') || ph.toLowerCase().includes('pin')) {
            if (ph.includes('re-enter') || ph.includes('confirm')) setVal(el, '1234');
            else setVal(el, '1234');
          }
        }
        return inputs.length;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
    await shot(ws, 'electron-01c-pin-entered-once');
    await evaluate(ws, `
      (function() {
        const btns = Array.from(document.querySelectorAll('button'));
        const b = btns.find((x) => /create owner pin|finish setup|create|save|confirm/i.test(x.textContent));
        if (b) b.click();
        return !!b;
      })()
    `);
    await new Promise((r) => setTimeout(r, 900));
  }

  let afterOwnerBodyText = await evaluate(ws, 'document.body.innerText.slice(0,400)');
  if (afterOwnerBodyText && afterOwnerBodyText.includes('PIN')) {
    await evaluate(ws, `
      (function() {
        const clickByText = (txt) => {
          const btns = Array.from(document.querySelectorAll('button'));
          const b = btns.find((x) => x.textContent.trim() === txt);
          if (b) b.click();
        };
        ['1','2','3','4'].forEach(clickByText);
      })()
    `);
    await new Promise((r) => setTimeout(r, 400));
    await evaluate(ws, `
      (function() {
        const btns = Array.from(document.querySelectorAll('button'));
        const b = btns.find((x) => /unlock/i.test(x.textContent));
        if (b) b.click();
        return !!b;
      })()
    `);
    await new Promise((r) => setTimeout(r, 900));
  }
  await shot(ws, 'electron-02-after-login');

  const bellClicked = await evaluate(ws, `
    (function() {
      const bell = document.querySelector('.incoming-orders-bell .icon-btn');
      if (bell) { bell.click(); return true; }
      return false;
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));
  await shot(ws, 'electron-03-bell-dropdown');
  console.log('bellClicked:', bellClicked);

  await evaluate(ws, `document.body.click()`); // close dropdown
  await new Promise((r) => setTimeout(r, 300));

  const settingsClicked = await evaluate(ws, `
    (function() {
      const els = Array.from(document.querySelectorAll('button, a, div, li, span'));
      const el = els.find((x) => x.children.length === 0 && /^Settings$/i.test(x.textContent.trim()));
      if (el) { el.click(); return true; }
      const el2 = els.find((x) => /Settings/i.test(x.textContent) && x.textContent.length < 20);
      if (el2) { el2.click(); return true; }
      return false;
    })()
  `);
  await new Promise((r) => setTimeout(r, 800));
  await shot(ws, 'electron-04-settings');
  console.log('settingsClicked:', settingsClicked);

  const scrolled = await evaluate(ws, `
    (function() {
      const els = Array.from(document.querySelectorAll('h1, h2, h3'));
      const target = els.find((e) => e.textContent.toLowerCase().includes('integration'));
      if (target) { target.scrollIntoView({ block: 'start' }); return true; }
      return false;
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
  await shot(ws, 'electron-05-integrations-section');
  console.log('scrolledToIntegrations:', scrolled);

  // Enable the Zomato toggle + fill dummy creds + save, then use the real
  // Simulate Test Order button to exercise the whole pipeline end-to-end.
  await evaluate(ws, `
    (function() {
      const cb = document.querySelector('.integration-toggle input[type="checkbox"]');
      if (cb && !cb.checked) { cb.click(); }
      return !!cb;
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));
  await evaluate(ws, `
    (function() {
      const inputs = Array.from(document.querySelectorAll('.integration-card')[0].querySelectorAll('input[type="text"], input:not([type])'));
      const setVal = (el, val) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      if (inputs[0]) setVal(inputs[0], '12345');
      return inputs.length;
    })()
  `);
  await evaluate(ws, `
    (function() {
      const pwd = document.querySelectorAll('.integration-card')[0].querySelector('input[type="password"]');
      if (pwd) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(pwd, 'dummy-api-key');
        pwd.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return !!pwd;
    })()
  `);
  await evaluate(ws, `
    (function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find((x) => /save integration settings/i.test(x.textContent));
      if (b) b.click();
      return !!b;
    })()
  `);
  await new Promise((r) => setTimeout(r, 900));
  await shot(ws, 'electron-06-zomato-enabled-with-simulate-button');

  const simulateClicked = await evaluate(ws, `
    (function() {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find((x) => /simulate test order/i.test(x.textContent));
      if (b) b.click();
      return !!b;
    })()
  `);
  await new Promise((r) => setTimeout(r, 1200));
  console.log('simulateClicked:', simulateClicked);

  // Close the settings modal, then open the bell — it should now show 1 unread.
  await evaluate(ws, `
    (function() {
      // Click on the dark overlay backdrop, outside the modal card, to close it.
      const overlay = document.querySelector('.modal-overlay, [class*="overlay"]');
      if (overlay) { overlay.click(); return 'overlay'; }
      return 'none';
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));
  await shot(ws, 'electron-07-after-close-modal');

  const bellClicked2 = await evaluate(ws, `
    (function() {
      const alreadyOpen = document.querySelector('.incoming-orders-dropdown');
      if (alreadyOpen) return 'already-open';
      const bell = document.querySelector('.incoming-orders-bell .icon-btn');
      if (bell) { bell.click(); return true; }
      return false;
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));
  await shot(ws, 'electron-08-bell-with-order');
  console.log('bellClicked2:', bellClicked2);

  // Now emulate a narrow (mobile-width) viewport to verify the CSS
  // responsive overrides for the bell dropdown / integrations modal, per the
  // standing "always check mobile too" rule — this validates the Electron
  // window resized narrow (e.g. a small laptop), not the separate Capacitor
  // mobile app (which doesn't render these two features at all).
  await sendCmd(ws, 'Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await new Promise((r) => setTimeout(r, 500));
  await shot(ws, 'electron-09-mobile-width-bell-dropdown');

  await evaluate(ws, `
    (function() {
      const closeBtn = document.querySelector('.modal-close-inline');
      if (closeBtn) closeBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
  const settingsClicked2 = await evaluate(ws, `
    (function() {
      const els = Array.from(document.querySelectorAll('button, a, div, li, span'));
      const el = els.find((x) => x.children.length === 0 && /^Settings$/i.test(x.textContent.trim()));
      if (el) { el.click(); return true; }
      return false;
    })()
  `);
  await new Promise((r) => setTimeout(r, 700));
  await evaluate(ws, `
    (function() {
      const els = Array.from(document.querySelectorAll('h1, h2, h3'));
      const target = els.find((e) => e.textContent.toLowerCase().includes('integration'));
      if (target) target.scrollIntoView({ block: 'start' });
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
  await shot(ws, 'electron-10-mobile-width-integrations-section');
  console.log('settingsClicked2:', settingsClicked2);

  await sendCmd(ws, 'Emulation.clearDeviceMetricsOverride');
  ws.close();
}

main().catch((err) => {
  console.error('SCRIPT ERROR:', err);
  process.exit(1);
});
