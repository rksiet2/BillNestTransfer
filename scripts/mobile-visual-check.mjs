// One-off script: drive the app in a phone-sized headless browser to visually
// verify mobile UI fixes. Not part of the app build; safe to delete after use.
import puppeteer from 'puppeteer-core';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT_DIR = 'C:\\Users\\e101361';

function shot(page, name) {
  return page.screenshot({ path: `${OUT_DIR}\\${name}.png` });
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: 'new',
    defaultViewport: { width: 390, height: 844 },
  });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));

  // Bypass the first-run wizard/login entirely by seeding state directly
  // through window.api (same localStorage-backed demo API the UI itself
  // uses) — much more reliable than driving the multi-step wizard forms.
  await page.evaluate(async () => {
    await window.api.saveSettings({ hotel_name: 'Test Hotel', hotel_address: '123 Test Street', setup_completed: 'true' });
    await window.api.createOwnerAccount({ name: 'Owner', pin: '1234' });
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));

  // Log in with the PIN via the on-screen keypad, then tap Unlock (a 4-digit
  // PIN doesn't auto-submit — only reaching the 6-digit max does).
  for (const digit of '1234') {
    await page.evaluate((d) => {
      const btns = Array.from(document.querySelectorAll('.pin-keypad button'));
      const btn = btns.find((b) => b.textContent.trim() === d);
      if (btn) btn.click();
    }, digit);
    await new Promise((r) => setTimeout(r, 150));
  }
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Unlock');
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 1000));
  await shot(page, 'v-03-after-login');

  await browser.close();
}

main().catch((err) => {
  console.error('SCRIPT ERROR:', err);
  process.exit(1);
});
