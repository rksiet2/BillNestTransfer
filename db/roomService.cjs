// Room Booking / PMS business logic. Reuses the existing billing engine
// (service.createBill) at checkout so booking revenue automatically flows
// into the same Sales Reporting / Sales History / print system.
const { getDb, nextBookingNumber } = require('./database.cjs');
const service = require('./service.cjs');

// ---------------- Rooms ----------------
function getRooms() {
  return getDb().prepare('SELECT * FROM rooms ORDER BY room_number').all();
}

function saveRoom(room) {
  const db = getDb();
  if (room.id) {
    db.prepare(
      `UPDATE rooms SET room_number=?, room_type=?, base_price=?, max_occupancy=?, status=?, notes=? WHERE id=?`
    ).run(
      room.room_number,
      room.room_type,
      room.base_price,
      room.max_occupancy,
      room.status || 'ACTIVE',
      room.notes || null,
      room.id
    );
    return room.id;
  }
  const info = db.prepare(
    `INSERT INTO rooms (room_number, room_type, base_price, max_occupancy, status, notes) VALUES (?,?,?,?,?,?)`
  ).run(room.room_number, room.room_type, room.base_price, room.max_occupancy || 2, room.status || 'ACTIVE', room.notes || null);
  return info.lastInsertRowid;
}

function deleteRoom(id) {
  const db = getDb();
  const activeBookings = db
    .prepare(`SELECT COUNT(*) c FROM room_bookings WHERE room_id = ? AND status IN ('BOOKED','CHECKED_IN')`)
    .get(id).c;
  if (activeBookings > 0) throw new Error('Cannot delete a room with active bookings.');
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  return true;
}

function toggleRoomMaintenance(id, underMaintenance) {
  getDb().prepare('UPDATE rooms SET status = ? WHERE id = ?').run(underMaintenance ? 'MAINTENANCE' : 'ACTIVE', id);
  return true;
}

// Strips a datetime string to its YYYY-MM-DD date part for purely date-based
// overlap checks. Standard hotel policy: checkout on day X and checkin on day X
// are always compatible — the room is handed over, never double-occupied.
function dateOnly(v) {
  return (v || '').slice(0, 10);
}

// Returns every room annotated with its status for the given date range —
// combines what used to be two separate views (a plain availability check,
// and a separate "today" status board) into one: isAvailable drives the
// "Book This Room" button, while todayStatus/guestName/isCheckedIn surface
// who (if anyone) is booked into that room for the selected dates so the
// front desk can see availability AND current occupancy in a single screen.
// Color coding: AVAILABLE (green), RESERVED (blue - booked, not arrived),
// OCCUPIED (red - checked in), MAINTENANCE (yellow - out of service).
function getRoomAvailability({ from, to }) {
  const db = getDb();
  const rooms = getRooms();
  const range = from && to ? { from, to } : { from: new Date().toISOString().slice(0, 10), to: null };

  // One row per room for whichever BOOKED/CHECKED_IN booking overlaps the
  // requested range (defaults to "today onward" if no range is given).
  // CHECKED_IN takes priority over BOOKED if a room somehow has both.
  const overlapping = range.to
    ? db
        .prepare(
          `SELECT * FROM room_bookings
           WHERE status IN ('BOOKED','CHECKED_IN')
           AND NOT (date(check_out_date) <= ? OR date(check_in_date) >= ?)
           ORDER BY (status = 'CHECKED_IN') DESC, id DESC`
        )
        .all(dateOnly(range.from), dateOnly(range.to))
    : db
        .prepare(
          `SELECT * FROM room_bookings
           WHERE status IN ('BOOKED','CHECKED_IN')
           AND date(check_out_date) > ?
           ORDER BY (status = 'CHECKED_IN') DESC, id DESC`
        )
        .all(dateOnly(range.from));
  const bookingByRoom = new Map();
  for (const b of overlapping) {
    if (!bookingByRoom.has(b.room_id)) bookingByRoom.set(b.room_id, b);
  }

  return rooms.map((r) => {
    const booking = bookingByRoom.get(r.id) || null;
    let todayStatus = 'AVAILABLE';
    if (r.status === 'MAINTENANCE') todayStatus = 'MAINTENANCE';
    else if (booking?.status === 'CHECKED_IN') todayStatus = 'OCCUPIED';
    else if (booking?.status === 'BOOKED') todayStatus = 'RESERVED';

    return {
      ...r,
      isAvailable: r.status === 'ACTIVE' && !booking,
      todayStatus,
      guestName: booking?.guest_name || null,
      isCheckedIn: booking?.status === 'CHECKED_IN',
      bookingId: booking?.id || null,
      checkInDate: booking?.check_in_date || null,
      checkOutDate: booking?.check_out_date || null,
    };
  });
}

