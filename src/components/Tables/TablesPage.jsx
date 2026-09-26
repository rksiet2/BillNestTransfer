import React, { useEffect, useState, useCallback } from 'react';
import { useCart } from '../../context/CartContext';

const STATUS_META = {
  // `label` is the full explanation used once in the legend up top;
  // `cardLabel` is the short word used elsewhere (e.g. alerts/confirms).
  // The legend now pairs each label with an actual colored swatch (not an
  // emoji) that matches the real card circle color, so it reads as a
  // literal color key: "this color on a card = this status".
  EMPTY: { label: 'Empty', cardLabel: 'Empty', color: 'empty' },
  OCCUPIED: { label: 'Occupied', cardLabel: 'Occupied', color: 'occupied' },
  BILLED: { label: 'Billed (needs clearing)', cardLabel: 'Billed', color: 'billed' },
};

// Floor-view for the Table/Area Management feature. Tap an EMPTY/OCCUPIED
// table to open (or resume) its order in the Billing screen; tap a BILLED
// table to clear it back to EMPTY once it's physically been cleaned/reset.
// Owners additionally get "+ Add Table" plus per-card Edit/Delete controls
// right here — this used to live in a separate Settings section, but that
// forced Owners to bounce between two screens just to set up their floor.
export default function TablesPage({ onOpenTable, isOwner, currentUser }) {
  const [tables, setTables] = useState([]);
  const [loading, setLoading] = useState(true);
  const { activeTable, selectTable, clearTableDraft } = useCart();

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [capacity, setCapacity] = useState(4);
  const [formError, setFormError] = useState('');

  // 'active' | 'inactive' | null(both) — a table counts as Active the
  // moment it has a live order on it (OCCUPIED/BILLED); EMPTY is Inactive.
  const [statusFilter, setStatusFilter] = useState(null);

  // Which table's waiter picker is currently open, and the list of staff
  // names it offers to assign — loaded once since Staff accounts rarely
  // change mid-shift; `isOwner` already gates who can even add staff.
  const [assigningWaiterId, setAssigningWaiterId] = useState(null);
  const [staffNames, setStaffNames] = useState([]);

  const load = useCallback(async () => {
    const data = await window.api.listTables();
    setTables(data);
    setLoading(false);
    // If ANOTHER device billed or cleared the table THIS device currently
    // has open (activeTable), this device's local cart is now stale — the
    // order was already settled elsewhere. Without this, the card here
    // keeps showing a "Currently viewing" badge over a table that's really
    // EMPTY/BILLED now, AND re-tapping it later would resurrect whatever
    // unsynced local items were left in this device's cart instead of
    // starting genuinely fresh (CartContext's own server-reconcile only
    // runs when a table is (re)selected, not while just sitting on this
    // screen). Release the stale local session the moment polling reveals
    // this mismatch.
    if (activeTable) {
      const serverTable = data.find((t) => t.id === activeTable.id);
      if (!serverTable || serverTable.status === 'EMPTY' || serverTable.status === 'BILLED') {
        clearTableDraft(activeTable.id);
        selectTable(null, { discardOutgoing: true });
      }
    }
  }, [activeTable, clearTableDraft, selectTable]);

  useEffect(() => {
    window.api.listUsers?.().then((users) => {
      setStaffNames((users || []).filter((u) => u.active).map((u) => u.name));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // Live refresh so a table another counter/captain/waiter touches on a
    // different device (e.g. auto-waiter-claim, status change) shows up
    // here quickly. 2.5s keeps it feeling near-instant without hammering
    // the DB/LAN — this page is the only place that polls at this rate,
    // and polling stops the moment the component unmounts (tab switch).
    const t = setInterval(load, 2500);
    // Also refresh immediately when CartContext auto-releases an empty
    // table (e.g. switching to Counter mode right after tapping a table by
    // accident) — otherwise it'd stay showing "Occupied" here until the
    // next poll tick.
    window.addEventListener('billnest:tables-updated', load);
    return () => {
      clearInterval(t);
      window.removeEventListener('billnest:tables-updated', load);
    };
  }, [load]);

  function resetForm() {
    setEditingId(null);
    setName('');
    setArea('');
    setCapacity(4);
    setFormError('');
    setShowForm(false);
  }

  async function handleSaveTable(e) {
    e.preventDefault();
    setFormError('');
    if (!name.trim()) { setFormError('Table name/number is required.'); return; }
    try {
      await window.api.saveTable({
        id: editingId || undefined,
        name: name.trim(),
        area: area.trim() || null,
        capacity: parseInt(capacity, 10) || 4,
      });
      resetForm();
      load();
    } catch (err) {
      setFormError(err.message || 'Could not save table.');
    }
  }

  function startEdit(e, t) {
    e.stopPropagation();
    setEditingId(t.id);
    setName(t.name);
    setArea(t.area || '');
    setCapacity(t.capacity || 4);
    setFormError('');
    setShowForm(true);
  }

  async function handleDeleteTable(e, t) {
    e.stopPropagation();
    if (!window.confirm(`Delete table "${t.name}"? This cannot be undone.`)) return;
    try {
      await window.api.deleteTable(t.id);
      if (editingId === t.id) resetForm();
      load();
    } catch (err) {
      alert(err.message || 'Could not delete table.');
    }
  }

  function toggleWaiterPicker(e, t) {
    e.stopPropagation();
    setAssigningWaiterId((cur) => (cur === t.id ? null : t.id));
  }

  async function handleAssignWaiter(e, t, waiterName) {
    e.stopPropagation();
    await window.api.assignTableWaiter(t.id, waiterName || null);
    setAssigningWaiterId(null);
    load();
  }

  async function handleTableClick(table) {
    if (table.status === 'BILLED') {
      if (!window.confirm(`Clear Table "${table.name}"? Do this once the table has been reset for the next guest.`)) return;
      await window.api.updateTableStatus(table.id, 'EMPTY');
      // Belt-and-braces: also explicitly wipe any saved order for this
      // table, regardless of which device is doing the clearing. Cart.jsx
      // already clears it right after billing, but that call is
      // fire-and-forget from a possibly different device — if it never
      // landed (closed app, dropped connection), the next guest seated at
      // this table would otherwise see the PREVIOUS guest's already-billed
      // items resurrected the moment this table goes OCCUPIED again.
      if (window.api?.clearTableOrder) {
        window.api.clearTableOrder(table.id).catch(() => {});
      }
      // If this same device still has this table open as its active cart
      // (e.g. Cart's own "Clear" tap raced with this one, or a stale tab),
      // drop that local draft too so it can't be re-saved over top of the
      // fresh EMPTY state a moment later by the autosave effect.
      if (activeTable?.id === table.id) {
        clearTableDraft(table.id);
        selectTable(null, { discardOutgoing: true });
      }
      load();
      return;
    }
    if (table.status === 'EMPTY') {
      await window.api.updateTableStatus(table.id, 'OCCUPIED');
      table = { ...table, status: 'OCCUPIED' };
    }
    // Auto-claim: when a Captain/Waiter (any logged-in non-Owner staff) picks
    // up a table that nobody is serving yet, assign it to them automatically
    // instead of forcing them to also tap the waiter-assign icon — Owners
    // still assign manually since they aren't "serving" a floor themselves.
    // Wrapped defensively: a connected LAN/mobile client that's missing this
    // one API method (e.g. an older cached build) must never block opening
    // the table's order — that already caused a real "tap does nothing"
    // bug on Client devices before `assignTableWaiter` was added everywhere.
    if (currentUser && currentUser.role !== 'OWNER' && !table.waiter_name && currentUser.name) {
      try {
        await window.api.assignTableWaiter(table.id, currentUser.name);
        table = { ...table, waiter_name: currentUser.name };
        load();
      } catch (err) {
        console.error('Auto waiter-claim failed (continuing to open the table anyway):', err);
      }
    }
    selectTable(table);
    onOpenTable?.(table);
  }

  const activeCount = tables.filter((t) => t.status !== 'EMPTY').length;
  const inactiveCount = tables.filter((t) => t.status === 'EMPTY').length;
  const visibleTables = statusFilter === 'active'
    ? tables.filter((t) => t.status !== 'EMPTY')
    : statusFilter === 'inactive'
      ? tables.filter((t) => t.status === 'EMPTY')
      : tables;

  const byArea = visibleTables.reduce((acc, t) => {
    const area = t.area || 'General';
    (acc[area] = acc[area] || []).push(t);
    return acc;
  }, {});

  if (loading) return <div className="empty-state">Loading tables…</div>;
  if (tables.length === 0) {
    return (
      <div className="tables-page">
        {isOwner ? (
          <>
            <p className="settings-sub">No tables set up yet. Add your first dine-in table below.</p>
            <div className="table-add-form-anchor">{renderForm()}</div>
          </>
        ) : (
          <div className="empty-state">No tables set up yet. Ask the Owner to add dine-in tables here.</div>
        )}
      </div>
    );
  }

  function renderForm() {
    return (
      <>
        {!showForm && isOwner && (
          <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>
            + Add Table
          </button>
        )}
        {showForm && (
          <form className="fm-form table-add-form-row" onSubmit={handleSaveTable}>
            <label>
              Table Name/Number
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. T1, A5" autoFocus />
            </label>
            <label>
              Area (optional)
              <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Main Hall, Terrace" />
            </label>
            <label className="table-add-form-capacity">
              Capacity
              <input type="number" min="1" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
            </label>
            <div className="fm-row-actions">
              <button type="submit" className="btn btn-primary">{editingId ? 'Update Table' : '+ Add Table'}</button>
              <button type="button" className="btn btn-secondary" onClick={resetForm}>Cancel</button>
            </div>
            {formError && <div className="form-error">{formError}</div>}
          </form>
        )}
      </>
    );
  }

  return (
    <div className="tables-page">
      <p className="settings-sub">Tap an empty/occupied table to take its order. Tap a billed table to clear it.</p>
      {isOwner && <div className="table-add-form-anchor">{renderForm()}</div>}
      <div className="tables-legend">
        {Object.values(STATUS_META).map((m) => (
          <span key={m.label} className="table-legend-item">
            <span className={`table-legend-swatch is-${m.color}`} />
            {m.label}
          </span>
        ))}
      </div>
      <div className="tables-status-tabs">
        <button
          type="button"
          className={`tables-status-tab is-active-tab ${statusFilter === 'active' ? 'is-selected' : ''}`}
          onClick={() => setStatusFilter((f) => (f === 'active' ? null : 'active'))}
        >
          Active: {activeCount}
        </button>
        <button
          type="button"
          className={`tables-status-tab is-inactive-tab ${statusFilter === 'inactive' ? 'is-selected' : ''}`}
          onClick={() => setStatusFilter((f) => (f === 'inactive' ? null : 'inactive'))}
        >
          Inactive: {inactiveCount}
        </button>
      </div>
      {Object.entries(byArea).map(([area, areaTables]) => (
        <div key={area} className="tables-area-group">
          <h3>{area}</h3>
          <div className="tables-grid">
            {areaTables.map((t) => {
              const meta = STATUS_META[t.status] || STATUS_META.EMPTY;
              const isBooked = t.status !== 'EMPTY';
              const isActive = activeTable?.id === t.id;
              const isAssigning = assigningWaiterId === t.id;
              return (
                <div
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  className={`table-card-v2 status-${meta.color} ${isBooked ? 'is-booked' : 'is-blank'} ${isActive ? 'table-active' : ''}`}
                  onClick={() => handleTableClick(t)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleTableClick(t); } }}
                >
                  <span className="table-card-v2-occupancy" title="Seating capacity">👥 {t.capacity}</span>
                  {isOwner && (
                    <span className="table-card-v2-owner-actions">
                      <span className="table-card-icon-btn" role="button" tabIndex={0} onClick={(e) => startEdit(e, t)} title="Edit table">✏️</span>
                      <span className="table-card-icon-btn" role="button" tabIndex={0} onClick={(e) => handleDeleteTable(e, t)} title="Delete table">🗑️</span>
                    </span>
                  )}
                  <span className={`table-card-v2-circle is-${meta.color}`}>
                    {t.name}
                  </span>
                  <span className="table-card-v2-waiter">
                    <span className="table-card-v2-waiter-label">Waiter</span>
                    <span className="table-card-v2-waiter-value">
                      {isAssigning ? (
                        <select
                          className="table-card-v2-waiter-select"
                          autoFocus
                          defaultValue={t.waiter_name || ''}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => handleAssignWaiter(e, t, e.target.value)}
                          onBlur={(e) => e.stopPropagation()}
                        >
                          <option value="">Not Assigned</option>
                          {staffNames.map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="table-card-v2-waiter-name">{t.waiter_name || 'Not Assigned'}</span>
                      )}
                      <span
                        className="table-card-icon-btn"
                        role="button"
                        tabIndex={0}
                        onClick={(e) => toggleWaiterPicker(e, t)}
                        title={t.waiter_name ? 'Change waiter' : 'Assign waiter'}
                      >
                        {t.waiter_name ? '✏️' : '➕'}
                      </span>
                    </span>
                  </span>
                  {isActive && <span className="table-card-v2-active-badge">✏️ Currently viewing</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
