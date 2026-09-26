// Regression checks for bill/KOT window orchestration and print profiles.
// These are source-contract tests because Electron BrowserWindow and physical
// printer drivers are not available in the Node test process.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const main = read('electron/main.cjs');
const cart = read('src/components/Cart/Cart.jsx');
const billWindow = read('src/components/Bill/BillWindow.jsx');
const groupWindow = read('src/components/Bill/GroupBillWindow.jsx');
const reporting = read('src/components/Reporting/ReportingPage.jsx');
const mobileApi = read('src/mobile/webApi.js');
const css = read('src/index.css');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notStrictEqual(startIndex, -1, `Could not find section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notStrictEqual(endIndex, -1, `Could not find section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

console.log('\n=== Print/window orchestration regressions ===');

test('bill creation does not open duplicate Bill/KOT windows', () => {
  const createHandler = section(main, "ipcMain.handle('bill:create'", "ipcMain.handle('bill:getById'");
  assert.doesNotMatch(createHandler, /\bshowBillWindow\s*\(/);
  assert.doesNotMatch(createHandler, /\bshowKotWindow\s*\(/);
});

test('Generate Bill actions have one renderer-owned post-bill path', () => {
  const handler = section(cart, 'async function handleGenerateBill(printMode)', 'async function handleCancelOrder');
  assert.match(handler, /window\.api\.printKot\(bill\.id\)/);
  assert.match(handler, /window\.api\.printBill\(bill\.id\)/);
  assert.match(handler, /window\.api\.openBillWindow\(bill\.id\)/);
  assert.strictEqual((handler.match(/window\.api\.openBillWindow\(bill\.id\)/g) || []).length, 1);
});

test('desktop food/room printing uses native page size and selected routing', () => {
  const handler = section(main, "ipcMain.handle('print:bill'", "ipcMain.handle('print:kot'");
  assert.match(handler, /settings\.room_printer_name/);
  assert.match(handler, /settings\.food_printer_name/);
  assert.match(handler, /pageSize:/);
  assert.match(handler, /width: 210000, height: 297000/);
  assert.match(handler, /paperWidth/);
});

test('desktop KOT printing uses the native thermal page profile', () => {
  const handler = section(main, "ipcMain.handle('print:kot'", '// ---- Download Receipt');
  assert.match(handler, /settings\.kot_printer_name/);
  assert.match(handler, /pageSize: \{ width: 80000, height: 300000 \}/);
});

test('bill popup Print button uses native printBill instead of raw browser print', () => {
  assert.match(billWindow, /window\.api\?\.printBill/);
  assert.match(billWindow, /window\.print\(\)/);
  assert.match(billWindow, /else if/);
});

test('Reporting View opens the shared printer-aware bill window for desktop and mobile', () => {
  assert.strictEqual((reporting.match(/window\.api\.openBillWindow\(b\.id\)/g) || []).length, 2);
  assert.match(billWindow, /window\.api\?\.printBill/);
  assert.match(mobileApi, /openBillWindow\(id\)/);
});

test('room invoice windows are scoped to the A4 print page', () => {
  assert.match(billWindow, /room-bill-window/);
  assert.match(groupWindow, /room-bill-window/);
  assert.match(css, /@page room \{ size: A4 portrait; margin: 14mm; \}/);
});

test('mobile room and food printing navigate to the bill route then use system print', () => {
  const printFunction = section(mobileApi, 'async function printBill(id)', 'async function openKotWindow');
  assert.match(printFunction, /navigateTo\(`#\/bill\/\$\{id\}`\)/);
  assert.match(printFunction, /window\.print\(\)/);
  assert.match(printFunction, /setTimeout/);
});

test('bill loading state cannot crash when bill data is still null', () => {
  assert.match(billWindow, /bill\?\.source === 'ROOM'/);
});

console.log(`\n==================================================`);
console.log(`RESULT: ${passed} passed, ${failed} failed (of ${passed + failed} total)`);
if (failed) {
  console.error(failures.map(({ name, err }) => `${name}: ${err.message}`).join('\n'));
  process.exitCode = 1;
}
