// Automated demo walkthrough driven over Chrome DevTools Protocol (CDP)
// against the already-running Electron app (started with
// --remote-debugging-port=9222). Used to showcase functionality live while
// the user screen-records. Safe/no-op on failures per-step (logs and moves on).
const puppeteer = require('puppeteer-core');

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function clickText(page, selector, text) {
  const handle = await page.evaluateHandle((sel, txt) => {
    const els = Array.from(document.querySelectorAll(sel));
    return els.find((el) => el.textContent.trim().toLowerCase().includes(txt.toLowerCase()));
  }, selector, text);
  const el = handle.asElement();
  if (el) { await el.click(); return true; }
  return false;
}

async function step(label, fn) {
  console.log('>>', label);
  try { await fn(); } catch (err) { console.log('   (skip)', err.message); }
  await wait(1300);
}

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().includes('localhost:5173')) || pages[0];
  await page.bringToFront();
  console.log('Connected to', page.url());

  await step('Show Billing page (default)', async () => {
    await clickText(page, '.nav-item', 'Billing');
  });

  await step('Hover sidebar to reveal labels', async () => {
    const sidebar = await page.$('.sidebar');
    const box = await sidebar.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  });

  await step('Browse categories', async () => {
    const tabs = await page.$$('.cat-tab');
    if (tabs[1]) await tabs[1].click();
  });

  await step('Clear category filter', async () => {
    await clickText(page, '.cat-clear-btn', 'Clear');
  });

  await step('Search for a food item', async () => {
    const input = await page.$('.search-bar input');
    if (input) { await input.click(); await input.type('paneer', { delay: 60 }); }
  });

  await step('Clear search', async () => {
    await clickText(page, '.search-clear', '');
  });

  await step('Add first item to cart (+ Add)', async () => {
    const btn = await page.$('.btn-add');
    if (btn) await btn.click();
  });

  await step('Increase quantity via qty stepper (+)', async () => {
    const plus = await page.$('.food-card .qty-btn:last-child');
    if (plus) { await plus.click(); await plus.click(); }
  });

  await step('Add a second item to cart', async () => {
    const btns = await page.$$('.btn-add');
    if (btns[1]) await btns[1].click();
  });

  await step('Enter customer name', async () => {
    const input = await page.$('.customer-input');
    if (input) { await input.click(); await input.type('Demo Customer', { delay: 50 }); }
  });

  await step('Add kitchen note for KOT', async () => {
    const ta = await page.$('.order-note-input');
    if (ta) { await ta.click(); await ta.type('Less spicy please', { delay: 50 }); }
  });

  await step('Switch payment method to Online (show UPI QR)', async () => {
    await clickText(page, '.pay-btn', 'Online');
  });

  await step('Switch payment method back to Cash', async () => {
    await clickText(page, '.pay-btn', 'Cash');
  });

  await step('Generate the bill', async () => {
    await clickText(page, '.btn-primary', 'Generate Bill');
  });

  await wait(1500);

  await step('Reopen KOT window from toast', async () => {
    await clickText(page, '.toast-action', 'Reopen KOT');
  });

  await step('Inspect any newly opened Bill/KOT windows', async () => {
    const all = await browser.pages();
    for (const p of all) {
      if (p !== page) {
        await p.bringToFront();
        await wait(1600);
      }
    }
    await page.bringToFront();
  });

  await step('Go to Search module', async () => {
    await clickText(page, '.nav-item', 'Search');
  });

  await step('Search across full menu', async () => {
    const input = await page.$('input[placeholder*="Search all food"]');
    if (input) { await input.click(); await input.type('chicken', { delay: 60 }); }
  });

  await step('Add a search result to cart', async () => {
    const btn = await page.$('.btn-add');
    if (btn) await btn.click();
  });

  await step('Demonstrate order cancellation', async () => {
    await clickText(page, '.btn-secondary', 'Cancel Order');
    await wait(600);
    await clickText(page, '.btn-danger', 'Yes, Cancel');
  });

  await step('Go to Food Management module', async () => {
    await clickText(page, '.nav-item', 'Food');
  });

  await step('Show veg/non-veg badges in item list', async () => {
    await page.$('.fm-table');
  });

  await step('Go to Inventory module', async () => {
    await clickText(page, '.nav-item', 'Inventory');
  });

  await step('Show inventory tabs', async () => {
    const tabs = await page.$$('.cat-tab, .tab-btn, .inv-tab');
    if (tabs[1]) await tabs[1].click();
  });

  await step('Go to Reporting module', async () => {
    await clickText(page, '.nav-item', 'Reporting');
  });

  await step('View Today summary + trend chart', async () => {
    await wait(500);
  });

  await step('Hover the trend chart to show tooltip', async () => {
    const svg = await page.$('.trend-chart-svg');
    if (svg) {
      const box = await svg.boundingBox();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await wait(400);
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4);
    }
  });

  await step('Switch to Weekly view', async () => {
    await clickText(page, '.cat-tab', 'Weekly');
  });

  await step('Switch to Monthly view', async () => {
    await clickText(page, '.cat-tab', 'Monthly');
  });

  await step('Switch to Annually view (year seeded data)', async () => {
    await clickText(page, '.cat-tab', 'Annually');
  });

  await step('Switch to All Time view (full 1-year dataset)', async () => {
    await clickText(page, '.cat-tab', 'All Time');
  });

  await step('Scroll to Sales History table', async () => {
    await page.evaluate(() => {
      const el = document.querySelector('.reporting-page');
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
  });

  await step('Open Settings from bottom-left of sidebar', async () => {
    await clickText(page, '.nav-item-settings', 'Settings');
  });

  await wait(1200);

  await step('Close Settings modal', async () => {
    const closeBtn = await page.$('.modal-close');
    if (closeBtn) await closeBtn.click();
  });

  await step('Back to Billing to finish', async () => {
    await clickText(page, '.nav-item', 'Billing');
  });

  console.log('Demo walkthrough complete.');
  await browser.disconnect();
})();
