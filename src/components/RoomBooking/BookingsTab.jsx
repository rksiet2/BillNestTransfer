import React, { useEffect, useState, useCallback } from 'react';
import { formatCurrency, formatDate } from '../../utils/format';
import { periodToRange, todayStr } from '../../utils/dateRange';
import { allocateGroupAdvance } from '../../utils/roomBookingMath';
import BookingFormModal from './BookingFormModal';
import AddRoomToBookingModal from './AddRoomToBookingModal';
import InfoTip from '../common/InfoTip';
import { handoffRoomWhatsApp } from '../../utils/roomWhatsApp';

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'BOOKED', label: 'Booked' },
  { key: 'CHECKED_IN', label: 'Checked In' },
  { key: 'CHECKED_OUT', label: 'Checked Out' },
  { key: 'CANCELLED', label: 'Cancelled' },
];

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Weekly' },
  { key: 'month', label: 'Monthly' },
  { key: 'year', label: 'Annually' },
  { key: 'all', label: 'All Time' },
  { key: 'custom', label: '📅 Custom Range' },
];

const STATUS_BADGE_CLASS = {
  BOOKED: 'booked',
  CHECKED_IN: 'checkedin',
  CHECKED_OUT: 'completed',
  CANCELLED: 'cancelled',
  MIXED: 'booked',
};

const BOOKINGS_PAGE_SIZE = 25;

