// Shared "how much of a room-booking-group's upfront advance applies to a
// given room's own bill" math, used by both the Bookings list/table and the
// Room Calendar detail view so the two never show conflicting numbers.
// Mirrors the same capping/carry-forward logic used server-side at actual
// checkout (db/roomService.cjs checkOut()): an advance larger than one
// room's own charge is capped at that room's total instead of pushing its
// balance negative, with the remainder left for whichever other room(s) in
// the group are checked out.
export function computeRoomCharge(room) {
  // Use calendar-day subtraction (date-only) so time-of-day never affects
  // the night count — 1h stay == 1 night, 1d 13h stay == 1 night (not 2).
  const d1 = new Date(String(room.checkInDate || '').slice(0, 10));
  const d2 = new Date(String(room.checkOutDate || '').slice(0, 10));
  const dayDiff = Math.round((d2 - d1) / 86400000);
  const nights = Math.max(1, dayDiff || 1);
  const addonTotal = room.addonTotal != null ? room.addonTotal : (room.addons || []).reduce((s, a) => s + a.total, 0);
  const raw = +((room.roomRate || 0) * nights + addonTotal + (room.touristTax || 0) - (room.discount || 0)).toFixed(2);
  // Clamp to 0 — a discount larger than the room charge is valid (e.g. a
  // complimentary stay) but a negative displayed total is never meaningful.
  const total = Math.max(0, raw);
  return { nights, total };
}

// rooms: every room-booking in one reservation group. For rows already
// CHECKED_OUT, the real amount actually deducted at that checkout
// (advanceApplied) is used as-is — it's a fixed historical fact. For rows
// still pending, this is only a best-effort PREVIEW of how the remaining
// advance would be allocated (the real amount is only decided at each
// room's own actual checkout time).
export function allocateGroupAdvance(rooms) {
  const totalGroupAdvance = rooms.reduce((s, r) => s + (r.advancePayment || 0), 0);
  const alreadyApplied = rooms
    .filter((r) => r.status === 'CHECKED_OUT')
    .reduce((s, r) => s + (r.advanceApplied || 0), 0);
  let remaining = +(totalGroupAdvance - alreadyApplied).toFixed(2);

  return rooms.map((r) => {
    const { nights, total } = computeRoomCharge(r);
    let advance;
    if (r.status === 'CHECKED_OUT') {
      advance = r.advanceApplied || 0;
    } else {
      advance = Math.max(0, Math.min(remaining, total));
      remaining = +(remaining - advance).toFixed(2);
    }
    const balanceDue = +(total - advance).toFixed(2);
    return { room: r, nights, total, advance, balanceDue };
  });
}