// Tape-chart / Gantt-style calendar data: for every room, every booking
// (BOOKED or CHECKED_IN) whose stay overlaps [from, to) — same "standard
// hotel PMS booking calendar" view seen in tools like Cloudbeds/RoomRaccoon
// (rooms as rows, days as columns, a colored bar per booking spanning its
// check-in→check-out). The frontend positions each bar via CSS grid-column
// using checkInDate/checkOutDate, so all date math stays in one place here.
function getRoomCalendar({ from, to }) {
  const db = getDb();
  const rooms = getRooms();
  const bookings = db
    .prepare(
      `SELECT * FROM room_bookings
       WHERE status IN ('BOOKED','CHECKED_IN','CHECKED_OUT')
       AND NOT (date(check_out_date) <= ? OR date(check_in_date) >= ?)
       ORDER BY check_in_date`
    )
    .all(dateOnly(from), dateOnly(to));

  // Group bookings can include rooms whose own stay window falls outside
  // [from, to) (e.g. a 3-room group booked for different nights), so group
  // size is computed across ALL of a group's rooms, not just the ones in
  // this date window — otherwise the "group" badge would flicker on/off
  // depending on which week/month is being viewed.
  const groupIds = [...new Set(bookings.map((b) => b.booking_group_id).filter(Boolean))];
  const groupCounts = new Map();
  if (groupIds.length) {
    const placeholders = groupIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT booking_group_id, COUNT(DISTINCT room_id) as roomCount
         FROM room_bookings
         WHERE booking_group_id IN (${placeholders}) AND status != 'CANCELLED'
         GROUP BY booking_group_id`
      )
      .all(...groupIds);
    for (const row of rows) groupCounts.set(row.booking_group_id, row.roomCount);
  }

  const byRoom = new Map();
  for (const b of bookings) {
    if (!byRoom.has(b.room_id)) byRoom.set(b.room_id, []);
    const groupRoomCount = b.booking_group_id ? (groupCounts.get(b.booking_group_id) || 1) : 1;
    byRoom.get(b.room_id).push({
      id: b.id,
      guestName: b.guest_name,
      checkInDate: b.check_in_date,
      // Keep the original booked interval visible on the tape chart after
      // early checkout. Availability uses actual_check_out separately, so a
      // new booking can overlap this faded historical bar without hiding it.
      checkOutDate: b.check_out_date,
      actualCheckOut: b.actual_check_out,
      status: b.status,
      bookingGroupId: b.booking_group_id || null,
      isGroupBooking: groupRoomCount > 1,
      groupRoomCount,
    });
  }
  return rooms.map((r) => ({
    ...r,
    roomNumber: r.room_number,
    roomType: r.room_type,
    bookings: byRoom.get(r.id) || [],
  }));
}

// ---------------- Bookings ----------------
// Hotel nights are always counted as CALENDAR DAYS between check-in and
// check-out dates — time-of-day is irrelevant. A guest who checks in Sep 14
// and checks out Sep 15 pays 1 night whether that's 21 hours or 26 hours.
// Using Math.round(hours/24) was wrong in two ways:
//   • A very short same-day stay (< 12 h) rounded to 0 → only Math.max(1,…)
//     saved it, but the reason for the 1-night floor was hidden.
//   • A 1-day-13-hour stay rounded to 2 and silently overcharged the guest.
// Date-only subtraction removes both problems cleanly.
function nights(checkIn, checkOut) {
  // Slice to date-only "YYYY-MM-DD" before constructing Date objects so that
  // any time component (T14:00, space-separated, or ISO offset) doesn't shift
  // the result — "2026-09-14T14:00" and "2026-09-15T11:00" both resolve to
  // the same calendar-day diff of 1, which is exactly 1 hotel night.
  const d1 = new Date(String(checkIn).slice(0, 10));
  const d2 = new Date(String(checkOut).slice(0, 10));
  const n = Math.round((d2 - d1) / 86400000);
  // Minimum 1 night: a same-day (or zero-duration) booking still generates
  // one night's charge — there is no concept of a "half-day" or "2-hour rate".
  return Math.max(1, n);
}

// Small local date formatter for backend error messages only (no access to
// the frontend's formatDate util here) — turns "2026-09-12T11:00" into a
// readable "12 Sep, 11:00". When the stored value has no time (date-only) or
// the time is exactly midnight (00:00), omits the time portion — midnight is
// just the SQLite default for date-only entries and is meaningless to display.
function fmtClashDate(v) {
  if (!v) return '';
  const normalised = v.length === 10 ? `${v}T00:00` : v.replace(' ', 'T');
  const d = new Date(normalised);
  if (Number.isNaN(d.getTime())) return v;
  const day = d.getDate();
  const month = d.toLocaleString('en-US', { month: 'short' });
  const pad = (n) => String(n).padStart(2, '0');
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  // Only append time if it carries meaningful information (not midnight default)
  if (hh === '00' && mm === '00') return `${day} ${month}`;
  return `${day} ${month}, ${hh}:${mm}`;
}

// Strips a datetime string to its YYYY-MM-DD date part so the overlap check
// is purely date-based. This matches standard hotel checkout/checkin policy:
// Includes the room number AND the clashing booking's own guest/date details
// in the error — a bare "not available" message left the front desk unable
// to tell WHICH room (in a multi-room submission) and WHICH existing stay
// was the actual conflict, especially since the calendar's day-cell
// free/busy highlighting only works at whole-day granularity and can look
// deceptively "free" once the view scrolls/collapses next to a checkout day.
//
// The overlap test uses date-only comparison (via SQLite's date() function) so
// that a same-day checkout/checkin turnaround is never treated as a conflict:
//   existing.check_out == new.check_in  → no conflict (date(x) >= date(x) is TRUE → excluded)
//   existing.check_in  == new.check_out → no conflict (date(x) <= date(x) is TRUE → excluded)
function assertRoomAvailable(roomId, checkIn, checkOut, excludeBookingId) {
  const db = getDb();
  // Normalise incoming dates to YYYY-MM-DD before binding — both datetime-
  // local strings ("2026-09-15T11:00") and plain dates ("2026-09-15") reduce
  // to the same 10-char prefix, making the SQLite date() comparison reliable
  // regardless of what format the caller passed in.
  const checkInDate = dateOnly(checkIn);
  const checkOutDate = dateOnly(checkOut);
  let query = `SELECT id, guest_name, check_in_date, check_out_date, actual_check_out FROM room_bookings
               WHERE room_id = ? AND status IN ('BOOKED','CHECKED_IN')
               AND NOT (
                 date(check_in_date) >= ?
                 OR date(CASE WHEN actual_check_out IS NOT NULL THEN actual_check_out ELSE check_out_date END) <= ?
               )`;
  const params = [roomId, checkOutDate, checkInDate];
  if (excludeBookingId) {
    query += ' AND id != ?';
    params.push(excludeBookingId);
  }
  const clash = db.prepare(query).get(...params);
  if (clash) {
    const room = db.prepare('SELECT room_number FROM rooms WHERE id = ?').get(roomId);
    const roomLabel = room ? `Room ${room.room_number}` : 'Selected room';
    throw new Error(
      `${roomLabel} is not available for the chosen dates — it's already booked for ${clash.guest_name || 'a guest'} ` +
      `from ${fmtClashDate(clash.check_in_date)} to ${fmtClashDate(clash.check_out_date)}.`
    );
  }
}

