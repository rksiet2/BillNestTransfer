// MakeMyTrip / Goibibo Channel Manager adapter — same POLLING model, but
// this platform sends ROOM BOOKINGS instead of food orders.
//
// ⚠️ PLACEHOLDER ENDPOINTS: real base URL / auth / field names come from
// MMT's B2B Channel Manager partner API docs once approved
// (https://hotels.makemytrip.com). Update BASE_URL + the "REPLACE ME"
// mappings below when you have them — nothing else needs to change.

const BASE_URL = 'https://api.makemytrip.com/channel-manager/v1'; // REPLACE ME with real base URL from docs

async function fetchNewOrders({ apiKey, partnerId }) {
  try {
    const res = await fetch(`${BASE_URL}/properties/${partnerId}/bookings?status=new`, {
      headers: { Authorization: `Bearer ${apiKey}` }, // REPLACE ME with real auth scheme
    });
    if (!res.ok) return [];
    const data = await res.json();
    // REPLACE ME: map MMT's real response shape to this normalized shape.
    return (data.bookings || []).map((b) => ({
      externalId: b.booking_id,
      platform: 'MMT',
      kind: 'ROOM_BOOKING',
      guestName: b.guest_name,
      guestPhone: b.guest_phone,
      roomType: b.room_type,
      numGuests: b.num_guests || 1,
      checkInDate: b.check_in_date,
      checkOutDate: b.check_out_date,
      total: b.total_amount,
      raw: b,
    }));
  } catch {
    return [];
  }
}

async function acceptOrder({ apiKey, partnerId }, externalId) {
  try {
    const res = await fetch(`${BASE_URL}/properties/${partnerId}/bookings/${externalId}/confirm`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function rejectOrder({ apiKey, partnerId }, externalId, reason) {
  try {
    const res = await fetch(`${BASE_URL}/properties/${partnerId}/bookings/${externalId}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || 'No availability' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { platform: 'MMT', fetchNewOrders, acceptOrder, rejectOrder };
