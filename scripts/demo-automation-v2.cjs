// Automated demo walkthrough driven over Chrome DevTools Protocol (CDP)
// against the already-running Electron app (started with
// --remote-debugging-port=9222). Used to showcase functionality live while
// the user screen-records. Moves a visible on-screen cursor to each element
// before clicking (slowly) so viewers can follow along, then pauses longer
// between steps. Safe/no-op on failures per-step (logs and moves on).
const puppeteer = require('puppeteer-core');

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Injects a visible fake cursor dot (real Electron windows have no OS cursor
// visible to a screen recording when driven via CDP synthetic events).
async function injectCursor(page) {
  await page.evaluate(() => {
    if (document.getElementById('__demo_cursor__')) return;
    const el = document.createElement('div');
    el.id = '__demo_cursor__';
    el.style.cssText = `
      position: fixed; width: 22px; height: 22px; border-radius: 50%;
      background: rgba(225,29,72,0.35); border: 2px solid #e11d48;
      box-shadow: 0 0 0 4px rgba(225,29,72,0.15);
      pointer-events: none; z-index: 999999; transform: translate(-50%, -50%);
      left: -100px; top: -100px; transition: left 0.05s linear, top 0.05s linear;
    `;
    document.body.appendChild(el);
  });
}

async function setCursorPos(page, x, y) {
  await page.evaluate((px, py) => {
    const el = document.getElementById('__demo_cursor__');
    if (el) { el.style.left = px + 'px'; el.style.top = py + 'px'; }
  }, x, y);
}

// Smoothly glides the (real + fake-visual) cursor to the center of the given
// element handle, then returns its coordinates.
async function moveToElement(page, handle) {
  if (!handle) return false;
  const box = await handle.boundingBox();
  if (!box) return false;
  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;
  await page.mouse.move(targetX, targetY, { steps: 24 });
  await setCursorPos(page, targetX, targetY);
  await wait(350);
  return { x: targetX, y: targetY };
}

async function findByText(page, selector, text) {
  const handle = await page.evaluateHandle((sel, txt) => {
    const els = Array.from(document.querySelectorAll(sel));
    return els.find((el) => el.textContent.trim().toLowerCase().includes(txt.toLowerCase())) || null;
  }, selector, text);
  const el = handle.asElement();
  return el || null;
}

async function clickText(page, selector, text) {
  const el = await findByText(page, selector, text);
  if (!el) return false;
  await moveToElement(page, el);
  await el.click();
  return true;
}

async function clickSelector(page, selector) {
  const el = await page.$(selector);
  if (!el) return false;
  await moveToElement(page, el);
  await el.click();
  return true;
}

async function typeInto(page, selector, text) {
  const el = await page.$(selector);
  if (!el) return false;
  await moveToElement(page, el);
  await el.click();
  await el.type(text, { delay: 90 });
  return true;
}

async function step(label, fn) {
  console.log('>>', label);
  try { await fn(); } catch (err) { console.log('   (skip)', err.message); }
  await wait(2200);
}

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  let pages = await browser.pages();

  // Close any leftover Bill/KOT popup windows from a previous run so we don't
  // accidentally attach to one of those instead of the main window.
  for (const p of pages) {
    const url = p.url();
    if (url.includes('localhost:5173') && (url.includes('/#/kot') || url.includes('/#/bill'))) {
      try { await p.close(); } catch (_) { /* ignore */ }
    }
  }
  pages = await browser.pages();

  // Prefer the main window: served from localhost:5173 and NOT a kot/bill popup route.
  const page = pages.find((p) => {
    const url = p.url();
    return url.includes('localhost:5173') && !url.includes('/#/kot') && !url.includes('/#/bill');
  }) || pages[0];
  await page.bringToFront();
  await injectCursor(page);
  console.log('Connected to', page.url());

  await step('Show Billing page (default)', async () => {
    await clickText(page, '.nav-item', 'Billing');
  });

  await step('Hover sidebar to reveal labels', async () => {
    const sidebar = await page.$('.sidebar');
    await moveToElement(page, sidebar);
    await wait(900);
  });

  await step('Browse categories', async () => {
    const tabs = await page.$$('.cat-tab');
    if (tabs[1]) { await moveToElement(page, tabs[1]); await tabs[1].click(); }
  });

  await step('Clear category filter', async () => {
    await clickText(page, '.cat-clear-btn', 'Clear');
  });

  await step('Search for a food item', async () => {
    await typeInto(page, '.search-bar input', 'paneer');
  });

  await step('Clear search', async () => {
    await clickSelector(page, '.search-clear');
  });

  await step('Add first item to cart (+ Add)', async () => {
    await clickSelector(page, '.btn-add');
  });

  await step('Increase quantity via qty stepper (+)', async () => {
    const plus = await page.$('.food-card .qty-btn:last-child');
    if (plus) {
      await moveToElement(page, plus);
      await plus.click(); await wait(500); await plus.click();
    }
  });

  await step('Add a second item to cart', async () => {
    const btns = await page.$$('.btn-add');
    if (btns[1]) { await moveToElement(page, btns[1]); await btns[1].click(); }
  });

  await step('Enter customer name', async () => {
    await typeInto(page, '.customer-input', 'Demo Customer');
  });

  await step('Add kitchen note for KOT', async () => {
    await typeInto(page, '.order-note-input', 'Less spicy please');
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

  await wait(1800);

  await step('Reopen KOT window from toast', async () => {
    await clickText(page, '.toast-action', 'Reopen KOT');
  });

  await step('Inspect any newly opened Bill/KOT windows', async () => {
    const all = await browser.pages();
    for (const p of all) {
      if (p !== page) { await p.bringToFront(); await wait(2000); }
    }
    await page.bringToFront();
  });

  await step('Go to Search module', async () => {
    await clickText(page, '.nav-item', 'Search');
  });

  await step('Search across full menu', async () => {
    await typeInto(page, 'input[placeholder*="Search all food"]', 'chicken');
  });

  await step('Add a search result to cart', async () => {
    await clickSelector(page, '.btn-add');
  });

  await step('Demonstrate order cancellation', async () => {
    await clickText(page, '.btn-secondary', 'Cancel Order');
    await wait(700);
    await clickText(page, '.btn-danger', 'Yes, Cancel');
  });

  // ---------------- Inventory: add raw material, link recipe, sell, see it reflected ----------------
  await step('Go to Inventory module', async () => {
    await clickText(page, '.nav-item', 'Inventory');
  });

  await step('Open Raw Materials & Stock tab', async () => {
    await clickText(page, '.cat-tab', 'Raw Materials');
  });

  const demoMaterialName = 'Demo Mozzarella Cheese';

  await step('Add a new raw material', async () => {
    await typeInto(page, '.fm-form input', demoMaterialName);
  });

  await step('Set opening stock for the new raw material', async () => {
    const stockInput = await page.$('.fm-form input[type="number"]');
    if (stockInput) { await moveToElement(page, stockInput); await stockInput.click(); await stockInput.type('20', { delay: 90 }); }
  });

  await step('Set low-stock threshold', async () => {
    const numberInputs = await page.$$('.fm-form input[type="number"]');
    if (numberInputs[1]) { await moveToElement(page, numberInputs[1]); await numberInputs[1].click(); await numberInputs[1].type('5', { delay: 90 }); }
  });

  await step('Set cost per unit', async () => {
    const numberInputs = await page.$$('.fm-form input[type="number"]');
    if (numberInputs[2]) { await moveToElement(page, numberInputs[2]); await numberInputs[2].click(); await numberInputs[2].type('450', { delay: 90 }); }
  });

  await step('Save the new raw material', async () => {
    await clickText(page, '.btn-primary', 'Add Material');
  });

  await step('Go to Food Management to link this raw material to a recipe', async () => {
    await clickText(page, '.nav-item', 'Food');
  });

  await step('Open the first menu item for editing', async () => {
    await clickText(page, '.btn-link', 'Edit');
  });

  await step('Scroll down to this item\'s Recipe editor', async () => {
    await page.evaluate(() => {
      const el = document.querySelector('.recipe-editor');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    await wait(500);
  });

  await step('Add an ingredient row and pick the new raw material', async () => {
    await clickText(page, '.btn-secondary', 'Add Ingredient');
    const selects = await page.$$('.recipe-row select');
    const lastSelect = selects[selects.length - 1];
    if (lastSelect) {
      await moveToElement(page, lastSelect);
      await lastSelect.select(await lastSelect.evaluate((sel, name) => {
        const opt = Array.from(sel.options).find((o) => o.textContent.includes(name));
        return opt ? opt.value : sel.value;
      }, demoMaterialName));
    }
  });

  await step('Enter quantity used per serving', async () => {
    const qtyInputs = await page.$$('.recipe-row input[type="number"]');
    const lastQty = qtyInputs[qtyInputs.length - 1];
    if (lastQty) { await moveToElement(page, lastQty); await lastQty.click(); await lastQty.type('0.05', { delay: 90 }); }
  });

  await step('Save the recipe (links raw material -> auto stock deduction on sale)', async () => {
    await clickText(page, '.btn-primary', 'Save Recipe');
  });

  await step('Go back to Billing to sell that item', async () => {
    await clickText(page, '.nav-item', 'Billing');
  });

  await step('Add the linked item to the cart', async () => {
    await clickSelector(page, '.btn-add');
  });

  await step('Generate the bill for this sale', async () => {
    await clickText(page, '.btn-primary', 'Generate Bill');
  });

  await wait(1800);

  await step('Back to Inventory to see the raw material stock reduced', async () => {
    await clickText(page, '.nav-item', 'Inventory');
  });

  await step('Open Raw Materials & Stock tab again', async () => {
    await clickText(page, '.cat-tab', 'Raw Materials');
  });

  await step('Point at the new material row (stock now reduced by the sale)', async () => {
    const row = await findByText(page, '.fm-table tbody tr', demoMaterialName);
    if (row) { await moveToElement(page, row); await wait(1200); }
  });

  await step('Open Reports tab to see it counted under "Consumed (Sales)"', async () => {
    await clickText(page, '.cat-tab', 'Reports');
  });

  await step('Point at the consumption report row for this material', async () => {
    const row = await findByText(page, '.fm-table tbody tr', demoMaterialName);
    if (row) { await moveToElement(page, row); await wait(1500); }
  });

  await step('Go to Reporting to see the sale reflected in today\'s revenue', async () => {
    await clickText(page, '.nav-item', 'Reporting');
  });

  await step('Point at the Revenue stat card', async () => {
    const card = await findByText(page, '.stat-card', 'Revenue');
    if (card) { await moveToElement(page, card); await wait(1500); }
  });

  await step('Hover the trend chart to show tooltip', async () => {
    const svg = await page.$('.trend-chart-svg');
    if (svg) {
      const box = await svg.boundingBox();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 20 });
      await setCursorPos(page, box.x + box.width * 0.5, box.y + box.height * 0.5);
      await wait(700);
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4, { steps: 20 });
      await setCursorPos(page, box.x + box.width * 0.7, box.y + box.height * 0.4);
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
    await wait(800);
  });

  await step('Open Settings from bottom-left of sidebar', async () => {
    await clickText(page, '.nav-item-settings', 'Settings');
  });

  await wait(1200);

  await step('Close Settings modal', async () => {
    await clickSelector(page, '.modal-close');
  });

  await step('Back to Billing to finish', async () => {
    await clickText(page, '.nav-item', 'Billing');
  });

  console.log('Demo walkthrough complete.');
  await browser.disconnect();
})();
