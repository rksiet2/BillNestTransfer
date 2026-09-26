import React, { useState } from 'react';

// A booking saved before time-tracking was added (or displayed as a plain
// date) may only have "YYYY-MM-DD" — pad it with a sensible default time so
// the datetime-local input still renders correctly instead of showing blank.
function toDateTimeLocal(value, fallbackTime) {
  if (!value) return '';
  return value.length === 10 ? `${value}T${fallbackTime}` : value.slice(0, 16);
}
function nowLocal() {
  const d = new Date();
  d.setSeconds(0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Lets front desk add ONE more room to an already-created multi-room
// reservation (e.g. the guest decides midway they need an extra room for
// more family members) without having to re-enter the guest's name, ID
// details or stay dates — those are copied server-side from the existing
// group. Only asks for what's actually new: which room, at what rate, for
// how many guests, and — optionally — its own check-in/out if this extra
// room is needed for a different date range than the rest of the group
// (e.g. the new room is only needed starting a day later).
export default function AddRoomToBookingModal({ group, rooms, onClose, onSaved }) {
  const alreadyUsedIds = new Set(group.rooms.map((r) => r.roomId));
  const availableRooms = rooms.filter((r) => r.status === 'ACTIVE' && !alreadyUsedIds.has(r.id));
  const [roomId, setRoomId] = useState(availableRooms[0]?.id || '');
  const [roomRate, setRoomRate] = useState(availableRooms[0]?.base_price || '');
  const [numGuests, setNumGuests] = useState(1);
  const [useOwnDates, setUseOwnDates] = useState(false);
  const [checkInDate, setCheckInDate] = useState(toDateTimeLocal(group.primary.checkInDate, '11:00'));
  const [checkOutDate, setCheckOutDate] = useState(toDateTimeLocal(group.primary.checkOutDate, '11:00'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function handleRoomChange(id) {
    setRoomId(id);
    const r = rooms.find((x) => x.id === Number(id));
    if (r) setRoomRate(r.base_price);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!roomId) {
      setError('Please select a room.');
      return;
    }
    if (useOwnDates && (!checkInDate || !checkOutDate || checkOutDate <= checkInDate)) {
      setError('Please provide a valid check-in/check-out for this room, or uncheck "different dates".');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await window.api.addRoomToBookingGroup(group.key, {
        roomId: Number(roomId),
        roomRate: Number(roomRate) || 0,
        numGuests: Number(numGuests) || 1,
        ...(useOwnDates ? { checkInDate, checkOutDate } : {}),
      });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h4>Add Room — {group.primary.guestName}</h4>
        <p className="settings-hint">
          Same guest, same stay ({group.primary.checkInDate ? group.primary.checkInDate.slice(0, 10) : ''} → {group.primary.checkOutDate ? group.primary.checkOutDate.slice(0, 10) : ''}) — just pick the extra room.
        </p>
        <form onSubmit={handleSubmit} className="fm-form">
          {availableRooms.length === 0 ? (
            <p className="form-error">No other active rooms are available for these dates.</p>
          ) : (
            <>
              <label>
                Room
                <select value={roomId} onChange={(e) => handleRoomChange(e.target.value)}>
                  {availableRooms.map((r) => (
                    <option key={r.id} value={r.id}>{r.room_number} ({r.room_type})</option>
                  ))}
                </select>
              </label>
              <div className="fm-form-row">
                <label>
                  Rate per night (₹)
                  <input type="number" min="0" value={roomRate} onChange={(e) => setRoomRate(e.target.value)} required />
                </label>
                <label>
                  Guests
                  <input type="number" min="1" value={numGuests} onChange={(e) => setNumGuests(e.target.value)} required />
                </label>
              </div>
              <label className="room-row-own-dates-toggle">
                <input type="checkbox" checked={useOwnDates} onChange={(e) => setUseOwnDates(e.target.checked)} />
                📅 Change Dates
              </label>
              {useOwnDates && (
                <div className="room-row-own-dates">
                  <label>
                    Check-in
                    <input type="datetime-local" value={checkInDate} min={nowLocal()} onChange={(e) => setCheckInDate(e.target.value)} />
                  </label>
                  <label>
                    Check-out
                    <input type="datetime-local" value={checkOutDate} min={checkInDate || nowLocal()} onChange={(e) => setCheckOutDate(e.target.value)} />
                  </label>
                </div>
              )}
            </>
          )}
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving || availableRooms.length === 0}>
              {saving ? 'Adding…' : 'Add Room'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