function makeBookingGroupId() {
  return `BG${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

// Creates one or more room bookings from a single "New Booking" submission.
// Accepts either the modern shape — payload.rooms: [{roomId, roomRate,
// numGuests}, ...] and payload.contacts: [{name, phone, email,
// specialRequest}, ...] (supports booking several rooms + several guest
// contacts together) — or the original flat single-room shape (payload.roomId
// / payload.guestName / payload.guestPhone directly), which is normalized
// into a 1-item rooms/contacts array so existing callers keep working
// unchanged. All rooms created in one call share a booking_group_id so the
// front desk can see/manage them as one reservation; the primary (first)
// contact is also mirrored onto each room row's guest_name/guest_phone for
// backward compatibility with checkout/reporting/receipts that only know
// about a single guest per room. Any advance payment collected upfront is
// recorded once (on the first room of the group) and deducted as a visible
// line item on the final invoice at checkout.
function createBooking(payload) {
  const db = getDb();
  const rooms = Array.isArray(payload.rooms) && payload.rooms.length
    ? payload.rooms
    : [{ roomId: payload.roomId, roomRate: payload.roomRate, numGuests: payload.numGuests, checkInDate: payload.checkInDate, checkOutDate: payload.checkOutDate }];
  const contacts = Array.isArray(payload.contacts) && payload.contacts.length
    ? payload.contacts.filter((c) => c && c.name)
    : [{ name: payload.guestName, phone: payload.guestPhone, email: payload.guestEmail, specialRequest: payload.specialRequest }];

  const primaryContact = contacts[0];
  if (!primaryContact?.name) throw new Error('Guest name is required.');
  if (!rooms.length || !rooms[0].roomId) throw new Error('At least one room must be selected.');

  // Each room row may carry its OWN check-in/check-out dates (e.g. one guest
  // booking Room 101 for this weekend and Room 201 for next week in a single
  // reservation) — falling back to the shared payload-level dates when a
  // room row doesn't specify its own, so the simple single-date-range case
  // (the common one) still only needs to be entered once.
  const effectiveRooms = rooms.map((r) => ({
    ...r,
    checkInDate: r.checkInDate || payload.checkInDate,
    checkOutDate: r.checkOutDate || payload.checkOutDate,
  }));
  for (const r of effectiveRooms) {
    if (!r.checkInDate || !r.checkOutDate) throw new Error('Check-in and check-out dates are required for every room.');
    if (r.checkOutDate <= r.checkInDate) throw new Error('Check-out date must be after check-in date.');
  }

  const groupId = makeBookingGroupId();
  const createdIds = [];
  // All rooms in one "New Booking" submission belong to the SAME
  // reservation, so they share one master Booking # (this is what real
  // hotel PMS front desks expect — "Booking BKG-...-0017" covering every
  // room in that reservation, not a different-looking number per room).
  // booking_number still has a UNIQUE DB constraint (each row is its own
  // room-stay with independent status/checkout), so rooms after the first
  // get a "-R2", "-R3", ... suffix on the SAME master number instead of an
  // entirely different sequence number.
  const masterBookingNumber = nextBookingNumber();

  // Wrapped in a single DB transaction: if ANY room in a multi-room booking
  // fails (unavailable, under maintenance, etc.), better-sqlite3 automatically
  // rolls back every insert made so far in this call — otherwise rooms
  // processed before the failing one would stay booked even though the whole
  // submission reported an error to the user.
  const runInTransaction = db.transaction(() => {
    effectiveRooms.forEach((r, idx) => {
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(r.roomId);
      if (!room) throw new Error('Room not found.');
      if (room.status !== 'ACTIVE') throw new Error(`Room ${room.room_number} is under maintenance and cannot be booked.`);
      assertRoomAvailable(room.id, r.checkInDate, r.checkOutDate);

      const bookingNumber = idx === 0 ? masterBookingNumber : `${masterBookingNumber}-R${idx + 1}`;
      const roomRate = r.roomRate != null ? r.roomRate : room.base_price;

      const info = db
        .prepare(
          `INSERT INTO room_bookings
           (booking_number, room_id, booking_group_id, guest_name, guest_phone, guest_id_type, guest_id_number,
            guest_gstin, guest_id_document_path, guest_id_document_paths, num_guests, check_in_date, check_out_date, room_rate,
            tourist_tax, discount, tax_percent, payment_method, advance_payment, advance_payment_method, status, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'BOOKED',?)`
        )
        .run(
          bookingNumber,
          room.id,
          groupId,
          primaryContact.name,
          primaryContact.phone || null,
          payload.guestIdType || null,
          payload.guestIdNumber || null,
          payload.guestGstin || null,
          Array.isArray(payload.guestIdDocumentPaths) ? (payload.guestIdDocumentPaths[0] || null) : (payload.guestIdDocumentPath || null),
          JSON.stringify(Array.isArray(payload.guestIdDocumentPaths) ? payload.guestIdDocumentPaths : (payload.guestIdDocumentPath ? [payload.guestIdDocumentPath] : [])),
          r.numGuests || payload.numGuests || 1,
          r.checkInDate,
          r.checkOutDate,
          roomRate,
          payload.touristTax || 0,
          idx === 0 ? payload.discount || 0 : 0,
          payload.taxPercent != null ? payload.taxPercent : 0,
          payload.paymentMethod || null,
          idx === 0 ? payload.advancePayment || 0 : 0,
          payload.advancePaymentMethod || null,
          payload.notes || null
        );
      const bookingId = info.lastInsertRowid;

      if (idx === 0 && Array.isArray(payload.addons)) {
        for (const a of payload.addons) addAddon(bookingId, a);
      }
      createdIds.push(bookingId);
    });

    for (const c of contacts) {
      if (!c?.name) continue;
      db.prepare(
        'INSERT INTO booking_contacts (booking_group_id, name, phone, email, special_request) VALUES (?,?,?,?,?)'
      ).run(groupId, c.name, c.phone || null, c.email || null, c.specialRequest || null);
    }
  });

  runInTransaction();

  return createdIds.length > 1 ? createdIds.map((id) => getBookingById(id)) : getBookingById(createdIds[0]);
}

// Adds ONE more room to an existing multi-room reservation (booking_group_id)
// after it was already created — e.g. the guest decides they need another
// room for extra family members. Reuses the group's existing guest name/ID
// details by default, but the new room can also have its OWN check-in/
// check-out dates (e.g. same guest needs a room for a different set of
// dates) — pass room.checkInDate/room.checkOutDate to override. The new
// room gets its own booking_number/status/addons so it can be managed
// (check-in/out/cancel) independently, exactly like every other room in the
// group.
function addRoomToBookingGroup(groupId, room) {
  const db = getDb();
  if (!groupId) throw new Error('This booking is not part of a group.');
  const reference = db
    .prepare('SELECT * FROM room_bookings WHERE booking_group_id = ? ORDER BY id LIMIT 1')
    .get(groupId);
  if (!reference) throw new Error('Original booking not found.');
  if (!room || !room.roomId) throw new Error('Please select a room to add.');

  const target = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.roomId);
  if (!target) throw new Error('Room not found.');
  if (target.status !== 'ACTIVE') throw new Error(`Room ${target.room_number} is under maintenance and cannot be booked.`);
  const checkInDate = room.checkInDate || reference.check_in_date;
  const checkOutDate = room.checkOutDate || reference.check_out_date;
  if (checkOutDate <= checkInDate) throw new Error('Check-out date must be after check-in date.');
  assertRoomAvailable(target.id, checkInDate, checkOutDate);

  // Share the group's master Booking # (same one shown for every other room
  // in this reservation) instead of handing out a brand new, unrelated
  // number — suffixed with the next available "-R{n}" since booking_number
  // still needs to stay unique per row. reference.booking_number is always
  // the group's original (unsuffixed) master number, since `reference` is
  // the very first room ever inserted into this group.
  const roomCount = db.prepare('SELECT COUNT(*) AS c FROM room_bookings WHERE booking_group_id = ?').get(groupId).c;
  const bookingNumber = `${reference.booking_number}-R${roomCount + 1}`;
  const roomRate = room.roomRate != null ? room.roomRate : target.base_price;

  const info = db
    .prepare(
      `INSERT INTO room_bookings
       (booking_number, room_id, booking_group_id, guest_name, guest_phone, guest_id_type, guest_id_number,
       guest_gstin, guest_id_document_path, guest_id_document_paths, num_guests, check_in_date, check_out_date, room_rate,
        tourist_tax, discount, tax_percent, payment_method, advance_payment, advance_payment_method, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'BOOKED')`
    )
    .run(
      bookingNumber,
      target.id,
      groupId,
      reference.guest_name,
      reference.guest_phone,
      reference.guest_id_type,
      reference.guest_id_number,
      reference.guest_gstin,
      reference.guest_id_document_path,
      reference.guest_id_document_paths,
      room.numGuests || 1,
      checkInDate,
      checkOutDate,
      roomRate,
      0,
      0,
      reference.tax_percent || 0,
      reference.payment_method,
      0,
      reference.advance_payment_method
    );
  return getBookingById(info.lastInsertRowid);
}

function updateBooking(id, payload) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM room_bookings WHERE id = ?').get(id);
  if (!existing) throw new Error('Booking not found.');
  if (existing.status === 'CHECKED_OUT' || existing.status === 'CANCELLED') {
    throw new Error('Cannot modify a booking that is already checked out or cancelled.');
  }

  const roomId = payload.roomId != null ? payload.roomId : existing.room_id;
  const checkInDate = payload.checkInDate || existing.check_in_date;
  const checkOutDate = payload.checkOutDate || existing.check_out_date;
  if (checkOutDate <= checkInDate) throw new Error('Check-out date must be after check-in date.');

  assertRoomAvailable(roomId, checkInDate, checkOutDate, id);

  db.prepare(
    `UPDATE room_bookings SET
      room_id=?, guest_name=?, guest_phone=?, guest_id_type=?, guest_id_number=?,
      guest_gstin=?,       guest_id_document_path=?, guest_id_document_paths=?, num_guests=?, check_in_date=?, check_out_date=?, room_rate=?,
      tourist_tax=?, discount=?, tax_percent=?, payment_method=?, advance_payment=?, advance_payment_method=?, notes=?
     WHERE id=?`
  ).run(
    roomId,
    payload.guestName != null ? payload.guestName : existing.guest_name,
    payload.guestPhone != null ? payload.guestPhone : existing.guest_phone,
    payload.guestIdType != null ? payload.guestIdType : existing.guest_id_type,
    payload.guestIdNumber != null ? payload.guestIdNumber : existing.guest_id_number,
    payload.guestGstin != null ? payload.guestGstin : existing.guest_gstin,
    Array.isArray(payload.guestIdDocumentPaths) ? (payload.guestIdDocumentPaths[0] || null) : (payload.guestIdDocumentPath != null ? payload.guestIdDocumentPath : existing.guest_id_document_path),
    payload.guestIdDocumentPaths != null ? JSON.stringify(payload.guestIdDocumentPaths) : existing.guest_id_document_paths,
    payload.numGuests != null ? payload.numGuests : existing.num_guests,
    checkInDate,
    checkOutDate,
    payload.roomRate != null ? payload.roomRate : existing.room_rate,
    payload.touristTax != null ? payload.touristTax : existing.tourist_tax,
    payload.discount != null ? payload.discount : existing.discount,
    payload.taxPercent != null ? payload.taxPercent : existing.tax_percent,
    payload.paymentMethod != null ? payload.paymentMethod : existing.payment_method,
    payload.advancePayment != null ? payload.advancePayment : existing.advance_payment,
    payload.advancePaymentMethod != null ? payload.advancePaymentMethod : existing.advance_payment_method,
    payload.notes != null ? payload.notes : existing.notes,
    id
  );

  return getBookingById(id);
}

function checkIn(id) {
  const db = getDb();
  const booking = db.prepare('SELECT * FROM room_bookings WHERE id = ?').get(id);
  if (!booking) throw new Error('Booking not found.');
  if (booking.status !== 'BOOKED') throw new Error('Only a booked reservation can be checked in.');
  // Guard against checking a guest in ahead of their actual check-in date.
  // Exception: if this room is part of a group booking and at least one other
  // room in the group is already CHECKED_IN or CHECKED_OUT today, the guest is
  // physically present — allow early check-in and advance the check-in date to
  // today so billing computes correctly (e.g. a group books two rooms for Sep 14
  // and one for Sep 16, then decides to move the Sep 16 room to today).
  const todayStr = new Date().toLocaleDateString('en-CA');
  const checkInDateOnly = (booking.check_in_date || '').slice(0, 10);
  if (checkInDateOnly > todayStr) {
    let allowEarly = false;
    if (booking.booking_group_id) {
      const { c } = db.prepare(
        `SELECT COUNT(*) c FROM room_bookings
         WHERE booking_group_id = ? AND id != ? AND status IN ('CHECKED_IN','CHECKED_OUT')`
      ).get(booking.booking_group_id, id);
      allowEarly = c > 0;
    }
    if (!allowEarly) {
      throw new Error(`This booking's check-in date is ${checkInDateOnly}, which is in the future. It can't be checked in yet.`);
    }
    // Advance check-in date to today (keep any stored time, fall back to 14:00).
    const timeComponent = (booking.check_in_date || '').slice(11) || '14:00';
    db.prepare('UPDATE room_bookings SET check_in_date = ? WHERE id = ?')
      .run(`${todayStr}T${timeComponent}`, id);
  }
  // The room may have been set to MAINTENANCE after this booking was made
  // (e.g. a plumbing issue found the same morning) — front desk shouldn't
  // be able to check a guest into a room that's currently out of service.
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(booking.room_id);
  if (room && room.status !== 'ACTIVE') {
    throw new Error(`Room ${room.room_number} is currently under maintenance and cannot be checked into.`);
  }
  db.prepare(
    "UPDATE room_bookings SET status='CHECKED_IN', actual_check_in = datetime('now','localtime') WHERE id = ?"
  ).run(id);
  return getBookingById(id);
}

// Checks the guest out, generating an invoice via the shared billing engine
// (room charge + add-ons + tourist tax as line items) with no Kitchen Order
// Ticket, and links the resulting bill back to this booking. `paymentMethod`
// lets staff confirm/override how the *balance due* is actually collected at
// the checkout counter (it may differ from whatever was assumed when the
// booking/advance was first recorded).
function checkOut(id, paymentMethod) {
  const db = getDb();
  const booking = getBookingById(id);
  if (!booking) throw new Error('Booking not found.');
  if (booking.status !== 'CHECKED_IN' && booking.status !== 'BOOKED') {
    throw new Error('Booking is already checked out or cancelled.');
  }
  // Same guard as check-in: a stay can't be checked out before it has even
  // started. Exception: if this room is part of a group booking and at least
  // one other room in the group is already active today (CHECKED_IN or
  // CHECKED_OUT), the guest is physically present — allow early checkout and
  // advance the check-in date to today so the bill charges correctly.
  const todayStr = new Date().toLocaleDateString('en-CA');
  const checkInDateOnly = (booking.checkInDate || '').slice(0, 10);
  if (checkInDateOnly > todayStr) {
    let allowEarly = false;
    if (booking.bookingGroupId) {
      const db2 = getDb();
      const { c } = db2.prepare(
        `SELECT COUNT(*) c FROM room_bookings
         WHERE booking_group_id = ? AND id != ? AND status IN ('CHECKED_IN','CHECKED_OUT')`
      ).get(booking.bookingGroupId, booking.id);
      allowEarly = c > 0;
    }
    if (!allowEarly) {
      throw new Error(`This booking's check-in date is ${checkInDateOnly}, which is in the future. It can't be checked out yet.`);
    }
    // Advance check-in date to today before billing (preserves check-in time, falls back to 14:00)
    const timeComponent = (booking.checkInDate || '').slice(11) || '14:00';
    db.prepare('UPDATE room_bookings SET check_in_date = ? WHERE id = ?')
      .run(`${todayStr}T${timeComponent}`, booking.id);
    booking.checkInDate = `${todayStr}T${timeComponent}`;
  }
  const finalPaymentMethod = paymentMethod || booking.paymentMethod;
  if (!finalPaymentMethod) throw new Error('Please select a payment method before checkout.');

  const numNights = nights(booking.checkInDate, booking.checkOutDate);
  const items = [
    {
      name: `Room ${booking.roomNumber} (${booking.roomType}) x ${numNights} night${numNights > 1 ? 's' : ''}`,
      price: booking.roomRate,
      quantity: numNights,
    },
  ];
  for (const a of booking.addons) {
    items.push({ name: a.name, price: a.price, quantity: a.quantity });
  }
  if (booking.touristTax > 0) {
    items.push({ name: 'Tourist Tax', price: booking.touristTax, quantity: 1 });
  }

  // An upfront advance is collected ONCE for the whole group (recorded only
  // on the group's first room — see createBooking), but each room in the
  // group is checked out — and billed — independently, possibly on
  // different days. If the full advance were blindly deducted from
  // whichever room happens to be checked out first, a large advance against
  // a cheap/short room would push that single bill's total NEGATIVE (e.g. a
  // ₹5,000 advance against a ₹3,780 room charge). Instead, only as much of
  // the remaining advance as this room's own charge can absorb is applied
  // here; any leftover carries forward to whichever room in the group is
  // checked out next.
  const subtotal = items.reduce((sum, it) => sum + it.price * it.quantity, 0);
  const taxAmount = +(subtotal * ((booking.taxPercent || 0) / 100)).toFixed(2);
  const manualDiscount = booking.discount || 0;
  // Clamp to 0: a discount larger than the room charge (e.g. complimentary
  // stay) is valid but must never produce a negative invoice total.
  const chargeBeforeAdvance = Math.max(0, +(subtotal + taxAmount - manualDiscount).toFixed(2));

  const groupTotals = booking.bookingGroupId
    ? db
        .prepare(
          `SELECT COALESCE(SUM(advance_payment), 0) AS totalAdvance,
                  COALESCE(SUM(CASE WHEN status = 'CHECKED_OUT' THEN advance_applied ELSE 0 END), 0) AS alreadyApplied
           FROM room_bookings WHERE booking_group_id = ?`
        )
        .get(booking.bookingGroupId)
    : { totalAdvance: booking.advancePayment || 0, alreadyApplied: 0 };
  const remainingAdvance = +(groupTotals.totalAdvance - groupTotals.alreadyApplied).toFixed(2);
  const advanceToApply = Math.max(0, Math.min(remainingAdvance, Math.max(chargeBeforeAdvance, 0)));
  const advanceLeftAfterThisRoom = +(remainingAdvance - advanceToApply).toFixed(2);

  const orderNoteParts = [`Room Booking ${booking.bookingNumber} - Room ${booking.roomNumber}`];
  if (booking.guestGstin) orderNoteParts.push(`Guest GSTIN: ${booking.guestGstin}`);
  if (advanceToApply > 0) {
    const isPartial = advanceToApply < remainingAdvance;
    orderNoteParts.push(
      isPartial
        ? `Less: Advance Payment Applied ₹${advanceToApply} (of ₹${remainingAdvance} remaining advance; ₹${advanceLeftAfterThisRoom} carried forward)`
        : `Less: Advance Payment Received ₹${advanceToApply}`
    );
  } else if (advanceLeftAfterThisRoom > 0) {
    orderNoteParts.push(`Advance credit of ₹${advanceLeftAfterThisRoom} carried forward to the next room in this booking`);
  }

  const bill = service.createBill({
    items,
    paymentMethod: finalPaymentMethod,
    customerName: booking.guestName,
    discount: manualDiscount,
    advancePayment: advanceToApply,
    taxPercent: booking.taxPercent || 0,
    orderNote: orderNoteParts.join(' | '),
    skipKot: true,
    source: 'ROOM',
    bookingNumber: booking.bookingNumber,
  });

  db.prepare(
    "UPDATE room_bookings SET status='CHECKED_OUT', actual_check_out = datetime('now','localtime'), bill_id = ?, advance_applied = ? WHERE id = ?"
  ).run(bill.id, advanceToApply, id);


  return { booking: getBookingById(id), bill };
}

// Builds a read-only, "virtual" combined invoice for every room in a group
// booking — merges each room's already-generated bill (created independently
// at that room's own checkout) into one document for display/print only.
// Deliberately does NOT create a new row in `bills`: each room's revenue was
// already correctly recorded on its own bill, so a second record here would
// double-count it in Sales Reporting. Only usable once every room in the
// group has been checked out (or cancelled, which contributes no bill).
function getGroupInvoiceData(groupId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT b.*, r.room_number, r.room_type FROM room_bookings b
       JOIN rooms r ON r.id = b.room_id
       WHERE b.booking_group_id = ? ORDER BY r.room_number`
    )
    .all(groupId);
  if (!rows.length) return null;

  const pending = rows.filter((r) => r.status !== 'CHECKED_OUT' && r.status !== 'CANCELLED');
  if (pending.length > 0) {
    const roomList = pending.map((r) => `Room ${r.room_number} (${r.status.replace('_', ' ')})`).join(', ');
    throw new Error(`Cannot generate combined invoice yet — ${roomList} ${pending.length === 1 ? 'has' : 'have'} not been checked out.`);
  }

  const billedRows = rows.filter((r) => r.bill_id);
  if (!billedRows.length) return null;

  const rooms = [];
  let subtotal = 0;
  let taxAmount = 0;
  let discount = 0;
  let total = 0;
  let advancePayment = 0;
  let guestName = null;
  let latestCreatedAt = null;
  let firstBill = null;
  const paymentMethods = new Set();

  for (const row of billedRows) {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(row.bill_id);
    if (!bill) continue;
    if (!firstBill) firstBill = bill;
    const items = db.prepare('SELECT * FROM bill_items WHERE bill_id = ?').all(row.bill_id);
    rooms.push({
      bookingId: row.id,
      bookingNumber: row.booking_number,
      roomNumber: row.room_number,
      roomType: row.room_type,
      guestName: row.guest_name,
      guestPhone: row.guest_phone || '',
      numGuests: row.num_guests,
      checkInDate: row.actual_check_in || row.check_in_date,
      checkOutDate: row.actual_check_out || row.check_out_date,
      billId: bill.id,
      billNumber: bill.bill_number,
      items,
      subtotal: bill.subtotal || 0,
      taxAmount: bill.tax_amount || 0,
      discount: bill.discount || 0,
      advancePayment: bill.advance_payment || 0,
      balanceDue: bill.balance_due != null ? bill.balance_due : bill.total || 0,
      total: bill.total || 0,
      paymentMethod: bill.payment_method,
    });
    subtotal += bill.subtotal || 0;
    taxAmount += bill.tax_amount || 0;
    discount += bill.discount || 0;
    total += bill.total || 0;
    // Each room's own bill already records exactly how much of the group's
    // upfront advance was actually applied to IT (see roomService.checkOut)
    // — summing bill.advance_payment across every room in the group gives
    // the true total advance actually credited, regardless of which room
    // it was originally attached to.
    advancePayment += bill.advance_payment || 0;
    if (!guestName) guestName = row.guest_name;
    if (!latestCreatedAt || bill.created_at > latestCreatedAt) latestCreatedAt = bill.created_at;
    paymentMethods.add(bill.payment_method);
  }

  if (!rooms.length) return null;

  // Prefer each bill's own snapshot of the Hotel profile at the time it was
  // created (see bills.biz_*) over recomputing live from current Settings —
  // otherwise a later edit to the Hotel profile would retroactively change
  // what a combined invoice for an already-checked-out group shows. Old
  // bills predating the snapshot columns (biz_name IS NULL) fall back to
  // live settings, same as getBillById does for standalone bills.
  const settings = service.getSettings();
  const identity = firstBill && firstBill.biz_name
    ? {
      hotelName: firstBill.biz_name,
      hotelAddress: firstBill.biz_address || '',
      hotelPhone: firstBill.biz_phone || '',
      hotelGstin: firstBill.biz_gstin || '',
      billFooter: firstBill.biz_footer || 'Thank you! Visit again.',
      upiId: firstBill.biz_upi_id || '',
      hotelLogo: firstBill.biz_logo_path || '',
    }
    : {
      hotelName: settings.room_biz_name || 'Hotel',
      hotelAddress: settings.room_biz_address || '',
      hotelPhone: settings.room_biz_phone || '',
      hotelGstin: settings.room_biz_gstin || '',
      billFooter: settings.room_bill_footer || 'Thank you! Visit again.',
      upiId: settings.room_upi_id || '',
      hotelLogo: settings.room_biz_logo_path || '',
    };
  // Each room's booking_number shares one common master prefix (see
  // createBooking: room 1 gets the bare master number, rooms 2+ get
  // "<master>-R2", "-R3", ...) — strip any "-R{n}" suffix to recover that
  // shared master number and use it as a single overall invoice number for
  // this combined document (previously the combined invoice showed no
  // invoice number of its own at all, only each room's individual numbers).
  const groupInvoiceNumber = `${rooms[0].bookingNumber.replace(/-R\d+$/, '')}-GRP`;

  return {
    groupId,
    groupInvoiceNumber,
    guestName,
    createdAt: latestCreatedAt,
    paymentMethod: paymentMethods.size === 1 ? [...paymentMethods][0] : 'MIXED',
    rooms,
    subtotal,
    taxAmount,
    discount,
    advancePayment,
    balanceDue: +(total - advancePayment).toFixed(2),
    total,
    ...identity,
  };
}

