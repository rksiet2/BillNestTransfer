// Regression tests for the offline Assistant engine (kbParser + engine +
// liveDataIntents). Pure Node/ESM — no Electron, no real database. Verifies:
//   1. The knowledge base markdown parses into the expected number of Q&A
//      entries and a known question matches its own answer.
//   2. A live-data question ("what's today's revenue?") is routed to a
//      live-data intent and calls the (mocked) window.api, not the KB.
//   3. A clearly out-of-scope / general-knowledge question is declined with
//      the fixed fallback message instead of being "answered" incorrectly.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseKb } from '../src/assistant/kbParser.js';
import { answerQuestion, OUT_OF_SCOPE_MESSAGE } from '../src/assistant/engine.js';
import { isBookingRequest, createBookingSession, processBookingStep } from '../src/assistant/bookingWizard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kbRaw = fs.readFileSync(path.join(__dirname, '..', 'docs', 'assistant-kb.md'), 'utf8');
const kbEntries = parseKb(kbRaw);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL: ${name} -> ${err.message}`);
    failed += 1;
  }
}
async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL: ${name} -> ${err.message}`);
    failed += 1;
  }
}

console.log('\n=== Assistant knowledge base parsing ===');

test('knowledge base parses into multiple Q&A entries', () => {
  assert.ok(kbEntries.length >= 20, `expected at least 20 KB entries, got ${kbEntries.length}`);
});

test('every KB entry has a non-empty question and answer', () => {
  for (const e of kbEntries) {
    assert.ok(e.question && e.question.trim().length > 0, 'entry missing question');
    assert.ok(e.answer && e.answer.trim().length > 0, `entry "${e.question}" has an empty answer`);
  }
});

console.log('\n=== Assistant engine: KB question matching ===');

await asyncTest('a specific how-to question matches its own KB answer', async () => {
  const { text, source } = await answerQuestion('How do I cancel a booking?', { kbEntries, api: null });
  assert.strictEqual(source, 'kb');
  assert.ok(/cancel/i.test(text) && /booking/i.test(text), 'answer should be about cancelling a booking');
});

await asyncTest('a differently-worded question still matches the right KB entry', async () => {
  const { text, source } = await answerQuestion('how to add a new food item to the menu', { kbEntries, api: null });
  assert.strictEqual(source, 'kb');
  assert.ok(/food item/i.test(text), 'answer should be about adding a food item');
});

console.log('\n=== Assistant engine: live-data intents ===');

await asyncTest('"what is today\'s revenue" is answered from live data, not the KB', async () => {
  const mockApi = {
    getSummary: async (period) => {
      assert.strictEqual(period, 'today');
      return { revenue: 5400, orderCount: 12, cashRevenue: 3200, onlineRevenue: 2200, cancelledCount: 1 };
    },
  };
  const { text, source } = await answerQuestion("what is today's revenue?", { kbEntries, api: mockApi });
  assert.strictEqual(source, 'live-data');
  assert.ok(text.includes('5,400.00'), `expected formatted revenue in answer, got: ${text}`);
});

await asyncTest('"how many rooms are available" calls getRoomAvailability and lists free rooms', async () => {
  const mockApi = {
    getRoomAvailability: async () => ([
      { room_number: '101', isAvailable: true },
      { room_number: '102', isAvailable: false },
      { room_number: '103', isAvailable: true },
    ]),
  };
  const { text, source } = await answerQuestion('how many rooms are available right now?', { kbEntries, api: mockApi });
  assert.strictEqual(source, 'live-data');
  assert.ok(text.includes('101') && text.includes('103') && !text.includes('102'), `expected only available rooms listed, got: ${text}`);
});

console.log('\n=== Assistant engine: out-of-scope questions are declined ===');

await asyncTest('a general-knowledge question outside the app is declined, not guessed at', async () => {
  const { text, source } = await answerQuestion('what is the capital of France?', { kbEntries, api: null });
  assert.strictEqual(source, 'out-of-scope');
  assert.strictEqual(text, OUT_OF_SCOPE_MESSAGE);
});

