import React, { useState, useEffect } from 'react';
import { formatCurrency, splitGst } from '../../utils/format';
import TaxRateSelect from '../common/TaxRateSelect';
import { handoffRoomWhatsApp } from '../../utils/roomWhatsApp';

const ID_TYPE_OPTIONS = ['Aadhaar Card', 'PAN Card', 'Voter ID', 'Driving License', 'Passport', 'National ID Card'];

// Standard hotel check-in/check-out times (14:00 / 11:00) used as sensible
// defaults so the front desk doesn't have to type a time for every booking.
// Uses LOCAL date parts, not toISOString() (UTC) — otherwise for timezones
// ahead of UTC (e.g. India, UTC+5:30) the default date would silently roll
// back to "yesterday" during the first few hours of each local day.
function localDateStr(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function tomorrowAt(time) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${localDateStr(d)}T${time}`;
}
function tomorrowStr() {
  return tomorrowAt('11:00');
}
// When the booking's check-in falls on TODAY, defaulting the time to the
// fixed "14:00" standard check-in time causes two problems the front desk
// hit in practice: (1) if it's already past 2pm, the default is silently
// already in the past, and (2) even when it's before 2pm, by the time the
// form is filled in the real clock may pass 14:00, both making the "min"
// validation below reject the very default value the form started with.
// Defaulting to the CURRENT time for a same-day booking (matching how a
// front desk actually thinks — "check them in now") avoids both.
function checkInDefaultFor(dateStr) {
  const today = localDateStr(new Date());
  if (!dateStr || dateStr === today) return nowLocal();
  return `${dateStr}T14:00`;
}
// A booking saved before time-tracking was added may only have a plain
// "YYYY-MM-DD" — pad it with the standard time so the datetime-local input
// still renders correctly instead of showing blank.
function toDateTimeLocal(value, fallbackTime) {
  if (!value) return '';
  return value.length === 10 ? `${value}T${fallbackTime}` : value;
}
// Used as the `min` attribute on the check-in date/time picker so the
// calendar itself refuses to let the front desk pick an already-passed
// date/time, instead of only catching it after Save with an error message.
function nowLocal() {
  const d = new Date();
  d.setSeconds(0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// Datetime-local values compare fine lexically for equality/ordering
// ("YYYY-MM-DDTHH:mm"), but bookings can be stored as plain "YYYY-MM-DD"
// (see toDateTimeLocal above) — strip to the date-only prefix before any
// checkIn/checkOut overlap comparison so both shapes compare consistently.
function dateOnlyLocal(v) {
  return (v || '').slice(0, 10);
}

function blankContact() {
  return { name: '', phone: '', email: '', specialRequest: '', showEmail: false, showSpecialRequest: false };
}

// `booking` (optional): when provided, the modal edits that existing booking
// instead of creating a new one — used both for general modifications and for
// attaching/changing the guest's ID document or GSTIN after the booking was
// already created (ID proof doesn't have to be uploaded at booking time).
// NEW bookings support multiple guest contacts + multiple rooms in a single
// reservation (one shared booking_group_id, one shared stay date range);
// EDITING an existing booking still targets that one room_bookings row, so
// it keeps the simpler single-room/single-guest fields the backend's
// updateBooking() expects.
export default function BookingFormModal({ rooms, booking, preselectedRoomId, defaultCheckIn, defaultCheckOut, onClose, onSaved }) {
  const isEdit = !!booking;
  const firstRoomId = preselectedRoomId || (rooms.find((r) => r.status !== 'MAINTENANCE') || rooms[0] || {}).id || '';

  // Snapshot "now" once, when the modal first opens, instead of recomputing
  // it live on every render (every keystroke). A live-recomputed min kept
  // creeping forward past the minute the form's default value was set to —
  // so simply taking ~a minute to fill in the details made the browser
  // reject the check-in time it itself defaulted to. A fixed snapshot for
  // the whole time this modal is open avoids that race entirely.
  const [minNow, setMinNow] = useState(() => nowLocal());

  // ---- Edit-mode-only fields (single room / single guest) ----
  const [roomId, setRoomId] = useState(booking ? booking.roomId : firstRoomId);
  const [guestName, setGuestName] = useState(booking ? booking.guestName : '');
  const [guestPhone, setGuestPhone] = useState(booking ? (booking.guestPhone || '') : '');
  const [numGuests, setNumGuests] = useState(booking ? booking.numGuests : '');
  const [roomRate, setRoomRate] = useState(() => {
    if (booking) return booking.roomRate;
    const r = rooms.find((x) => x.id === firstRoomId);
    return r ? r.base_price : '';
  });

  // ---- Create-mode-only fields (multiple guests / multiple rooms) ----
  const [contacts, setContacts] = useState([blankContact()]);
  const [roomRows, setRoomRows] = useState(() => {
    const r = rooms.find((x) => x.id === firstRoomId);
    return [{ roomId: firstRoomId, roomRate: r ? r.base_price : '', numGuests: '', useOwnDates: false, checkInDate: '', checkOutDate: '' }];
  });

  // ---- Shared fields ----
  const [checkInDate, setCheckInDate] = useState(booking ? toDateTimeLocal(booking.checkInDate, '14:00') : checkInDefaultFor(defaultCheckIn));
  const [checkOutDate, setCheckOutDate] = useState(booking ? toDateTimeLocal(booking.checkOutDate, '11:00') : (defaultCheckOut ? toDateTimeLocal(defaultCheckOut, '11:00') : tomorrowStr()));
  const [checkInAuto, setCheckInAuto] = useState(!booking && !defaultCheckIn);
  const [checkOutAuto, setCheckOutAuto] = useState(!booking && !defaultCheckOut);
  const [guestIdType, setGuestIdType] = useState(booking ? (booking.guestIdType || ID_TYPE_OPTIONS[0]) : ID_TYPE_OPTIONS[0]);
  const [guestIdNumber, setGuestIdNumber] = useState(booking ? (booking.guestIdNumber || '') : '');
  const [guestGstin, setGuestGstin] = useState(booking ? (booking.guestGstin || '') : '');
  const [guestIdDocumentPaths, setGuestIdDocumentPaths] = useState(() => (
    booking?.guestIdDocumentPaths?.length
      ? booking.guestIdDocumentPaths
      : (booking?.guestIdDocumentPath ? [booking.guestIdDocumentPath] : [])
  ));
  const [touristTax, setTouristTax] = useState(booking ? (booking.touristTax || '') : '');
  const [discount, setDiscount] = useState(booking ? (booking.discount || '') : '');
  const [taxPercent, setTaxPercent] = useState(booking ? booking.taxPercent : 0);
  // Tracks whether the cashier has manually picked/edited the tax rate for
  // THIS form session. An existing booking's saved rate is respected as-is
  // until the payment method is changed (at which point we re-auto-select),
  // matching the same auto-then-overridable pattern used in Food billing's
  // Cart.
  const [taxPercentTouched, setTaxPercentTouched] = useState(!!booking);
  const [paymentMethod, setPaymentMethod] = useState(booking ? (booking.paymentMethod || 'CASH') : 'CASH');
  const [settings, setSettings] = useState(null);
  const [notes, setNotes] = useState(booking ? (booking.notes || '') : '');
  const [advancePayment, setAdvancePayment] = useState(booking ? (booking.advancePayment || '') : '');
  const [advancePaymentMethod, setAdvancePaymentMethod] = useState(booking ? (booking.advancePaymentMethod || 'CASH') : 'CASH');
  const [addons, setAddons] = useState(booking ? booking.addons.map((a) => ({ name: a.name, price: a.price, quantity: a.quantity })) : []);
  const [addonName, setAddonName] = useState('');
  const [addonPrice, setAddonPrice] = useState('');
  const [addonQty, setAddonQty] = useState(1);
  const [saving, setSaving] = useState(false);
  const [uploadingId, setUploadingId] = useState(false);
  const [error, setError] = useState('');

  // Keep untouched automatic defaults aligned with the device clock while a
  // booking window stays open. A date/time selected by the user immediately
  // becomes fixed and is never overwritten by this refresh.
  useEffect(() => {
    if (booking || (!checkInAuto && !checkOutAuto)) return undefined;
    const refreshAutomaticTimes = () => {
      if (checkInAuto) setCheckInDate(checkInDefaultFor(defaultCheckIn));
      if (checkOutAuto) setCheckOutDate(defaultCheckOut ? toDateTimeLocal(defaultCheckOut, '11:00') : tomorrowStr());
    };
    const timer = setInterval(() => {
      setMinNow(nowLocal());
      refreshAutomaticTimes();
    }, 5_000);
    return () => clearInterval(timer);
  }, [booking, checkInAuto, checkOutAuto, defaultCheckIn, defaultCheckOut]);

  useEffect(() => {
    const timer = setInterval(() => setMinNow(nowLocal()), 5_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    window.api.getSettings().then(setSettings);
    const refresh = () => window.api.getSettings().then(setSettings);
    window.addEventListener('billnest:settings-updated', refresh);
    return () => window.removeEventListener('billnest:settings-updated', refresh);
  }, []);

  // Auto-apply the Cash/Online GST rate configured in Settings for Room
  // Booking whenever it hasn't been manually touched — runs on load (for a
  // brand-new booking) and again any time the payment method select is
  // switched (see its onChange below, which resets `taxPercentTouched`).
  useEffect(() => {
    if (!settings || taxPercentTouched) return;
    const auto = paymentMethod === 'ONLINE'
      ? parseFloat(settings.room_tax_percent_online ?? settings.tax_percent ?? 0)
      : parseFloat(settings.room_tax_percent_cash ?? settings.tax_percent ?? 0);
    setTaxPercent(auto);
  }, [settings, paymentMethod, taxPercentTouched]);

  // Which rooms are already booked (BOOKED/CHECKED_IN) somewhere inside a
  // relevant date window, so the room picker can grey those out instead of
  // letting the front desk pick a room that will just fail with an error at
  // Save time. When editing, the booking's own room/dates don't count
  // against itself. CHECKED_OUT stays don't block re-booking the same room.
  //
  // The fetch window covers the UNION of the shared check-in/out AND every
  // room row's own date override (when "different dates for this room" is
  // used) — the raw calendar rows are kept so availability can then be
  // computed PER ROW using each row's own effective dates, instead of one
  // Set shared by the whole form (which would be wrong once rows can have
  // different stays).
  const [calendarRows, setCalendarRows] = useState([]);
  const unionWindow = React.useMemo(() => {
    const dates = [];
    if (checkInDate && checkOutDate) dates.push(checkInDate, checkOutDate);
    for (const row of roomRows) {
      if (row.useOwnDates && row.checkInDate && row.checkOutDate) dates.push(row.checkInDate, row.checkOutDate);
    }
    if (!dates.length) return null;
    return { from: dates.reduce((a, b) => (b < a ? b : a)), to: dates.reduce((a, b) => (b > a ? b : a)) };
  }, [checkInDate, checkOutDate, roomRows]);
  useEffect(() => {
    if (!unionWindow) {
      setCalendarRows([]);
      return;
    }
    let cancelled = false;
    window.api.getRoomCalendar({ from: unionWindow.from, to: unionWindow.to }).then((rows) => {
      if (!cancelled) setCalendarRows(rows || []);
    });
    return () => { cancelled = true; };
  }, [unionWindow]);

  const editingId = booking ? booking.id : null;
  function isRoomBlockedFor(roomId, fromDate, toDate) {
    if (!fromDate || !toDate || toDate <= fromDate) return false;
    const room = calendarRows.find((r) => r.id === Number(roomId));
    if (!room) return false;
    return (room.bookings || []).some(
      (b) => b.status !== 'CHECKED_OUT' && b.id !== editingId
        && !(dateOnlyLocal(b.checkOutDate) <= dateOnlyLocal(fromDate) || dateOnlyLocal(b.checkInDate) >= dateOnlyLocal(toDate))
    );
  }
  // Edit mode only ever has one room/one shared date range.
  const unavailableRoomIds = React.useMemo(() => {
    if (!isEdit) return new Set();
    const blocked = new Set();
    for (const room of calendarRows) {
      if (isRoomBlockedFor(room.id, checkInDate, checkOutDate)) blocked.add(room.id);
    }
    return blocked;
  }, [isEdit, calendarRows, checkInDate, checkOutDate]);

  function handleRoomChange(id) {
    setRoomId(id);
    const r = rooms.find((x) => x.id === Number(id));
    if (r) setRoomRate(r.base_price);
  }

  // Whenever the check-in date/time changes, shift check-out by the same
  // number of calendar nights that was already selected (minimum 1), keeping
  // the original checkout TIME so e.g. an 11:00 checkout stays 11:00 after
  // the check-in date is nudged. Defaults to 1 night for a fresh booking.
  // Night count is always calendar-day based (date-only diff) so a 1h stay
  // and a 1d-13h stay are both treated as 1 night — no fractional charging.
  function handleCheckInChange(value) {
    const prevCheckIn = checkInDate;
    setCheckInAuto(false);
    setCheckInDate(value);
    if (!value) return;
    const pad = (n) => String(n).padStart(2, '0');
    // Calendar-day diff for prevNights: strip to date-only before comparing
    // so that a check-in at 18:00 and check-out at 11:00 the next day still
    // reads as 1 night, not 0 (which Math.round(17h/24) would give).
    const prevNights = prevCheckIn && checkOutDate
      ? Math.max(1, Math.round(
          (new Date(String(checkOutDate).slice(0, 10)) - new Date(String(prevCheckIn).slice(0, 10))) / 86400000
        ))
      : 1;
    // Shift only the DATE portion of checkout; preserve the existing TIME so
    // standard check-out time (e.g. 11:00 AM) is never silently overwritten.
    const existingCheckoutTime = checkOutDate ? String(checkOutDate).slice(11, 16) : '11:00';
    const newCheckOutDate = new Date(String(value).slice(0, 10));
    newCheckOutDate.setDate(newCheckOutDate.getDate() + prevNights);
    setCheckOutDate(
      `${newCheckOutDate.getFullYear()}-${pad(newCheckOutDate.getMonth() + 1)}-${pad(newCheckOutDate.getDate())}T${existingCheckoutTime}`
    );
  }

  // ---- Guests (contacts) helpers ----
  function addContact() {
    setContacts((list) => [...list, blankContact()]);
  }
  function removeContact(idx) {
    setContacts((list) => list.filter((_, i) => i !== idx));
  }
  function updateContact(idx, field, value) {
    setContacts((list) => list.map((c, i) => (i === idx ? { ...c, [field]: value } : c)));
  }
  function revealContactField(idx, field) {
    setContacts((list) => list.map((c, i) => (i === idx ? { ...c, [field]: true } : c)));
  }

  // ---- Room Details (multi-room) helpers ----
  function addRoomRow() {
    // Pick the first room not already selected in another row, as a
    // convenient default (front desk can still change it).
    const usedIds = new Set(roomRows.map((r) => Number(r.roomId)));
    const nextRoom = rooms.find((r) => !usedIds.has(r.id) && r.status !== 'MAINTENANCE') || rooms.find((r) => !usedIds.has(r.id)) || null;
    setRoomRows((list) => [...list, { roomId: nextRoom ? nextRoom.id : '', roomRate: nextRoom ? nextRoom.base_price : '', numGuests: '', useOwnDates: false, checkInDate: '', checkOutDate: '' }]);
  }
  function removeRoomRow(idx) {
    setRoomRows((list) => list.filter((_, i) => i !== idx));
  }
  function updateRoomRoomId(idx, id) {
    const r = rooms.find((x) => x.id === Number(id));
    setRoomRows((list) => list.map((row, i) => (i === idx ? { ...row, roomId: id, roomRate: r ? r.base_price : row.roomRate } : row)));
  }
  function updateRoomRow(idx, field, value) {
    setRoomRows((list) => list.map((row, i) => (i === idx ? { ...row, [field]: value } : row)));
  }
  // Toggling "different dates for this room" on seeds its date fields with
  // the shared check-in/out so staff only has to adjust what's different,
  // instead of starting from blank inputs. Toggling off just stops using
  // them (kept in state in case staff re-enables it, harmless either way
  // since handleSubmit only sends them when useOwnDates is true).
  function toggleRoomOwnDates(idx, checked) {
    setRoomRows((list) => list.map((row, i) => (i === idx ? {
      ...row,
      useOwnDates: checked,
      checkInDate: checked ? (row.checkInDate || checkInDate) : row.checkInDate,
      checkOutDate: checked ? (row.checkOutDate || checkOutDate) : row.checkOutDate,
    } : row)));
  }
  // Every room row's actual stay dates — its own override if it has one,
  // otherwise the shared dates typed at the top of the Room Details section.
  function effectiveRowDates(row) {
    return {
      checkIn: row.useOwnDates && row.checkInDate ? row.checkInDate : checkInDate,
      checkOut: row.useOwnDates && row.checkOutDate ? row.checkOutDate : checkOutDate,
    };
  }
  function rowNights(row) {
    const { checkIn, checkOut } = effectiveRowDates(row);
    // Calendar-day diff (date-only) — same logic as the backend nights().
    const diff = Math.round((new Date(String(checkOut).slice(0, 10)) - new Date(String(checkIn).slice(0, 10))) / 86400000);
    return Math.max(1, diff || 1);
  }

  function addAddonRow() {
    if (!addonName || !addonPrice) return;
    setAddons((list) => [...list, { name: addonName, price: parseFloat(addonPrice), quantity: parseInt(addonQty, 10) || 1 }]);
    setAddonName('');
    setAddonPrice('');
    setAddonQty(1);
  }

  function removeAddonRow(idx) {
    setAddons((list) => list.filter((_, i) => i !== idx));
  }

  async function handlePickIdDocument() {
    setUploadingId(true);
    try {
      const selected = await window.api.pickIdDocument();
      const paths = Array.isArray(selected) ? selected : (selected ? [selected] : []);
      if (paths.length) setGuestIdDocumentPaths(paths);
    } finally {
      setUploadingId(false);
    }
  }

  // Live preview of the final payable amount, computed the same way the
  // invoice will be at checkout — so GST/GSTIN, rate and advance-payment
  // changes are reflected immediately before the booking is even saved.
  // Calendar-day diff — time-of-day must not affect the night count.
  const nights = Math.max(1, Math.round((new Date(String(checkOutDate).slice(0, 10)) - new Date(String(checkInDate).slice(0, 10))) / 86400000) || 1);
  const roomsTotal = isEdit
    ? (parseFloat(roomRate) || 0) * nights
    : roomRows.reduce((s, r) => s + (parseFloat(r.roomRate) || 0) * rowNights(r), 0);
  const addonsTotal = addons.reduce((s, a) => s + a.price * a.quantity, 0);
  const subtotal = roomsTotal + addonsTotal + (parseFloat(touristTax) || 0);
  const taxAmount = +(subtotal * ((parseFloat(taxPercent) || 0) / 100)).toFixed(2);
  const grossBeforeDiscount = +(subtotal + taxAmount).toFixed(2);
  // Discount is capped at the gross amount — can zero out the bill but not go negative.
  const discountVal = Math.min(parseFloat(discount) || 0, grossBeforeDiscount);
  const finalTotal = Math.max(0, +(grossBeforeDiscount - discountVal).toFixed(2));
  // Advance is capped at the final total — cannot collect more than what is owed.
  const advancePaid = Math.min(parseFloat(advancePayment) || 0, finalTotal);
  const balanceDue = Math.max(0, +(finalTotal - advancePaid).toFixed(2));

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!checkInDate || !checkOutDate) {
      setError('Please fill check-in and check-out dates.');
      return;
    }
    if (isEdit) {
      if (!roomId || !guestName) {
        setError('Please fill room and guest name.');
        return;
      }
    } else {
      if (!roomRows.length || !roomRows[0].roomId) {
        setError('Please select at least one room.');
        return;
      }
      if (!contacts.length || !contacts[0].name || !contacts[0].phone) {
        setError('Please fill the primary guest name and contact number.');
        return;
      }
    }
    setSaving(true);
    try {
      const payload = isEdit
        ? {
            roomId: Number(roomId),
            checkInDate,
            checkOutDate,
            guestName,
            guestPhone,
            guestIdType,
            guestIdNumber,
            guestGstin,
            guestIdDocumentPaths,
            numGuests: parseInt(numGuests, 10) || 1,
            roomRate: parseFloat(roomRate) || 0,
            touristTax: parseFloat(touristTax) || 0,
            discount: parseFloat(discount) || 0,
            taxPercent: parseFloat(taxPercent) || 0,
            paymentMethod,
            notes,
            addons,
            advancePayment: advancePaid,
            advancePaymentMethod: advancePaid > 0 ? advancePaymentMethod : null,
          }
        : {
            checkInDate,
            checkOutDate,
            rooms: roomRows
              .filter((r) => r.roomId)
              .map((r) => ({
                roomId: Number(r.roomId),
                roomRate: parseFloat(r.roomRate) || 0,
                numGuests: parseInt(r.numGuests, 10) || 1,
                ...(r.useOwnDates && r.checkInDate && r.checkOutDate
                  ? { checkInDate: r.checkInDate, checkOutDate: r.checkOutDate }
                  : {}),
              })),
            contacts: contacts
              .filter((c) => c.name && c.phone)
              .map((c) => ({ name: c.name, phone: c.phone, email: c.email || undefined, specialRequest: c.specialRequest || undefined })),
            guestIdType,
            guestIdNumber,
            guestGstin,
            guestIdDocumentPaths,
            touristTax: parseFloat(touristTax) || 0,
            discount: parseFloat(discount) || 0,
            taxPercent: parseFloat(taxPercent) || 0,
            paymentMethod,
            notes,
            addons,
            advancePayment: advancePaid,
            advancePaymentMethod: advancePaid > 0 ? advancePaymentMethod : null,
          };
      if (isEdit) {
        await window.api.updateBooking(booking.id, payload);
      } else {
        const created = await window.api.createBooking(payload);
        const primaryBooking = Array.isArray(created) ? created[0] : created;
        try {
          await handoffRoomWhatsApp('booking', primaryBooking);
        } catch (shareError) {
          window.alert(`Booking saved, but WhatsApp could not be opened: ${shareError?.message || 'Unknown error.'}`);
        }
      }
      onSaved?.();
      onClose?.();
    } catch (err) {
      setError(err.message || 'Could not save booking.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal modal-wide">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h3>{isEdit ? `Edit Booking ${booking.bookingNumber}` : 'New Booking'}</h3>
        <form onSubmit={handleSubmit} className="fm-form">
          {isEdit ? (
            <>
              <div className="booking-contacts-editor">
                <h4>Guest Details</h4>
                <label>
                  Guest Name
                  <input value={guestName} onChange={(e) => setGuestName(e.target.value)} required />
                </label>
                <label>
                  Guest Phone
                  <input value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} />
                </label>
                <label>
                  Number of Guests
                  <input type="number" min="1" value={numGuests} onChange={(e) => setNumGuests(e.target.value)} />
                </label>
                <label>
                  ID Type
                  <select value={guestIdType} onChange={(e) => setGuestIdType(e.target.value)}>
                    {ID_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label>
                  ID Number
                  <input value={guestIdNumber} onChange={(e) => setGuestIdNumber(e.target.value)} />
                </label>
                <label>
                  ID Document (optional — can upload now or later)
                  <div className="id-upload-row">
                    <button type="button" className="btn btn-secondary" onClick={handlePickIdDocument} disabled={uploadingId}>
                      {uploadingId ? 'Choosing…' : guestIdDocumentPaths.length ? `📎 Change Files (${guestIdDocumentPaths.length})` : '📎 Upload ID(s)'}
                    </button>
                    {guestIdDocumentPaths.length > 0 && (
                      <span className="dim">{guestIdDocumentPaths.length} ID attachment{guestIdDocumentPaths.length === 1 ? '' : 's'} selected</span>
                    )}
                    {!guestIdDocumentPaths.length && <span className="dim">Not uploaded yet — you can add these on Edit later.</span>}
                  </div>
                </label>
                <label>
                  Guest / Company GSTIN (optional, for GST invoice)
                  <input value={guestGstin} onChange={(e) => setGuestGstin(e.target.value)} placeholder="e.g. 27AAECS1234A1Z5" />
                </label>
              </div>

              <div className="booking-rooms-editor">
                <h4>Room Details</h4>
                <label>
                  Room
                  <select value={roomId} onChange={(e) => handleRoomChange(e.target.value)} required>
                    <option value="">Select room</option>
                    {rooms.map((r) => {
                      const underMaintenance = r.status === 'MAINTENANCE';
                      const unavailable = unavailableRoomIds.has(r.id);
                      return (
                        <option key={r.id} value={r.id} disabled={unavailable || underMaintenance}>
                          Room {r.room_number} — {r.room_type} (default ₹{r.base_price}/night){underMaintenance ? ' — 🔧 Under Maintenance' : (unavailable ? ' — Unavailable for these dates' : '')}
                        </option>
                      );
                    })}
                  </select>
                  {unavailableRoomIds.has(Number(roomId)) && (
                    <span className="field-hint danger">This room is already booked for the selected dates. Please choose another room or change the dates.</span>
                  )}
                  {rooms.find((r) => r.id === Number(roomId))?.status === 'MAINTENANCE' && (
                    <span className="field-hint danger">This room is currently under maintenance and cannot be booked.</span>
                  )}
                </label>
                <label>
                  Check-in Date &amp; Time
                  <input type="datetime-local" value={checkInDate} min={minNow} onChange={(e) => handleCheckInChange(e.target.value)} required />
                </label>
                <label>
                  Check-out Date &amp; Time
                  <input type="datetime-local" value={checkOutDate} min={checkInDate || minNow} onChange={(e) => { setCheckOutAuto(false); setCheckOutDate(e.target.value); }} required />
                </label>
                <label>
                  Room Rate / Night (₹)
                  <input type="number" min="0" step="1" value={roomRate} onChange={(e) => setRoomRate(e.target.value)} required />
                </label>
              </div>
            </>
          ) : (
            <>
              <div className="booking-contacts-editor">
                <h4>Guest Details</h4>
                {contacts.map((c, idx) => (
                  <div className="contact-row" key={idx}>
                    <div className="contact-row-main">
                      <input
                        placeholder="Guest Name"
                        value={c.name}
                        onChange={(e) => updateContact(idx, 'name', e.target.value)}
                        required={idx === 0}
                      />
                      <input
                        placeholder="Contact Number"
                        value={c.phone}
                        onChange={(e) => updateContact(idx, 'phone', e.target.value)}
                        required={idx === 0}
                      />
                      {idx > 0 ? (
                        <button type="button" className="btn-link danger" onClick={() => removeContact(idx)}>Remove</button>
                      ) : (
                        <span className="btn-link room-row-remove-spacer" aria-hidden="true">Remove</span>
                      )}
                    </div>
                    <div className="contact-row-extra">
                      {c.showEmail ? (
                        <input
                          placeholder="Email"
                          type="email"
                          value={c.email}
                          onChange={(e) => updateContact(idx, 'email', e.target.value)}
                        />
                      ) : (
                        <button type="button" className="btn-link" onClick={() => revealContactField(idx, 'showEmail')}>+ Add Email</button>
                      )}
                      {c.showSpecialRequest ? (
                        <input
                          placeholder="Special Request"
                          value={c.specialRequest}
                          onChange={(e) => updateContact(idx, 'specialRequest', e.target.value)}
                        />
                      ) : (
                        <button type="button" className="btn-link" onClick={() => revealContactField(idx, 'showSpecialRequest')}>+ Add Special Request</button>
                      )}
                    </div>
                  </div>
                ))}
                <button type="button" className="btn btn-secondary" onClick={addContact}>+ Add Guest Contact</button>

                <label>
                  ID Type
                  <select value={guestIdType} onChange={(e) => setGuestIdType(e.target.value)}>
                    {ID_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label>
                  ID Number
                  <input value={guestIdNumber} onChange={(e) => setGuestIdNumber(e.target.value)} />
                </label>
                <label>
                  ID Document (optional — can upload now or later)
                  <div className="id-upload-row">
                    <button type="button" className="btn btn-secondary" onClick={handlePickIdDocument} disabled={uploadingId}>
                      {uploadingId ? 'Choosing…' : guestIdDocumentPaths.length ? `📎 Change Files (${guestIdDocumentPaths.length})` : '📎 Upload ID(s)'}
                    </button>
                    {guestIdDocumentPaths.length > 0 && (
                      <span className="dim">{guestIdDocumentPaths.length} ID attachment{guestIdDocumentPaths.length === 1 ? '' : 's'} selected</span>
                    )}
                    {!guestIdDocumentPaths.length && <span className="dim">Not uploaded yet — you can add these on Edit later.</span>}
                  </div>
                </label>
                <label>
                  Guest / Company GSTIN (optional, for GST invoice)
                  <input value={guestGstin} onChange={(e) => setGuestGstin(e.target.value)} placeholder="e.g. 27AAECS1234A1Z5" />
                </label>
              </div>

              <div className="booking-rooms-editor">
                <h4>Room Details</h4>
                <label>
                  Check-in Date &amp; Time
                  <input type="datetime-local" value={checkInDate} min={minNow} onChange={(e) => handleCheckInChange(e.target.value)} required />
                </label>
                <label>
                  Check-out Date &amp; Time
                  <input type="datetime-local" value={checkOutDate} min={checkInDate || minNow} onChange={(e) => { setCheckOutAuto(false); setCheckOutDate(e.target.value); }} required />
                </label>
                {roomRows.map((r, idx) => (
                  <div className="room-row" key={idx}>
                    <select value={r.roomId} onChange={(e) => updateRoomRoomId(idx, e.target.value)} required={idx === 0}>
                      <option value="">Select room</option>
                      {rooms.map((room) => {
                        const usedElsewhere = roomRows.some((rr, i) => i !== idx && Number(rr.roomId) === room.id);
                        const { checkIn: rowCheckIn, checkOut: rowCheckOut } = effectiveRowDates(r);
                        const bookedForDates = isRoomBlockedFor(room.id, rowCheckIn, rowCheckOut);
                        const underMaintenance = room.status === 'MAINTENANCE';
                        return (
                          <option
                            key={room.id}
                            value={room.id}
                            disabled={usedElsewhere || bookedForDates || underMaintenance}
                          >
                            Room {room.room_number} — {room.room_type} (₹{room.base_price}/night){underMaintenance ? ' — 🔧 Under Maintenance' : (bookedForDates ? ' — Unavailable for these dates' : '')}
                          </option>
                        );
                      })}
                    </select>
                    <input
                      placeholder="Rate/night"
                      type="number"
                      min="0"
                      step="1"
                      value={r.roomRate}
                      onChange={(e) => updateRoomRow(idx, 'roomRate', e.target.value)}
                    />
                    <input
                      placeholder="Guests"
                      type="number"
                      min="1"
                      value={r.numGuests}
                      onChange={(e) => updateRoomRow(idx, 'numGuests', e.target.value)}
                    />
                    <span className="room-row-nights">{rowNights(r)} night{rowNights(r) === 1 ? '' : 's'}</span>
                    {idx > 0 ? (
                      <button type="button" className="btn-link danger" onClick={() => removeRoomRow(idx)}>Remove</button>
                    ) : (
                      <span className="btn-link room-row-remove-spacer" aria-hidden="true">Remove</span>
                    )}
                    {idx > 0 && (
                      <label className="room-row-own-dates-toggle">
                        <input
                          type="checkbox"
                          checked={r.useOwnDates}
                          onChange={(e) => toggleRoomOwnDates(idx, e.target.checked)}
                        />
                        📅 Change Dates
                      </label>
                    )}
                    {r.useOwnDates && (
                      <div className="room-row-own-dates">
                        <label>
                          Check-in
                          <input
                            type="datetime-local"
                            value={r.checkInDate}
                            min={minNow}
                            onChange={(e) => updateRoomRow(idx, 'checkInDate', e.target.value)}
                          />
                        </label>
                        <label>
                          Check-out
                          <input
                            type="datetime-local"
                            value={r.checkOutDate}
                            min={r.checkInDate || minNow}
                            onChange={(e) => updateRoomRow(idx, 'checkOutDate', e.target.value)}
                          />
                        </label>
                        <span className="dim">{rowNights(r)} night{rowNights(r) > 1 ? 's' : ''}</span>
                      </div>
                    )}
                  </div>
                ))}
                <button type="button" className="btn btn-secondary" onClick={addRoomRow}>+ Add Room</button>
              </div>
            </>
          )}

          <label>
            Tourist Tax (₹, total, optional)
            <input type="number" min="0" step="1" value={touristTax} placeholder="e.g. 100" onChange={(e) => setTouristTax(e.target.value)} />
          </label>
          <label>
            Discount (₹)
            <input
              type="number" min="0" step="1"
              max={grossBeforeDiscount > 0 ? grossBeforeDiscount : undefined}
              value={discount}
              placeholder="e.g. 500"
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') { setDiscount(''); return; }
                const v = parseFloat(raw) || 0;
                setDiscount(grossBeforeDiscount > 0 ? Math.min(v, grossBeforeDiscount) : raw);
              }}
            />
            {(parseFloat(discount) || 0) > grossBeforeDiscount && grossBeforeDiscount > 0 && (
              <span className="field-hint danger">Discount cannot exceed the total amount (₹{grossBeforeDiscount.toFixed(2)}). Capped automatically.</span>
            )}
          </label>
          <TaxRateSelect
            label="GST / Tax Rate"
            value={taxPercent}
            onChange={(v) => { setTaxPercent(v); setTaxPercentTouched(true); }}
          />
          <label>
            Payment Method
            <select
              value={paymentMethod}
              onChange={(e) => { setPaymentMethod(e.target.value); setTaxPercentTouched(false); }}
            >
              <option value="CASH">Cash</option>
              <option value="ONLINE">Online / UPI</option>
            </select>
          </label>
          <label>
            Notes
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>

          <div className="booking-advance-editor">
            <h4>Advance Payment</h4>
            <div className="advance-payment-row">
              <label>
                Advance Received (₹)
                <input
                  type="number" min="0" step="1"
                  max={finalTotal > 0 ? finalTotal : undefined}
                  value={advancePayment}
                  placeholder="e.g. 1000"
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === '') { setAdvancePayment(''); return; }
                    const v = parseFloat(raw) || 0;
                    setAdvancePayment(finalTotal > 0 ? Math.min(v, finalTotal) : raw);
                  }}
                />
                {(parseFloat(advancePayment) || 0) > finalTotal && finalTotal > 0 && (
                  <span className="field-hint danger">Advance cannot exceed the total amount (₹{finalTotal.toFixed(2)}). Capped automatically.</span>
                )}
              </label>
              {advancePaid > 0 && (
                <label>
                  Advance Payment Method
                  <select value={advancePaymentMethod} onChange={(e) => setAdvancePaymentMethod(e.target.value)}>
                    <option value="CASH">Cash</option>
                    <option value="ONLINE">Online / UPI</option>
                  </select>
                </label>
              )}
            </div>
          </div>

          <div className="booking-addons-editor">
            <h4>Add-ons (breakfast, activities, etc.)</h4>
            <div className="addon-add-row">
              <input placeholder="Name" value={addonName} onChange={(e) => setAddonName(e.target.value)} />
              <input placeholder="Price" type="number" min="0" value={addonPrice} onChange={(e) => setAddonPrice(e.target.value)} />
              <input placeholder="Qty" type="number" min="1" value={addonQty} onChange={(e) => setAddonQty(e.target.value)} />
              <button type="button" className="btn btn-secondary" onClick={addAddonRow}>+ Add</button>
            </div>
            {addons.length > 0 && (
              <ul className="addon-list">
                {addons.map((a, i) => (
                  <li key={i}>
                    {a.name} × {a.quantity} = ₹{(a.price * a.quantity).toFixed(2)}
                    <button type="button" className="btn-link danger" onClick={() => removeAddonRow(i)}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="booking-total-preview">
            <span>Room{roomsTotal && !isEdit && roomRows.length > 1 ? 's' : ''} ({!isEdit && roomRows.some((r) => r.useOwnDates) ? 'varies per room' : `${nights} night${nights > 1 ? 's' : ''}`}): {formatCurrency(roomsTotal)}</span>
            {addonsTotal > 0 && <span>Add-ons: {formatCurrency(addonsTotal)}</span>}
            {touristTax > 0 && <span>Tourist Tax: {formatCurrency(touristTax)}</span>}
            {taxAmount > 0 ? (
              (() => {
                const { halfPercent, cgstAmount, sgstAmount } = splitGst(taxPercent, taxAmount);
                return (
                  <>
                    <span>CGST ({halfPercent}%): {formatCurrency(cgstAmount)}</span>
                    <span>SGST ({halfPercent}%): {formatCurrency(sgstAmount)}</span>
                  </>
                );
              })()
            ) : (
              <span>GST ({taxPercent || 0}%): {formatCurrency(taxAmount)}</span>
            )}
            {discount > 0 && <span>Discount: -{formatCurrency(discount)}</span>}
            <strong>Final Amount: {formatCurrency(finalTotal)}</strong>
            {advancePaid > 0 && (
              <>
                <span>Advance Received: -{formatCurrency(advancePaid)}</span>
                <strong>Balance Due: {formatCurrency(balanceDue)}</strong>
              </>
            )}
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Booking'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