// Cancels a booking. If it had an advance payment collected upfront, staff
// records how much of it is actually being refunded to the guest (`refund`)
// and via what method (`refundMethod`) — could be the full advance, a
// partial amount, or 0 to forfeit it as a cancellation fee. This is stored
// on the row itself (refund_amount/refund_method) so Sales Reporting and
// the booking's own detail view can show exactly what happened to the
// money instead of the advance just silently vanishing into a cancelled
// record with no trail.
function cancelBooking(id, reason, refund, refundMethod) {
  const db = getDb();
  const booking = db.prepare('SELECT * FROM room_bookings WHERE id = ?').get(id);
  if (!booking) throw new Error('Booking not found.');
  if (booking.status === 'CHECKED_OUT') throw new Error('Cannot cancel a booking that has already been checked out.');
  if (booking.status === 'CANCELLED') throw new Error('This booking is already cancelled.');
  // A checked-in guest CAN still be cancelled (e.g. they don't like the
  // room/an emergency comes up and they leave early without a normal
  // checkout) — any advance payment already collected stays recorded on
  // the booking row itself (advance_payment), so it's not lost even though
  // no bill gets generated for a cancelled stay.
  const advance = booking.advance_payment || 0;
  let refundAmount = null;
  if (advance > 0) {
    refundAmount = refund != null ? Math.max(0, Math.min(parseFloat(refund) || 0, advance)) : advance;
  }
  db.prepare(
    "UPDATE room_bookings SET status='CANCELLED', cancel_reason=?, refund_amount=?, refund_method=? WHERE id=?"
  ).run(reason || null, refundAmount, refundAmount > 0 ? (refundMethod || booking.advance_payment_method || 'CASH') : null, id);
  return getBookingById(id);
}