await asyncTest('a nonsense/unrelated question is declined', async () => {
  const { text, source } = await answerQuestion('tell me a joke about robots', { kbEntries, api: null });
  assert.strictEqual(source, 'out-of-scope');
  assert.strictEqual(text, OUT_OF_SCOPE_MESSAGE);
});

console.log('\n=== Assistant: guided booking-creation chat wizard ===');

test('"book a room" is recognized as a booking request, casual chat is not', () => {
  assert.strictEqual(isBookingRequest('I want to book a room for tonight'), true);
  assert.strictEqual(isBookingRequest('create a new booking for a guest'), true);
  assert.strictEqual(isBookingRequest('what is today\'s revenue?'), false);
  assert.strictEqual(isBookingRequest('how do I add a food item?'), false);
});

await asyncTest('the full booking wizard walks through every step and creates a booking via api.createBooking', async () => {
  const created = [];
  const mockApi = {
    listRooms: async () => ([
      { id: 7, room_number: '101', room_type: 'Standard', base_price: 1800, status: 'ACTIVE' },
      { id: 8, room_number: '102', room_type: 'Deluxe', base_price: 2500, status: 'ACTIVE' },
      { id: 9, room_number: '103', room_type: 'Standard', base_price: 1800, status: 'MAINTENANCE' },
    ]),
    createBooking: async (payload) => {
      created.push(payload);
      return { bookingNumber: 'BKG-TEST-0001', roomNumber: '101', status: 'BOOKED' };
    },
  };

  let session = createBookingSession();
  let step;

  step = await processBookingStep(session, 'Rahul Sharma', mockApi);
  assert.strictEqual(step.session.step, 'guestPhone');
  session = step.session;

  step = await processBookingStep(session, '9999911111', mockApi);
  assert.strictEqual(step.session.step, 'room');
  assert.ok(step.reply.includes('101') && step.reply.includes('102') && !step.reply.includes('103'), 'room list should exclude the MAINTENANCE room');
  session = step.session;

  step = await processBookingStep(session, '101', mockApi);
  assert.strictEqual(step.session.step, 'checkIn');
  session = step.session;

  step = await processBookingStep(session, '2026-12-10', mockApi);
  assert.strictEqual(step.session.step, 'checkOut');
  session = step.session;

  step = await processBookingStep(session, '2026-12-12', mockApi);
  assert.strictEqual(step.session.step, 'paymentMethod');
  session = step.session;

  step = await processBookingStep(session, 'cash', mockApi);
  assert.strictEqual(step.session.step, 'advance');
  session = step.session;

  step = await processBookingStep(session, 'skip', mockApi);
  assert.strictEqual(step.session.step, 'confirm');
  assert.ok(step.reply.includes('Rahul Sharma') && step.reply.includes('101'), 'confirmation summary should include guest name and room');
  session = step.session;

  step = await processBookingStep(session, 'yes', mockApi);
  assert.strictEqual(step.done, true);
  assert.ok(step.reply.includes('BKG-TEST-0001'), 'success reply should include the created booking number');
  assert.strictEqual(created.length, 1, 'createBooking should be called exactly once');
  assert.strictEqual(created[0].rooms[0].roomId, 7, 'the wizard should have resolved room "101" to its numeric room id');
  assert.strictEqual(created[0].contacts[0].name, 'Rahul Sharma');
  assert.strictEqual(created[0].paymentMethod, 'CASH');
});

await asyncTest('typing "cancel" at any point aborts the booking wizard', async () => {
  const session = createBookingSession();
  const step = await processBookingStep(session, 'cancel', { listRooms: async () => [] });
  assert.strictEqual(step.done, true);
  assert.strictEqual(step.session, null);
});

console.log(`\n${'='.repeat(50)}\nRESULT: ${passed} passed, ${failed} failed (of ${passed + failed} total)\n${'='.repeat(50)}`);
if (failed > 0) process.exit(1);
