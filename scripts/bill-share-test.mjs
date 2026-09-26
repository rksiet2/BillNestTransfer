import assert from 'node:assert/strict';
import { createBillShareFile, createBillShareMessage, shareBillFile } from '../src/utils/billShare.js';
import { handoffRoomWhatsApp } from '../src/utils/roomWhatsApp.js';

const canvasCalls = [];
const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
function createContext() {
  return {
    font: '400 16px Arial',
    measureText(text) {
      const size = Number(this.font.match(/\d+px/)?.[0]?.replace('px', '')) || 16;
      return { width: String(text).length * size * 0.52 };
    },
    fillRect() {},
    fillText() {},
    setLineDash() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    drawImage() {},
  };
}
globalThis.document = {
  createElement(tagName) {
    assert.equal(tagName, 'canvas');
    const canvas = {
      getContext: () => createContext(),
      toBlob(callback, type) {
        assert.equal(type, 'image/jpeg');
        callback(new Blob([fakeJpeg], { type }));
      },
    };
    canvasCalls.push(canvas);
    return canvas;
  },
};

const testBill = {
  id: 42,
  bill_number: 'INV-TEST-0042',
  token: 'B01',
  payment_method: 'CASH',
  customer_name: 'Test Customer',
  customer_phone: '9876543210',
  hotelName: 'BillNest Test Cafe',
  hotelAddress: 'Test address',
  hotelPhone: '01123456789',
  hotelGstin: 'TEST-GSTIN',
  billFooter: 'Thanks for visiting',
  created_at: '2026-09-26T10:00:00.000Z',
  subtotal: 8000,
  tax_percent: 5,
  tax_amount: 400,
  discount: 100,
  total: 8300,
  advance_payment: 0,
  items: Array.from({ length: 90 }, (_, index) => ({
    id: index + 1,
    name: `Test menu item ${index + 1}`,
    quantity: 1,
    price: 100,
    total: 100,
  })),
};

const pdf = await createBillShareFile(testBill);
assert.equal(pdf.type, 'application/pdf');
assert.equal(pdf.name, 'Bill-INV-TEST-0042.pdf');
const pdfBytes = new Uint8Array(await pdf.arrayBuffer());
const pdfText = new TextDecoder('latin1').decode(pdfBytes);
assert.ok(pdfText.startsWith('%PDF-1.4'));
assert.match(pdfText, /\/Count [2-9]\d*/);
assert.match(pdfText, /\/Subtype \/Image/);
assert.ok(canvasCalls.length > 1, 'bill spanning multiple pages creates a page canvas per page');
assert.equal(
  createBillShareMessage(testBill, 'Hello {customer_name}: {bill_number} from {business_name}, total {total}.'),
  'Hello Test Customer: INV-TEST-0042 from BillNest Test Cafe, total ₹8,300.00.',
  'custom food bill WhatsApp template fills customer, business, bill number, and total',
);

const startXref = Number(pdfText.match(/startxref\n(\d+)\n%%EOF$/)?.[1]);
assert.ok(Number.isInteger(startXref), 'PDF contains a final cross-reference offset');
assert.ok(pdfText.slice(startXref).startsWith('xref\n'), 'cross-reference offset points to the xref table');
const xref = pdfText.slice(startXref);
const entries = [...xref.matchAll(/(\d{10}) 00000 n/g)].map((match) => Number(match[1]));
entries.forEach((offset, index) => {
  assert.ok(pdfText.startsWith(`${index + 1} 0 obj\n`, offset), `xref entry ${index + 1} points to its PDF object`);
});

let capturedShare;
globalThis.window = {
  Capacitor: {
    isNativePlatform: () => true,
    Plugins: {
      MobileHost: {
        async shareViaWhatsApp(payload) {
          capturedShare = payload;
        },
      },
    },
  },
};
await shareBillFile(testBill);
assert.ok(capturedShare, 'native WhatsApp share plugin is invoked');
assert.equal(capturedShare.phoneNumber, '9876543210');
assert.equal(capturedShare.fileName, 'Bill-INV-TEST-0042.pdf');
assert.equal(capturedShare.mimeType, 'application/pdf');
assert.match(capturedShare.text, /Hi Test Customer/);
assert.match(capturedShare.text, /₹8,300\.00/);
assert.ok(atob(capturedShare.fileBase64).startsWith('%PDF-1.4'));

const roomMessages = [];
globalThis.window.api = {
  async getSettings() {
    return {
      whatsapp_send_room_booking: 'true',
      whatsapp_send_room_checkin: 'true',
      whatsapp_send_room_checkout: 'true',
      whatsapp_checkout_review_request: 'true',
      whatsapp_room_review_link: 'https://example.test/reviews',
      whatsapp_room_booking_template: 'Booking {booking_number} for {guest_name}: room {room}, total {total}.',
      whatsapp_room_checkin_template: 'Welcome {guest_name} to {hotel_name}; room {room}; checkout {check_out}.',
      whatsapp_room_checkout_template: 'Thanks {guest_name}; invoice {booking_number}; total {total}.',
      room_biz_name: 'Test Hotel',
    };
  },
};
globalThis.window.Capacitor.Plugins.MobileHost.shareViaWhatsApp = async (payload) => roomMessages.push(payload);
const bookingHandedOff = await handoffRoomWhatsApp('booking', {
  bookingNumber: 'BKG-00042',
  guestName: 'Test Guest',
  guestPhone: '9876543210',
  roomNumber: '101',
  total: 1800,
});
assert.equal(bookingHandedOff, true);
assert.equal(roomMessages[0].phoneNumber, '9876543210');
assert.match(roomMessages[0].text, /Booking BKG-00042 for Test Guest: room 101/);
const handedOff = await handoffRoomWhatsApp('checkin', {
  guestName: 'Test Guest',
  guestPhone: '9876543210',
  roomNumber: '101',
  checkOutDate: '2026-09-27',
});
assert.equal(handedOff, true);
assert.equal(roomMessages[1].phoneNumber, '9876543210');
assert.match(roomMessages[1].text, /Welcome Test Guest to Test Hotel; room 101/);
const checkoutHandedOff = await handoffRoomWhatsApp('checkout', {
  bookingNumber: 'BKG-00042',
  guestName: 'Test Guest',
  guestPhone: '9876543210',
  roomNumber: '101',
  roomType: 'Standard',
}, { ...testBill, id: 43, bill_number: 'INV-ROOM-0043', source: 'ROOM' });
assert.equal(checkoutHandedOff, true);
assert.equal(roomMessages[2].phoneNumber, '9876543210');
assert.equal(roomMessages[2].fileName, 'Bill-INV-ROOM-0043.pdf', 'room checkout shares the existing checkout bill number');
assert.equal(roomMessages[2].mimeType, 'application/pdf');
assert.match(roomMessages[2].text, /Thanks Test Guest; invoice BKG-00042/);
assert.match(roomMessages[2].text, /Please rate us here:\nhttps:\/\/example\.test\/reviews/);
const checkoutPdf = atob(roomMessages[2].fileBase64);
assert.ok(checkoutPdf.startsWith('%PDF-1.4'));
assert.match(roomMessages[2].text, /total 8300/, 'checkout message uses the amount from its existing bill');

console.log('PASS: bill share PDF is multi-page with valid xref offsets.');
console.log('PASS: WhatsApp payload includes customer phone, PDF attachment, and prefilled message.');
console.log('PASS: booking and check-in triggers hand off the saved customer phone and rendered templates.');
console.log('PASS: room checkout trigger attaches a PDF and its rendered template to the customer handoff.');