// Cancels every BOOKED / CHECKED_IN room in a group booking in one action.
// Already CHECKED_OUT rooms are left untouched (can't undo a completed stay).
// The group's advance payment (stored on the master room) can be partially or
// fully refunded — that refund amount and method is recorded on the master
// room row. Non-master rooms that have no advance of their own are cancelled
// with refund_amount = null (no money to return from them specifically).
function cancelGroupBooking(groupId, reason, refund, refundMethod) {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM room_bookings WHERE booking_group_id = ? ORDER BY id")
    .all(groupId);
  if (!rows.length) throw new Error('Group booking not found.');

  const cancellable = rows.filter((r) => r.status !== 'CHECKED_OUT' && r.status !== 'CANCELLED');
  if (!cancellable.length) throw new Error('All rooms in this group are already checked out or cancelled.');

  // Group-level advance is on the master room (the one without -R{n} suffix)
  const masterRow = rows.find((r) => !/-R\d+$/.test(r.booking_number || '')) || rows[0];
  const groupAdvance = masterRow.advance_payment || 0;

  db.transaction(() => {
    for (const r of cancellable) {
      const isMaster = r.id === masterRow.id;
      let rowRefundAmount = null;
      if (isMaster && groupAdvance > 0) {
        rowRefundAmount = refund != null
          ? Math.max(0, Math.min(parseFloat(refund) || 0, groupAdvance))
          : groupAdvance;
      }
      db.prepare(
        "UPDATE room_bookings SET status='CANCELLED', cancel_reason=?, refund_amount=?, refund_method=? WHERE id=?"
      ).run(
        reason || null,
        rowRefundAmount,
        rowRefundAmount > 0 ? (refundMethod || r.advance_payment_method || 'CASH') : null,
        r.id
      );
    }
  })();

  return rows.map((r) => getBookingById(r.id));
}

