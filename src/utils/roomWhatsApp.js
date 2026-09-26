import { shareBillFile } from './billShare.js';

const TEMPLATE_KEYS = {
  booking: 'whatsapp_room_booking_template',
  checkin: 'whatsapp_room_checkin_template',
  checkout: 'whatsapp_room_checkout_template',
};
const TRIGGER_KEYS = {
  booking: 'whatsapp_send_room_booking',
  checkin: 'whatsapp_send_room_checkin',
  checkout: 'whatsapp_send_room_checkout',
};
const DEFAULT_TEMPLATES = {
  booking: '✅ Hi {guest_name}, Your Booking is Confirmed at {hotel_name} 🎉\n\n📅 Your Booking Details:\n\nBooking ID: {booking_number}\nCheck-in: {check_in}\nCheck-out: {check_out}\nRoom/Bed: {room}\n\nTotal Amount: {total}\nAmount Paid: {advance}\n\n📞 For any queries, please contact the property: {hotel_phone}.\n📍 Location: {hotel_address}\n\nLooking forward to hosting you!\n{hotel_name} Team',
  checkin: '✅ Welcome {guest_name} to {hotel_name}! 🎉\n\nBooking ID: {booking_number}\nRoom/Bed: {room}\nCheck-out: {check_out}\n\n📞 For queries: {hotel_phone}\n📍 Location: {hotel_address}\n\nWe hope you have a pleasant stay!\n{hotel_name} Team',
  checkout: '✅ Thank you for staying with {hotel_name}, {guest_name}!\n\nBooking ID: {booking_number}\nRoom/Bed: {room}\nTotal Amount: {total}\nAmount Paid: {advance}\n\n📞 For queries: {hotel_phone}\n📍 Location: {hotel_address}\n\nWe look forward to hosting you again!\n{hotel_name} Team',
};

function isMobileRuntime() {
  if (typeof window === 'undefined') return false;
  if (typeof window.Capacitor?.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) return true;
  return typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function formatWhatsAppNumber(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = `91${digits}`;
  else if (digits.length === 11 && digits.startsWith('0')) digits = `91${digits.slice(1)}`;
  return digits;
}

function roomName(booking) {
  const room = booking.roomNumber || booking.room_number || booking.room;
  const type = booking.roomType || booking.room_type;
  return room ? `${room}${type ? ` (${type})` : ''}` : '';
}

function formatRoomTemplate(template, booking, settings, bill) {
  const values = {
    guest_name: booking.guestName || booking.guest_name || '',
    hotel_name: settings.room_biz_name || settings.hotel_name || 'Hotel',
    booking_number: booking.bookingNumber || booking.booking_number || '',
    check_in: booking.checkInDate || booking.check_in_date || '',
    check_out: booking.checkOutDate || booking.check_out_date || '',
    room: roomName(booking),
    total: bill?.total ?? booking.total ?? '',
    advance: bill?.advance_payment ?? booking.advancePayment ?? 0,
    hotel_phone: settings.room_biz_phone || settings.hotel_phone || '',
    hotel_address: settings.room_biz_address || settings.hotel_address || '',
  };
  return String(template || DEFAULT_TEMPLATES.booking)
    .replace(/\{(\w+)\}/g, (_, key) => values[key] == null ? '' : String(values[key]));
}

function addReviewRequest(message, settings) {
  const reviewLink = settings.whatsapp_room_review_link || '';
  if (settings.whatsapp_checkout_review_request !== 'true' || !reviewLink) return message;
  return `${message}\n\n⭐ Enjoyed your stay? Please rate us here:\n${reviewLink}`;
}

export async function handoffRoomWhatsApp(kind, booking, bill) {
  if (!isMobileRuntime() || !booking) return false;
  const phoneNumber = booking.guestPhone || booking.guest_phone || booking.customerPhone || '';
  if (!phoneNumber) return false;
  const settings = await window.api.getSettings();
  if (settings[TRIGGER_KEYS[kind]] !== 'true') return false;

  if (kind === 'checkout' && bill) {
    const message = addReviewRequest(
      formatRoomTemplate(settings[TEMPLATE_KEYS[kind]] || DEFAULT_TEMPLATES[kind], booking, settings, bill),
      settings,
    );
    await shareBillFile({
      ...bill,
      source: 'ROOM',
      guestName: booking.guestName || booking.guest_name || '',
      guestPhone: phoneNumber,
      booking_number: booking.bookingNumber || booking.booking_number,
      roomNumber: booking.roomNumber || booking.room_number,
      roomType: booking.roomType || booking.room_type,
      hotelName: bill.hotelName || settings.room_biz_name || settings.hotel_name,
      hotelAddress: bill.hotelAddress || settings.room_biz_address || settings.hotel_address,
      hotelPhone: bill.hotelPhone || settings.room_biz_phone || settings.hotel_phone,
      billFooter: bill.billFooter || settings.room_bill_footer,
    }, message);
    return true;
  }

  const roomMessage = formatRoomTemplate(
    settings[TEMPLATE_KEYS[kind]] || DEFAULT_TEMPLATES[kind],
    booking,
    settings,
    bill,
  );
  const text = kind === 'checkout' ? addReviewRequest(roomMessage, settings) : roomMessage;
  const plugin = window.Capacitor?.isNativePlatform?.()
    ? window.Capacitor.Plugins?.MobileHost
    : null;
  if (typeof plugin?.shareViaWhatsApp === 'function') {
    await plugin.shareViaWhatsApp({ text, phoneNumber });
    return true;
  }
  const recipient = formatWhatsAppNumber(phoneNumber);
  if (!recipient) return false;
  window.open(
    `https://wa.me/${recipient}?text=${encodeURIComponent(text)}`,
    '_blank',
    'noopener,noreferrer',
  );
  return true;
}
