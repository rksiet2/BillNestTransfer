import React, { useEffect, useState, useCallback } from 'react';

// Topbar bell for incoming Zomato/Swiggy/MMT orders (polling-based — see
// electron/integrations/pollingService.cjs). Safe to render even when no
// integration is enabled/connected: the list will just stay empty and
// window.api.onIncomingOrder simply never fires.
export default function IncomingOrdersBell() {
  const [orders, setOrders] = useState([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    window.api.listIncomingOrders?.().then(setOrders).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    if (!window.api.onIncomingOrder) return undefined;
    const unsubscribe = window.api.onIncomingOrder(() => refresh());
    return unsubscribe;
  }, [refresh]);

  async function handleAccept(externalId) {
    setBusyId(externalId);
    setError('');
    try {
      await window.api.acceptIncomingOrder(externalId);
      refresh();
      window.dispatchEvent(new CustomEvent('billnest:bill-created'));
    } catch (err) {
      setError(err?.message || 'Could not accept this order.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(externalId) {
    setBusyId(externalId);
    setError('');
    try {
      await window.api.rejectIncomingOrder(externalId, 'Rejected by restaurant');
      refresh();
    } catch (err) {
      setError(err?.message || 'Could not reject this order.');
    } finally {
      setBusyId(null);
    }
  }

  if (!window.api.listIncomingOrders) return null; // mobile build — feature not available there

  return (
    <div className="incoming-orders-bell">
      <button className="icon-btn" onClick={() => setOpen((v) => !v)} title="Incoming Orders">
        🔔{orders.length > 0 && <span className="bell-badge">{orders.length}</span>}
      </button>
      {open && (
        <div className="incoming-orders-dropdown">
          <div className="incoming-orders-header">
            <strong>Incoming Orders</strong>
            <button className="modal-close-inline" onClick={() => setOpen(false)}>✕</button>
          </div>
          {error && <div className="toast-error">{error}</div>}
          {orders.length === 0 && (
            <p className="empty-state small">No incoming orders. Enable a platform in Settings → Integrations to start receiving them.</p>
          )}
          {orders.map((o) => (
            <div className="incoming-order-card" key={o.externalId}>
              <div className="incoming-order-card-header">
                <span className={`status-badge status-${o.platform.toLowerCase()}`}>{o.platform}</span>
                {o.kind === 'ROOM_BOOKING' ? (
                  <span>{o.guestName} — {o.checkInDate} → {o.checkOutDate}</span>
                ) : (
                  <span>{(o.items || []).length} item(s) — ₹{o.total}</span>
                )}
              </div>
              {o.kind === 'FOOD_ORDER' && (
                <ul className="incoming-order-items">
                  {(o.items || []).map((it, i) => <li key={i}>{it.quantity}× {it.name}</li>)}
                </ul>
              )}
              <div className="incoming-order-actions">
                <button className="btn btn-primary btn-small" disabled={busyId === o.externalId} onClick={() => handleAccept(o.externalId)}>
                  {busyId === o.externalId ? '…' : '✅ Accept'}
                </button>
                <button className="btn btn-secondary btn-small" disabled={busyId === o.externalId} onClick={() => handleReject(o.externalId)}>
                  ❌ Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