function addAddon(bookingId, addon) {
  const db = getDb();
  const total = +((addon.price || 0) * (addon.quantity || 1)).toFixed(2);
  const info = db
    .prepare('INSERT INTO booking_addons (booking_id, name, price, quantity, total) VALUES (?,?,?,?,?)')
    .run(bookingId, addon.name, addon.price, addon.quantity || 1, total);
  return info.lastInsertRowid;
}

function removeAddon(addonId) {
  getDb().prepare('DELETE FROM booking_addons WHERE id = ?').run(addonId);
  return true;
}

function listBookings({ status, from, to, search } = {}) {
  const db = getDb();
  let query = `SELECT b.*, r.room_number, r.room_type FROM room_bookings b
               JOIN rooms r ON r.id = b.room_id WHERE 1=1`;
  const params = [];
  if (status) {
    query += ' AND b.status = ?';
    params.push(status);
  }
  if (from) {
    query += ' AND b.check_out_date >= ?';
    params.push(from);
  }
  if (to) {
    query += ' AND b.check_in_date <= ?';
    params.push(to);
  }
  // Single free-text search box: matches guest name, guest phone, this
  // booking's own booking number, OR the bill number of any bill raised
  // against it (bills.booking_number is the same value as this booking's
  // booking_number — see database.cjs's backfillBillBookingNumbers/checkOut).
  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    query += ` AND (
      b.guest_name LIKE ?
      OR b.guest_phone LIKE ?
      OR b.booking_number LIKE ?
      OR EXISTS (SELECT 1 FROM bills bl WHERE bl.booking_number = b.booking_number AND bl.bill_number LIKE ?)
    )`;
    params.push(term, term, term, term);
  }
  query += ' ORDER BY b.check_in_date DESC, b.id DESC';
  const rows = db.prepare(query).all(...params);

  // Pull in ANY sibling rooms that belong to the same group booking but whose
  // own check-in/out dates fall outside the current filter window.
  // Example: a group books Room 101 (14 Sep), Room 102 (15 Sep), Room 103
  // (16 Sep). Filtering by "Today" (14 Sep) returns only Room 101 — but the
  // front desk needs to see ALL three rooms under that one reservation to
  // manage it properly. The fix: after the main query, collect every distinct
  // booking_group_id that appeared in the results, then fetch the full set of
  // rows for each group and merge any not already included.
  const knownIds = new Set(rows.map((r) => r.id));
  const groupIds = [...new Set(rows.map((r) => r.booking_group_id).filter(Boolean))];
  if (groupIds.length) {
    const placeholders = groupIds.map(() => '?').join(',');
    // Apply the status filter to siblings too (so "Checked Out" tab doesn't
    // suddenly show BOOKED siblings), but intentionally drop the date filter —
    // the point is to show sibling rooms regardless of their own dates.
    let siblingQuery = `SELECT b.*, r.room_number, r.room_type FROM room_bookings b
                        JOIN rooms r ON r.id = b.room_id
                        WHERE b.booking_group_id IN (${placeholders})`;
    const siblingParams = [...groupIds];
    if (status) {
      siblingQuery += ' AND b.status = ?';
      siblingParams.push(status);
    }
    siblingQuery += ' ORDER BY b.check_in_date DESC, b.id DESC';
    const siblings = db.prepare(siblingQuery).all(...siblingParams);
    for (const s of siblings) {
      if (!knownIds.has(s.id)) {
        rows.push(s);
        knownIds.add(s.id);
      }
    }
  }

  return rows.map(mapBookingRow);
}

