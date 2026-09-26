import React, { useEffect, useState, useCallback } from 'react';
import { formatCurrency } from '../../utils/format';

const emptyForm = { id: null, room_number: '', room_type: 'Standard', base_price: '', max_occupancy: 2, notes: '' };

export default function RoomsTab() {
  const [rooms, setRooms] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(() => window.api.listRooms().then(setRooms), []);
  useEffect(() => { load(); }, [load]);

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.room_number) return;
    await window.api.saveRoom({
      id: form.id,
      room_number: form.room_number,
      room_type: form.room_type,
      base_price: parseFloat(form.base_price) || 0,
      max_occupancy: parseInt(form.max_occupancy, 10) || 2,
      notes: form.notes,
    });
    setForm(emptyForm);
    load();
  }

  function handleEdit(r) {
    setForm({
      id: r.id,
      room_number: r.room_number,
      room_type: r.room_type,
      base_price: r.base_price,
      max_occupancy: r.max_occupancy,
      notes: r.notes || '',
    });
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this room?')) return;
    try {
      await window.api.deleteRoom(id);
      load();
    } catch (err) {
      alert(err.message || 'Could not delete room.');
    }
  }

  async function toggleMaintenance(r) {
    await window.api.toggleRoomMaintenance(r.id, r.status === 'ACTIVE');
    load();
  }

  return (
    <div className="food-management">
      <div className="fm-form-card">
        <h3>{form.id ? 'Edit Room' : 'Add Room'}</h3>
        <form onSubmit={handleSubmit} className="fm-form">
          <label>
            Room Number
            <input value={form.room_number} onChange={(e) => update('room_number', e.target.value)} placeholder="e.g. 101" required />
          </label>
          <label>
            Room Type
            <input value={form.room_type} onChange={(e) => update('room_type', e.target.value)} placeholder="e.g. Standard, Deluxe, Suite" required />
          </label>
          <label>
            Default Rate / Night (₹, optional)
            <input type="number" min="0" step="1" value={form.base_price} onChange={(e) => update('base_price', e.target.value)} placeholder="e.g. 1800" />
          </label>
          <p className="settings-sub" style={{ gridColumn: '1 / -1', marginTop: '-8px' }}>
            Just a suggested starting price — the actual rate can always be set or changed per booking.
          </p>
          <label>
            Max Occupancy
            <input type="number" min="1" step="1" value={form.max_occupancy} onChange={(e) => update('max_occupancy', e.target.value)} required />
          </label>
          <label>
            Notes (optional)
            <input value={form.notes} onChange={(e) => update('notes', e.target.value)} placeholder="e.g. Sea-facing, top floor" />
          </label>
          <div className="fm-form-actions">
            {form.id && (
              <button type="button" className="btn btn-secondary" onClick={() => setForm(emptyForm)}>Cancel Edit</button>
            )}
            <button type="submit" className="btn btn-primary">{form.id ? 'Update' : '+ Add Room'}</button>
          </div>
        </form>
      </div>

      <div className="fm-list-card">
        <div className="fm-list-header">
          <h3>Rooms ({rooms.length})</h3>
        </div>
        <div className="fm-table-wrapper rooms-desktop-table">
          <table className="fm-table">
            <thead>
              <tr><th>Room</th><th>Type</th><th>Default Rate</th><th>Max Occ.</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {rooms.map((r) => (
                <tr key={r.id}>
                  <td>{r.room_number}</td>
                  <td>{r.room_type}</td>
                  <td>{formatCurrency(r.base_price)}</td>
                  <td>{r.max_occupancy}</td>
                  <td>
                    <span className={`status-badge ${r.status === 'ACTIVE' ? 'completed' : 'cancelled'}`}>
                      {r.status === 'ACTIVE' ? 'Active' : 'Maintenance'}
                    </span>
                  </td>
                  <td>
                    <div className="fm-row-actions">
                      <button className="btn-link" onClick={() => handleEdit(r)}>✏️ Edit</button>
                      <button
                        className={`btn-link ${r.status === 'ACTIVE' ? 'warning' : 'success'}`}
                        onClick={() => toggleMaintenance(r)}
                      >
                        {r.status === 'ACTIVE' ? '🛠️ Set Maintenance' : '✅ Set Active'}
                      </button>
                      <button className="btn-link danger" onClick={() => handleDelete(r.id)}>🗑️ Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
              {rooms.length === 0 && (
                <tr><td colSpan={6} className="empty-state small">No rooms added yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile-only: collapsible cards (same pattern as Bookings) — Room
            number, type and status stay visible; tap the arrow to reveal
            rate, occupancy and actions. */}
        <div className="rooms-mobile-cards">
          {rooms.map((r) => {
            const expanded = expandedId === r.id;
            return (
              <div className={`booking-card${expanded ? ' expanded' : ''}`} key={r.id}>
                <button
                  type="button"
                  className="booking-card-summary"
                  onClick={() => setExpandedId(expanded ? null : r.id)}
                >
                  <div className="booking-card-main">
                    <span className="booking-card-guest">🛏️ Room {r.room_number}</span>
                    <span className="booking-card-room">{r.room_type}</span>
                  </div>
                  <div className="booking-card-right">
                    <span className={`status-badge ${r.status === 'ACTIVE' ? 'completed' : 'cancelled'}`}>
                      {r.status === 'ACTIVE' ? 'Active' : 'Maintenance'}
                    </span>
                    <span className="booking-card-arrow">›</span>
                  </div>
                </button>
                {expanded && (
                  <div className="booking-card-details">
                    <div className="booking-card-row"><span>Default Rate</span><span>{formatCurrency(r.base_price)}</span></div>
                    <div className="booking-card-row"><span>Max Occupancy</span><span>{r.max_occupancy}</span></div>
                    <div className="fm-row-actions">
                      <button className="btn-link" onClick={() => handleEdit(r)}>✏️ Edit</button>
                      <button
                        className={`btn-link ${r.status === 'ACTIVE' ? 'warning' : 'success'}`}
                        onClick={() => toggleMaintenance(r)}
                      >
                        {r.status === 'ACTIVE' ? '🛠️ Set Maintenance' : '✅ Set Active'}
                      </button>
                      <button className="btn-link danger" onClick={() => handleDelete(r.id)}>🗑️ Delete</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {rooms.length === 0 && <p className="empty-state small">No rooms added yet.</p>}
        </div>
      </div>
    </div>
  );
}