export default function BookingsTab({ canCancel = true, newBookingRequest = 0 }) {
  const [status, setStatus] = useState('');
  const [period, setPeriod] = useState('all');
  const [customFrom, setCustomFrom] = useState(todayStr());
  const [customTo, setCustomTo] = useState(todayStr());
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [bookings, setBookings] = useState([]);
  const [page, setPage] = useState(0);
  const [rooms, setRooms] = useState([]);
  const [showNewBooking, setShowNewBooking] = useState(false);
  const [editingBooking, setEditingBooking] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [addRoomTarget, setAddRoomTarget] = useState(null);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelRefund, setCancelRefund] = useState('0');
  const [cancelRefundMethod, setCancelRefundMethod] = useState('CASH');
  const [cancelError, setCancelError] = useState('');
  const [groupCancelTarget, setGroupCancelTarget] = useState(null); // whole-group cancel
  const [groupCancelReason, setGroupCancelReason] = useState('');
  const [groupCancelRefund, setGroupCancelRefund] = useState('0');
  const [groupCancelRefundMethod, setGroupCancelRefundMethod] = useState('CASH');
  const [groupCancelError, setGroupCancelError] = useState('');
  const [checkoutTarget, setCheckoutTarget] = useState(null);
  const [checkoutPaymentMethod, setCheckoutPaymentMethod] = useState('CASH');
  const [checkoutError, setCheckoutError] = useState('');

  useEffect(() => {
    if (newBookingRequest > 0) setShowNewBooking(true);
  }, [newBookingRequest]);

  const isCustom = period === 'custom';

  const load = useCallback(() => {
    if (isCustom && (!customFrom || !customTo || customFrom > customTo)) return;
    // Bookings store check-in/check-out as datetime-local values
    // ("YYYY-MM-DDTHH:mm"), so widen the plain from/to dates to cover the
    // full day — otherwise a booking checking in later on the "to" day (or
    // out earlier on the "from" day) would be excluded by a lexicographic
    // string comparison against a bare date.
    const range = isCustom ? { from: customFrom, to: customTo } : periodToRange(period);
    const params = {
      ...(status ? { status } : {}),
      ...(range.from ? { from: `${range.from}T00:00` } : {}),
      ...(range.to ? { to: `${range.to}T23:59` } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
    };
    window.api.listBookings(params).then(setBookings);
  }, [status, period, customFrom, customTo, isCustom, search]);

  // Debounce the free-text search box (300ms) so every keystroke doesn't
  // trigger its own DB query — matches the search-as-you-type UX used
  // elsewhere in the app (e.g. the food menu search).
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset back to page 1 whenever the filters actually change (not on the
  // periodic reload below), so the user isn't bumped off the page they're
  // browsing every refresh. Also collapse any expanded mobile card so it
  // doesn't stay open pointing at a stale/reordered row.
  useEffect(() => {
    setPage(0);
    setExpandedId(null);
  }, [status, period, customFrom, customTo, search]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { window.api.listRooms().then(setRooms); }, []);

  const totalPages = Math.max(1, Math.ceil(bookings.length / BOOKINGS_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageBookings = bookings.slice(safePage * BOOKINGS_PAGE_SIZE, safePage * BOOKINGS_PAGE_SIZE + BOOKINGS_PAGE_SIZE);

  // Shared total/balance-due math, reused by both the table row and the
  // checkout confirmation modal so the two never drift apart. Looks up any
  // sibling rooms sharing this booking's group (from the currently loaded
  // list) so a large upfront advance is correctly split/capped across the
  // group instead of being subtracted in full from every single room.
  function bookingTotals(b) {
    const siblings = b.bookingGroupId
      ? bookings.filter((x) => x.bookingGroupId === b.bookingGroupId)
      : [b];
    const allocated = allocateGroupAdvance(siblings);
    const mine = allocated.find((t) => t.room.id === b.id) || allocated[0];
    return { nights: mine.nights, total: mine.total, advance: mine.advance, balanceDue: mine.balanceDue };
  }

  // Shown next to Adv/Due for a cancelled booking that had an advance —
  // makes the cancellation's money outcome visible in the Bookings list
  // (which doubles as the closest thing to a "cancellations report") instead
  // of the refund decision only living inside the cancel modal at the time.
  function refundLine(b) {
    if (b.status !== 'CANCELLED' || b.refundAmount == null) return null;
    return b.refundAmount > 0
      ? <strong>Refunded: {formatCurrency(b.refundAmount)}</strong>
      : <span className="dim">Not refunded</span>;
  }

  // A single guest booking several rooms together shares one bookingGroupId
  // (set by the backend when the reservation was created). Collapse those
  // rows into ONE line in the list — showing every room, the combined total
  // and combined advance/due — instead of one confusingly-duplicated row per
  // room with the same guest name and dates. Single-room bookings pass
  // through unchanged as a "group" of one.
  function buildRowGroups(list) {
    const map = new Map();
    for (const b of list) {
      const key = b.bookingGroupId || `single-${b.id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(b);
    }
    return Array.from(map.entries()).map(([key, rooms]) => {
      // The master reservation room (no "-R2"/"-R3" suffix on its booking
      // number) should always be the one displayed as the group's identity
      // — picking rooms[0] instead depended on whatever order the backend
      // happened to return rooms in, which could show a "-R2" booking
      // number as if it were the group's main ID.
      const master = rooms.find((r) => !/-R\d+$/.test(r.bookingNumber || '')) || rooms[0];
      const orderedRooms = [master, ...rooms.filter((r) => r !== master)];
      const totals = allocateGroupAdvance(orderedRooms);
      const total = totals.reduce((s, t) => s + t.total, 0);
      const advance = totals.reduce((s, t) => s + t.advance, 0);
      const balanceDue = +(total - advance).toFixed(2);
      const statuses = new Set(orderedRooms.map((r) => r.status));
      return {
        key,
        rooms: orderedRooms,
        totals,
        total,
        advance,
        balanceDue,
        status: statuses.size === 1 ? orderedRooms[0].status : 'MIXED',
        primary: master,
      };
    });
  }

  const rowGroups = buildRowGroups(pageBookings);

  async function handleCheckIn(id) {
    setBusyId(id);
    try {
      const booking = await window.api.checkInBooking(id);
      load();
      try {
        await handoffRoomWhatsApp('checkin', booking);
      } catch (shareError) {
        alert(`Guest checked in, but WhatsApp could not be opened: ${shareError?.message || 'Unknown error.'}`);
      }
    } catch (err) {
      alert(`Action could not be completed: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  }

  // Opens a confirmation modal showing the advance already collected and the
  // remaining balance due, and lets staff confirm/change the payment method
  // actually used to settle that balance at the counter — this makes sure
  // nothing is checked out without staff explicitly seeing (and acting on)
  // how much money is still owed.
  function openCheckoutModal(b) {
    setCheckoutTarget(b);
    setCheckoutPaymentMethod(b.paymentMethod || 'CASH');
    setCheckoutError('');
  }

  async function confirmCheckout(e) {
    e.preventDefault();
    const b = checkoutTarget;
    setBusyId(b.id);
    setCheckoutError('');
    try {
      const result = await window.api.checkOutBooking(b.id, checkoutPaymentMethod);
      setCheckoutTarget(null);
      load();
      try {
        await handoffRoomWhatsApp('checkout', result.booking, result.bill);
      } catch (shareError) {
        alert(`Guest checked out, but WhatsApp could not be opened: ${shareError?.message || 'Unknown error.'}`);
      }
    } catch (err) {
      setCheckoutError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  // Electron does not support window.prompt() (it silently no-ops / returns
  // null instead of showing a dialog), which is why the old Cancel button
  // appeared to do nothing when clicked. Replaced with a proper in-app modal
  // that works the same on desktop and mobile.
  // Stores the whole booking (not just its id) so the modal can show/default
  // the refund amount against whatever advance was actually collected.
  function openCancelModal(b) {
    setCancelTarget(b);
    setCancelReason('');
    setCancelRefund(b.advancePayment > 0 ? String(b.advancePayment) : '0');
    setCancelRefundMethod(b.advancePaymentMethod || 'CASH');
    setCancelError('');
  }

  async function confirmCancel(e) {
    e.preventDefault();
    const id = cancelTarget?.id;
    setBusyId(id);
    setCancelError('');
    try {
      await window.api.cancelBooking(id, cancelReason, parseFloat(cancelRefund) || 0, cancelRefundMethod);
      setCancelTarget(null);
      load();
    } catch (err) {
      setCancelError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  function openGroupCancelModal(g) {
    // g is the group row from buildRowGroups — find the master room's advance
    const masterAdvance = g.rooms.find((r) => !/-R\d+$/.test(r.bookingNumber || ''))?.advancePayment
      || g.rooms[0]?.advancePayment || 0;
    setGroupCancelTarget({ groupId: g.key, guestName: g.primary.guestName, rooms: g.rooms, masterAdvance });
    setGroupCancelReason('');
    setGroupCancelRefund(masterAdvance > 0 ? String(masterAdvance) : '0');
    setGroupCancelRefundMethod(g.primary.advancePaymentMethod || 'CASH');
    setGroupCancelError('');
  }

  async function confirmGroupCancel(e) {
    e.preventDefault();
    const { groupId } = groupCancelTarget;
    setBusyId(`group-${groupId}`);
    setGroupCancelError('');
    try {
      await window.api.cancelGroupBooking(groupId, groupCancelReason, parseFloat(groupCancelRefund) || 0, groupCancelRefundMethod);
      setGroupCancelTarget(null);
      load();
    } catch (err) {
      setGroupCancelError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  function toggleGroup(key) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // Shared action buttons for a booking — reused by both the desktop table
  // row and the mobile card's expanded detail panel.
  function renderRowActions(b) {
    const idDocuments = b.guestIdDocumentPaths?.length
      ? b.guestIdDocumentPaths
      : (b.guestIdDocumentPath ? [b.guestIdDocumentPath] : []);
    const isFuture = (b.checkInDate || '').slice(0, 10) > todayStr();
    // A future-dated room in a GROUP booking can be checked in/out early if at
    // least one sibling room in the group is already active today (CHECKED_IN or
    // CHECKED_OUT). The guest is physically present with the rest of the group —
    // blocking them here would force an unnecessary edit-booking round-trip.
    const groupSiblings = b.bookingGroupId
      ? bookings.filter((x) => x.bookingGroupId === b.bookingGroupId && x.id !== b.id)
      : [];
    const groupIsActive = groupSiblings.some(
      (x) => x.status === 'CHECKED_IN' || x.status === 'CHECKED_OUT'
    );
    const blockFuture = isFuture && !groupIsActive;
    return (
      <div className="fm-row-actions">
        {idDocuments.length > 0 && (
          <button
            className="btn-link"
            onClick={() => idDocuments.forEach((fileRef) => window.api.openIdDocument(fileRef))}
            title="Open all attached ID documents"
          >
            📎 View ID ({idDocuments.length})
          </button>
        )}
        {(b.status === 'BOOKED' || b.status === 'CHECKED_IN') && (
          <button className="btn-link" disabled={busyId === b.id} onClick={() => setEditingBooking(b)}>Edit</button>
        )}
        {b.status === 'BOOKED' && (
          <button
            className="btn-link"
            disabled={busyId === b.id || blockFuture}
            title={blockFuture ? `Check-in date is ${formatDate(b.checkInDate)} — not checkable in yet` : (isFuture ? `Check-in date is ${formatDate(b.checkInDate)} — allowed early because group siblings are active` : undefined)}
            onClick={() => handleCheckIn(b.id)}
          >
            Check In
          </button>
        )}
        {b.status === 'CHECKED_IN' && (
          <button className="btn-link" disabled={busyId === b.id} onClick={() => openCheckoutModal(b)}>Check Out</button>
        )}
        {(b.status === 'BOOKED' || b.status === 'CHECKED_IN') && canCancel && (
          <button className="btn-link danger" disabled={busyId === b.id} onClick={() => openCancelModal(b)}>Cancel</button>
        )}
        {b.status === 'CHECKED_OUT' && b.billId && (
          <button className="btn-link" onClick={() => window.api.openBillWindow(b.billId)}>View Invoice</button>
        )}
      </div>
    );
  }

  return (
    <div className="food-management">
      <div className="fm-list-card">
        <div className="fm-list-header">
          <h3 className="bookings-filter-title">Bookings</h3>
          <button className="btn btn-primary" onClick={() => setShowNewBooking(true)}>+ New Booking</button>
        </div>

        <div className="bookings-filter-group">
          <span className="bookings-filter-label">Search</span>
          <div className="bookings-search-bar">
            <input
              type="text"
              className="bookings-search-input"
              placeholder="Search by guest name, phone, booking no, or bill no…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            {searchInput && (
              <button type="button" className="bookings-search-clear" onClick={() => setSearchInput('')} aria-label="Clear search">✕</button>
            )}
          </div>
        </div>

        <div className="bookings-filter-group">
          <span className="bookings-filter-label">Date Range</span>
          <div className="report-period-tabs bookings-period-tabs">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                className={`cat-tab ${period === p.key ? 'active' : ''}`}
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {isCustom && (
          <div className="custom-range-bar">
            <label>
              From
              <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={customTo} min={customFrom} max={todayStr()} onChange={(e) => setCustomTo(e.target.value)} />
            </label>
            {customFrom > customTo && <span className="custom-range-error">"From" date must be before "To" date.</span>}
          </div>
        )}

        <div className="bookings-filter-group">
          <span className="bookings-filter-label">Status</span>
          <div className="report-period-tabs">
            {STATUS_TABS.map((t) => (
              <button
                key={t.key}
                className={`cat-tab ${status === t.key ? 'active' : ''}`}
                onClick={() => setStatus(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {bookings.length > 0 && (
          <p className="sales-history-note">
            Showing {safePage * BOOKINGS_PAGE_SIZE + 1}-{Math.min((safePage + 1) * BOOKINGS_PAGE_SIZE, bookings.length)} of {bookings.length} matching booking{bookings.length === 1 ? '' : 's'} for this range.
          </p>
        )}

        <div className="fm-table-wrapper bookings-desktop-table">
          <table className="fm-table">
            <thead>
              <tr>
                <th>Booking #</th><th>Room</th><th>Guest</th><th>Check-in</th><th>Check-out</th>
                <th>Status</th><th>Total</th>
                <th>Advance Paid / Balance Due<InfoTip text="Advance = amount already collected from the guest. Due = amount still owed for this stay." /></th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rowGroups.map((g) => {
                if (g.rooms.length === 1) {
                  const b = g.primary;
                  const { total, advance, balanceDue } = bookingTotals(b);
                  return (
                    <tr key={g.key}>
                      <td>{b.bookingNumber}</td>
                      <td>{b.roomNumber} <span className="dim">({b.roomType})</span></td>
                      <td>{b.guestName}{b.guestPhone ? ` · ${b.guestPhone}` : ''}</td>
                      <td>{formatDate(b.checkInDate)}</td>
                      <td>{formatDate(b.checkOutDate)}</td>
                      <td><span className={`status-badge ${STATUS_BADGE_CLASS[b.status] || ''}`}>{b.status.replace('_', ' ')}</span></td>
                      <td>{formatCurrency(total)}</td>
                      <td>
                        <span className="booking-balance-cell">
                          <span className="dim">Advance: {formatCurrency(advance)}</span>
                          {b.status !== 'CHECKED_OUT' && b.status !== 'CANCELLED' && (
                            <strong>Due: {formatCurrency(balanceDue)}</strong>
                          )}
                          {refundLine(b)}
                        </span>
                      </td>
                      <td>
                        <div className="fm-row-actions">
                          {renderRowActions(b)}
                          {(b.status === 'BOOKED' || b.status === 'CHECKED_IN') && (
                            <button type="button" className="btn-link" onClick={() => setAddRoomTarget(g)}>+ Add Room</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                }
                // Multiple rooms booked together for one guest — one summary
                // row (combined total/advance/due across all rooms), with an
                // expand toggle revealing each room's own status + actions,
                // since check-in/checkout/cancel can happen per-room.
                const isOpen = expandedGroups.has(g.key);
                return (
                  <React.Fragment key={g.key}>
                    <tr className="booking-group-row">
                      <td>{g.primary.bookingNumber} <span className="dim">(+{g.rooms.length - 1} more)</span></td>
                      <td>{g.rooms.map((r) => r.roomNumber).join(', ')}</td>
                      <td>{g.primary.guestName}{g.primary.guestPhone ? ` · ${g.primary.guestPhone}` : ''}</td>
                      <td>{formatDate(g.primary.checkInDate)}</td>
                      <td>{formatDate(g.primary.checkOutDate)}</td>
                      <td>
                        {g.status === 'MIXED'
                          ? <span className="status-badge booked">Mixed</span>
                          : <span className={`status-badge ${STATUS_BADGE_CLASS[g.status] || ''}`}>{g.status.replace('_', ' ')}</span>}
                      </td>
                      <td>{formatCurrency(g.total)}</td>
                      <td>
                        <span className="booking-balance-cell">
                          <span className="dim">Advance: {formatCurrency(g.advance)}</span>
                          {g.status !== 'CHECKED_OUT' && g.status !== 'CANCELLED' && (
                            <strong>Due: {formatCurrency(g.balanceDue)}</strong>
                          )}
                        </span>
                      </td>
                      <td>
                        <div className="fm-row-actions">
                          <button type="button" className="btn-link" onClick={() => toggleGroup(g.key)}>
                            {isOpen ? '▾ Hide room-by-room details' : `▸ Show all ${g.rooms.length} rooms`}
                          </button>
                          {g.status !== 'CANCELLED' && g.status !== 'CHECKED_OUT' && (
                            <button type="button" className="btn-link" onClick={() => setAddRoomTarget(g)}>+ Add Another Room</button>
                          )}
                          {canCancel && g.rooms.some((r) => r.status === 'BOOKED' || r.status === 'CHECKED_IN') && (
                            <button
                              type="button"
                              className="btn-link danger"
                              disabled={busyId === `group-${g.key}`}
                              onClick={() => openGroupCancelModal(g)}
                              title="Cancel all pending rooms in this group booking at once"
                            >
                              Cancel All Rooms
                            </button>
                          )}
                          {g.rooms.length > 1 && g.rooms.every((r) => r.status === 'CHECKED_OUT' || r.status === 'CANCELLED') && (
                            <button type="button" className="btn-link" onClick={() => window.api.openGroupBillWindow(g.key)} title="One single invoice covering every room in this group booking">
                              Combined Invoice (All Rooms)
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isOpen && g.totals.map(({ room: b, total, advance, balanceDue }) => (
                      <tr key={b.id} className="booking-group-subrow">
                        <td className="dim">{b.bookingNumber}</td>
                        <td>{b.roomNumber} <span className="dim">({b.roomType})</span></td>
                        <td className="dim">↳ same guest</td>
                        <td>{formatDate(b.checkInDate)}</td>
                        <td>{formatDate(b.checkOutDate)}</td>
                        <td><span className={`status-badge ${STATUS_BADGE_CLASS[b.status] || ''}`}>{b.status.replace('_', ' ')}</span></td>
                        <td>{formatCurrency(total)}</td>
                        <td>
                          <span className="booking-balance-cell">
                            <span className="dim">Advance: {formatCurrency(advance)}</span>
                            {b.status !== 'CHECKED_OUT' && b.status !== 'CANCELLED' && (
                              <strong>Due: {formatCurrency(balanceDue)}</strong>
                            )}
                            {refundLine(b)}
                          </span>
                        </td>
                        <td>{renderRowActions(b)}</td>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
              {bookings.length === 0 && (
                <tr><td colSpan={9} className="empty-state small">No bookings found.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile-only: collapsible cards instead of a wide, horizontally
            scrolling table. Each card shows just Guest + Room + Status by
            default; tapping the arrow expands it to reveal check-in/out,
            total, advance/due and the action buttons. */}
        <div className="bookings-mobile-cards">
          {rowGroups.map((g) => {
            if (g.rooms.length === 1) {
              const b = g.primary;
              const { total, advance, balanceDue } = bookingTotals(b);
              const expanded = expandedId === b.id;
              return (
                <div className={`booking-card ${expanded ? 'expanded' : ''}`} key={g.key}>
                  <button
                    type="button"
                    className="booking-card-summary"
                    onClick={() => setExpandedId(expanded ? null : b.id)}
                  >
                    <div className="booking-card-main">
                      <span className="booking-card-guest">{b.guestName}</span>
                      <span className="booking-card-room">Room {b.roomNumber} <span className="dim">({b.roomType})</span></span>
                    </div>
                    <div className="booking-card-right">
                      <span className={`status-badge ${STATUS_BADGE_CLASS[b.status] || ''}`}>{b.status.replace('_', ' ')}</span>
                      <span className="booking-card-arrow">›</span>
                    </div>
                  </button>
                  {expanded && (
                    <div className="booking-card-details">
                      <div className="booking-card-row"><span>Booking #</span><span>{b.bookingNumber}</span></div>
                      <div className="booking-card-row"><span>Check-in</span><span>{formatDate(b.checkInDate)}</span></div>
                      <div className="booking-card-row"><span>Check-out</span><span>{formatDate(b.checkOutDate)}</span></div>
                      <div className="booking-card-row"><span>Total</span><span>{formatCurrency(total)}</span></div>
                      <div className="booking-card-row"><span>Advance Received</span><span>{formatCurrency(advance)}</span></div>
                      {b.status !== 'CHECKED_OUT' && b.status !== 'CANCELLED' && (
                        <div className="booking-card-row"><span>Balance Due</span><strong>{formatCurrency(balanceDue)}</strong></div>
                      )}
                      {b.status === 'CANCELLED' && b.refundAmount != null && (
                        <div className="booking-card-row">
                          <span>Refund</span>
                          {b.refundAmount > 0 ? <strong>{formatCurrency(b.refundAmount)}</strong> : <span>Not refunded</span>}
                        </div>
                      )}
                      {renderRowActions(b)}
                    </div>
                  )}
                </div>
              );
            }
            // Multi-room booking for one guest — one card listing every room;
            // expanding reveals each room's own status, total and actions.
            const expanded = expandedId === g.key;
            return (
              <div className={`booking-card ${expanded ? 'expanded' : ''}`} key={g.key}>
                <button
                  type="button"
                  className="booking-card-summary"
                  onClick={() => setExpandedId(expanded ? null : g.key)}
                >
                  <div className="booking-card-main">
                    <span className="booking-card-guest">{g.primary.guestName}</span>
                    <span className="booking-card-room">{g.rooms.length} rooms: {g.rooms.map((r) => r.roomNumber).join(', ')}</span>
                  </div>
                  <div className="booking-card-right">
                    {g.status === 'MIXED'
                      ? <span className="status-badge booked">Mixed</span>
                      : <span className={`status-badge ${STATUS_BADGE_CLASS[g.status] || ''}`}>{g.status.replace('_', ' ')}</span>}
                    <span className="booking-card-arrow">›</span>
                  </div>
                </button>
                {expanded && (
                  <div className="booking-card-details">
                    <div className="booking-card-row"><span>Check-in</span><span>{formatDate(g.primary.checkInDate)}</span></div>
                    <div className="booking-card-row"><span>Check-out</span><span>{formatDate(g.primary.checkOutDate)}</span></div>
                    <div className="booking-card-row"><span>Combined Total</span><span>{formatCurrency(g.total)}</span></div>
                    <div className="booking-card-row"><span>Advance Received</span><span>{formatCurrency(g.advance)}</span></div>
                    {g.status !== 'CHECKED_OUT' && g.status !== 'CANCELLED' && (
                      <div className="booking-card-row"><span>Balance Due</span><strong>{formatCurrency(g.balanceDue)}</strong></div>
                    )}
                    {g.rooms.length > 1 && g.rooms.every((r) => r.status === 'CHECKED_OUT' || r.status === 'CANCELLED') && (
                      <button type="button" className="btn-link" onClick={() => window.api.openGroupBillWindow(g.key)}>Combined Invoice (All Rooms)</button>
                    )}
                    {canCancel && g.rooms.some((r) => r.status === 'BOOKED' || r.status === 'CHECKED_IN') && (
                      <button
                        type="button"
                        className="btn-link danger"
                        disabled={busyId === `group-${g.key}`}
                        onClick={() => openGroupCancelModal(g)}
                      >
                        Cancel All Rooms
                      </button>
                    )}
                    {g.totals.map(({ room: b, total, advance, balanceDue }) => (
                      <div className="booking-card-subblock" key={b.id}>
                        <div className="booking-card-row"><span>Room {b.roomNumber} <span className="dim">({b.roomType})</span></span><span className={`status-badge ${STATUS_BADGE_CLASS[b.status] || ''}`}>{b.status.replace('_', ' ')}</span></div>
                        <div className="booking-card-row"><span>Booking #</span><span>{b.bookingNumber}</span></div>
                        <div className="booking-card-row"><span>Total</span><span>{formatCurrency(total)}{b.status !== 'CHECKED_OUT' && b.status !== 'CANCELLED' ? ` (Advance: ${formatCurrency(advance)}, Due: ${formatCurrency(balanceDue)})` : ''}</span></div>
                        {b.status === 'CANCELLED' && b.refundAmount != null && (
                          <div className="booking-card-row"><span>Refund</span><span>{b.refundAmount > 0 ? formatCurrency(b.refundAmount) : 'Not refunded'}</span></div>
                        )}
                        {renderRowActions(b)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {bookings.length === 0 && <p className="empty-state small">No bookings found.</p>}
        </div>
        {bookings.length > BOOKINGS_PAGE_SIZE && (
          <div className="sales-history-pagination">
            <button
              className="btn btn-secondary"
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              ← Previous
            </button>
            <span>Page {safePage + 1} of {totalPages}</span>
            <button
              className="btn btn-secondary"
              disabled={safePage >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            >
              Next →
            </button>
          </div>
        )}
      </div>

      {showNewBooking && (
        <BookingFormModal
          rooms={rooms}
          onClose={() => setShowNewBooking(false)}
          onSaved={load}
        />
      )}
      {editingBooking && (
        <BookingFormModal
          rooms={rooms}
          booking={editingBooking}
          onClose={() => setEditingBooking(null)}
          onSaved={load}
        />
      )}
      {addRoomTarget && (
        <AddRoomToBookingModal
          group={addRoomTarget}
          rooms={rooms}
          onClose={() => setAddRoomTarget(null)}
          onSaved={() => { setAddRoomTarget(null); load(); }}
        />
      )}
      {cancelTarget != null && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setCancelTarget(null)}>
          <div className="modal">
            <h4>Cancel Booking</h4>
            <form onSubmit={confirmCancel} className="fm-form">
              <label>
                Reason for cancellation (optional)
                <textarea
                  rows={3}
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder="e.g. Guest requested cancellation"
                />
              </label>
              {cancelTarget.advancePayment > 0 && (
                <>
                  <p className="settings-sub" style={{ margin: '4px 0 0' }}>
                    Advance already collected: <strong>{formatCurrency(cancelTarget.advancePayment)}</strong>. How much of it is being refunded to the guest?
                  </p>
                  <label>
                    Refund Amount (₹) — 0 keeps it as a cancellation fee
                    <input
                      type="number"
                      min="0"
                      max={cancelTarget.advancePayment}
                      step="1"
                      value={cancelRefund}
                      onChange={(e) => setCancelRefund(e.target.value)}
                    />
                  </label>
                  {parseFloat(cancelRefund) > 0 && (
                    <label>
                      Refund Method
                      <select value={cancelRefundMethod} onChange={(e) => setCancelRefundMethod(e.target.value)}>
                        <option value="CASH">Cash</option>
                        <option value="ONLINE">Online</option>
                      </select>
                    </label>
                  )}
                </>
              )}
              {cancelError && <div className="form-error">{cancelError}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setCancelTarget(null)}>Keep Booking</button>
                <button type="submit" className="btn btn-danger" disabled={busyId === cancelTarget.id}>Confirm Cancellation</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {groupCancelTarget != null && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setGroupCancelTarget(null)}>
          <div className="modal">
            <h4>Cancel Group Booking — {groupCancelTarget.guestName}</h4>
            <p className="settings-sub" style={{ margin: '0 0 8px' }}>
              This will cancel <strong>all {groupCancelTarget.rooms.filter((r) => r.status === 'BOOKED' || r.status === 'CHECKED_IN').length} pending room{groupCancelTarget.rooms.filter((r) => r.status === 'BOOKED' || r.status === 'CHECKED_IN').length === 1 ? '' : 's'}</strong> in this group booking at once.
              Already checked-out rooms are not affected.
            </p>
            <form onSubmit={confirmGroupCancel} className="fm-form">
              <label>
                Reason for cancellation (optional)
                <textarea
                  rows={3}
                  value={groupCancelReason}
                  onChange={(e) => setGroupCancelReason(e.target.value)}
                  placeholder="e.g. Guest requested full cancellation"
                />
              </label>
              {groupCancelTarget.masterAdvance > 0 && (
                <>
                  <p className="settings-sub" style={{ margin: '4px 0 0' }}>
                    Advance already collected: <strong>{formatCurrency(groupCancelTarget.masterAdvance)}</strong>. How much is being refunded?
                  </p>
                  <label>
                    Refund Amount (₹) — 0 keeps it as a cancellation fee
                    <input
                      type="number"
                      min="0"
                      max={groupCancelTarget.masterAdvance}
                      step="1"
                      value={groupCancelRefund}
                      onChange={(e) => setGroupCancelRefund(e.target.value)}
                    />
                  </label>
                  {parseFloat(groupCancelRefund) > 0 && (
                    <label>
                      Refund Method
                      <select value={groupCancelRefundMethod} onChange={(e) => setGroupCancelRefundMethod(e.target.value)}>
                        <option value="CASH">Cash</option>
                        <option value="ONLINE">Online</option>
                      </select>
                    </label>
                  )}
                </>
              )}
              {groupCancelError && <div className="form-error">{groupCancelError}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setGroupCancelTarget(null)}>Keep Booking</button>
                <button type="submit" className="btn btn-danger" disabled={busyId === `group-${groupCancelTarget.groupId}`}>
                  Cancel All Rooms
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {checkoutTarget != null && (() => {
        const { total, advance, balanceDue } = bookingTotals(checkoutTarget);
        return (
          <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setCheckoutTarget(null)}>
            <div className="modal">
              <h4>Check Out — {checkoutTarget.guestName}</h4>
              <form onSubmit={confirmCheckout} className="fm-form">
                <div className="checkout-summary">
                  <span>Room {checkoutTarget.roomNumber} · Bill Total: {formatCurrency(total)}</span>
                  {advance > 0 && <span>Advance Already Received: -{formatCurrency(advance)}</span>}
                  <strong className={balanceDue > 0 ? 'checkout-due-positive' : ''}>
                    Balance Due Now: {formatCurrency(balanceDue)}
                  </strong>
                </div>
                <label>
                  Payment Method for Balance Due
                  <select value={checkoutPaymentMethod} onChange={(e) => setCheckoutPaymentMethod(e.target.value)}>
                    <option value="CASH">Cash</option>
                    <option value="ONLINE">Online / UPI</option>
                  </select>
                </label>
                {checkoutError && <div className="form-error">{checkoutError}</div>}
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setCheckoutTarget(null)}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={busyId === checkoutTarget.id}>
                    Confirm — I Have Collected {formatCurrency(balanceDue)}
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