function getBookingById(id) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT b.*, r.room_number, r.room_type FROM room_bookings b
       JOIN rooms r ON r.id = b.room_id WHERE b.id = ?`
    )
    .get(id);
  if (!row) return null;
  return mapBookingRow(row);
}

function mapBookingRow(row) {
  const db = getDb();
  const addons = db.prepare('SELECT * FROM booking_addons WHERE booking_id = ?').all(row.id);
  const contacts = row.booking_group_id
    ? db.prepare('SELECT * FROM booking_contacts WHERE booking_group_id = ? ORDER BY id').all(row.booking_group_id)
    : [];
  // Other rooms booked together in the same reservation (if any), so the UI
  // can show "3 rooms booked together" instead of just this one room.
  // Includes every field the advance-payment allocation math needs (status,
  // dates, discount, tourist tax, advance/advance-applied, and its own
  // addon total) so the UI can accurately preview "how much of the group's
  // upfront advance is left for THIS room" instead of assuming the whole
  // advance is available to every room independently.
  const groupRooms = row.booking_group_id
    ? db
        .prepare(
          `SELECT b.id, b.room_id AS roomId, r.room_number AS roomNumber, r.room_type AS roomType, b.room_rate AS roomRate,
                  b.guest_name AS guestName,
                  b.check_in_date AS checkInDate, b.check_out_date AS checkOutDate, b.status AS status,
                  b.tourist_tax AS touristTax, b.discount AS discount,
                  b.advance_payment AS advancePayment, b.advance_applied AS advanceApplied,
                  COALESCE((SELECT SUM(total) FROM booking_addons WHERE booking_id = b.id), 0) AS addonTotal
           FROM room_bookings b JOIN rooms r ON r.id = b.room_id
           WHERE b.booking_group_id = ? AND b.id != ? ORDER BY r.room_number`
        )
        .all(row.booking_group_id, row.id)
    : [];
  return {
    id: row.id,
    bookingNumber: row.booking_number,
    bookingGroupId: row.booking_group_id,
    roomId: row.room_id,
    roomNumber: row.room_number,
    roomType: row.room_type,
    groupRooms,
    guestName: row.guest_name,
    guestPhone: row.guest_phone,
    guestIdType: row.guest_id_type,
    guestIdNumber: row.guest_id_number,
    guestGstin: row.guest_gstin,
    guestIdDocumentPath: row.guest_id_document_path,
    guestIdDocumentPaths: (() => {
      try {
        const parsed = JSON.parse(row.guest_id_document_paths || '');
        return Array.isArray(parsed) && parsed.length ? parsed : (row.guest_id_document_path ? [row.guest_id_document_path] : []);
      } catch { return row.guest_id_document_path ? [row.guest_id_document_path] : []; }
    })(),
    contacts: contacts.map((c) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, specialRequest: c.special_request })),
    numGuests: row.num_guests,
    checkInDate: row.check_in_date,
    checkOutDate: row.check_out_date,
    actualCheckIn: row.actual_check_in,
    actualCheckOut: row.actual_check_out,
    roomRate: row.room_rate,
    touristTax: row.tourist_tax,
    discount: row.discount,
    taxPercent: row.tax_percent,
    paymentMethod: row.payment_method,
    advancePayment: row.advance_payment || 0,
    advancePaymentMethod: row.advance_payment_method,
    advanceApplied: row.advance_applied || 0,
    status: row.status,
    cancelReason: row.cancel_reason,
    refundAmount: row.refund_amount,
    refundMethod: row.refund_method,
    billId: row.bill_id,
    notes: row.notes,
    createdAt: row.created_at,
    addons: addons.map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: a.quantity, total: a.total })),
  };
}

module.exports = {
  getRooms,
  saveRoom,
  deleteRoom,
  toggleRoomMaintenance,
  getRoomAvailability,
  getRoomCalendar,
  createBooking,
  addRoomToBookingGroup,
  updateBooking,
  checkIn,
  checkOut,
  cancelBooking,
  cancelGroupBooking,
  addAddon,
  removeAddon,
  listBookings,
  getBookingById,
  getGroupInvoiceData,
};
