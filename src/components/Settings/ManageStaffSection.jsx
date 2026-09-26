import React, { useEffect, useState, useCallback } from 'react';

// Owner-only staff account management: add Staff PIN logins, reset a
// forgotten PIN, or deactivate someone who's left. This section only ever
// renders inside Settings, which is itself gated to the Owner role in
// App.jsx's nav, so no additional role-check is needed here.
export default function ManageStaffSection() {
  const [users, setUsers] = useState([]);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [access, setAccess] = useState('BOTH');
  const [error, setError] = useState('');
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPinValue, setResetPinValue] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [showAccessHelp, setShowAccessHelp] = useState(false);

  const load = useCallback(() => window.api.listUsers().then(setUsers), []);
  useEffect(() => { load(); }, [load]);

  async function handleAddStaff(e) {
    e.preventDefault();
    setError('');
    try {
      await window.api.createStaffAccount({ name, pin, access });
      setName('');
      setPin('');
      setAccess('BOTH');
      load();
    } catch (err) {
      setError(err.message || 'Could not create staff account.');
    }
  }

  async function handleAccessChange(id, newAccess) {
    try {
      await window.api.updateUserAccess(id, newAccess);
      load();
    } catch (err) {
      alert(err.message || 'Could not update access.');
    }
  }

  async function handleDeactivate(id) {
    if (!window.confirm('Remove this staff member\'s access? They will no longer be able to log in.')) return;
    try {
      await window.api.deactivateUser(id);
      load();
    } catch (err) {
      alert(err.message || 'Could not deactivate user.');
    }
  }

  async function handleResetPin(e) {
    e.preventDefault();
    setError('');
    try {
      await window.api.resetUserPin(resetTarget.id, resetPinValue);
      setResetTarget(null);
      setResetPinValue('');
      load();
    } catch (err) {
      setError(err.message || 'Could not reset PIN.');
    }
  }

  return (
    <div className="settings-section manage-staff-section">
      <h3 className="label-with-help">
        👥 Staff Access
        <button
          type="button"
          className="help-question-btn"
          onClick={() => setShowAccessHelp((v) => !v)}
          title="More about staff access"
          aria-label="More about staff access"
        >?</button>
      </h3>
      <p className="settings-sub">
        Staff PINs only unlock Billing, Search &amp; Room Booking — everything else stays Owner-only.
      </p>
      {showAccessHelp && (
        <div className="help-panel">
          Staff PINs unlock only Billing, Search and day-to-day Room Booking (check-in/out, new bookings).
          Reporting, Menu/Room setup, Inventory, and Settings remain Owner-only. Use <strong>Access</strong>{' '}
          to restrict a staff member to Food Billing only, Hotel/Room Billing only, or both — the
          unselected module's menu items are hidden for that user.
        </div>
      )}

      <form onSubmit={handleAddStaff} className="fm-form staff-add-form">
        <label>
          Staff Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ramesh" required />
        </label>
        <label>
          PIN (4-6 digits)
          <input
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            placeholder="e.g. 4321"
            required
          />
        </label>
        <label>
          Access
          <select value={access} onChange={(e) => setAccess(e.target.value)}>
            <option value="BOTH">Both Food &amp; Hotel Billing</option>
            <option value="FOOD">Food Billing only</option>
            <option value="ROOMS">Hotel/Room Billing only</option>
          </select>
        </label>
        <button type="submit" className="btn btn-primary">+ Add Staff</button>
      </form>
      {error && !resetTarget && <div className="form-error">{error}</div>}

      <div className="fm-table-wrapper staff-desktop-table">
        <table className="fm-table">
          <thead>
            <tr><th>Name</th><th>Role</th><th>Access</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.role === 'OWNER' ? '👑 Owner' : '🧑‍💼 Staff'}</td>
                <td>
                  {u.role === 'OWNER' ? (
                    'Both (always)'
                  ) : (
                    <select value={u.access} onChange={(e) => handleAccessChange(u.id, e.target.value)}>
                      <option value="BOTH">Both</option>
                      <option value="FOOD">Food only</option>
                      <option value="ROOMS">Rooms only</option>
                    </select>
                  )}
                </td>
                <td>
                  <span className={`status-badge ${u.active ? 'completed' : 'cancelled'}`}>
                    {u.active ? 'Active' : 'Deactivated'}
                  </span>
                </td>
                <td>
                  <div className="fm-row-actions">
                    {u.role !== 'OWNER' && u.active && (
                      <>
                        <button className="btn-link" onClick={() => { setResetTarget(u); setResetPinValue(''); setError(''); }}>🔑 Reset PIN</button>
                        <button className="btn-link danger" onClick={() => handleDeactivate(u.id)}>🚫 Deactivate</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile-only: collapsible cards (same pattern as Bookings) — Name,
          Role and Status stay visible; tap the arrow to reveal the Access
          selector and actions. */}
      <div className="staff-mobile-cards">
        {users.map((u) => {
          const expanded = expandedId === u.id;
          return (
            <div className={`booking-card${expanded ? ' expanded' : ''}`} key={u.id}>
              <button
                type="button"
                className="booking-card-summary"
                onClick={() => setExpandedId(expanded ? null : u.id)}
              >
                <div className="booking-card-main">
                  <span className="booking-card-guest">{u.name}</span>
                  <span className="booking-card-room">{u.role === 'OWNER' ? '👑 Owner' : '🧑‍💼 Staff'}</span>
                </div>
                <div className="booking-card-right">
                  <span className={`status-badge ${u.active ? 'completed' : 'cancelled'}`}>
                    {u.active ? 'Active' : 'Deactivated'}
                  </span>
                  <span className="booking-card-arrow">›</span>
                </div>
              </button>
              {expanded && (
                <div className="booking-card-details">
                  <div className="booking-card-row">
                    <span>Access</span>
                    <span>
                      {u.role === 'OWNER' ? (
                        'Both (always)'
                      ) : (
                        <select value={u.access} onChange={(e) => handleAccessChange(u.id, e.target.value)}>
                          <option value="BOTH">Both</option>
                          <option value="FOOD">Food only</option>
                          <option value="ROOMS">Rooms only</option>
                        </select>
                      )}
                    </span>
                  </div>
                  {u.role !== 'OWNER' && u.active && (
                    <div className="fm-row-actions">
                      <button className="btn-link" onClick={() => { setResetTarget(u); setResetPinValue(''); setError(''); }}>🔑 Reset PIN</button>
                      <button className="btn-link danger" onClick={() => handleDeactivate(u.id)}>🚫 Deactivate</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {users.length === 0 && <p className="empty-state small">No staff accounts yet.</p>}
      </div>

      {resetTarget && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setResetTarget(null)}>
          <div className="modal">
            <h4>Reset PIN for {resetTarget.name}</h4>
            <form onSubmit={handleResetPin} className="fm-form">
              <label>
                New PIN (4-6 digits)
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={resetPinValue}
                  onChange={(e) => setResetPinValue(e.target.value.replace(/\D/g, ''))}
                  required
                />
              </label>
              {error && <div className="form-error">{error}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setResetTarget(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Save New PIN</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
