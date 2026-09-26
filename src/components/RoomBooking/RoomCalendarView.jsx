import React, { useEffect, useState, useCallback, useMemo } from 'react';
import BookingFormModal from './BookingFormModal';
import AddRoomToBookingModal from './AddRoomToBookingModal';
import { formatCurrency } from '../../utils/format';
import { allocateGroupAdvance } from '../../utils/roomBookingMath';
import InfoTip from '../common/InfoTip';
import { handoffRoomWhatsApp } from '../../utils/roomWhatsApp';

// Tape-chart / booking calendar — the standard "rooms as rows, days as
// columns, colored bar per stay" view used by every real hotel PMS/OTA
// extranet (Cloudbeds, RoomRaccoon, eZee, etc.).
//
// Window is a ROLLING range starting from today (not a calendar-aligned
// week/month). Week = 7 days and Month = 30 days. Prev/Next shift the window
// by its own size, including into past dates so completed bookings remain
// available as calendar history; Today snaps back to the current date.
const STATUS_BAR_META = {
  BOOKED: { label: 'Reserved' },
  CHECKED_IN: { label: 'Checked-in' },
  CHECKED_OUT: { label: 'Checked-out' },
};
const STATUS_BADGE_CLASS = {
  BOOKED: 'booked',
  CHECKED_IN: 'checkedin',
  CHECKED_OUT: 'completed',
  CANCELLED: 'cancelled',
};

// A vibrant, high-contrast palette cycled by booking id so adjacent stays
// are always easy to tell apart at a glance, instead of every booking
// looking the same flat color.
const PALETTE = [
  ['#6366f1', '#818cf8'],
  ['#f59e0b', '#fbbf24'],
  ['#10b981', '#34d399'],
  ['#ec4899', '#f472b6'],
  ['#0ea5e9', '#38bdf8'],
  ['#f97316', '#fb923c'],
  ['#8b5cf6', '#a78bfa'],
  ['#ef4444', '#f87171'],
];

function toDateStr(d) {
  // Build the date from LOCAL getters, not toISOString() (which is UTC).
  // For timezones ahead of UTC (e.g. India, UTC+5:30), toISOString() rolls
  // back to "yesterday" during the first few hours of each local day —
  // that's why the calendar was starting one day early / "today" was
  // highlighting the wrong column.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// Bookings store check-in/check-out as full datetime-local values
// ("YYYY-MM-DDTHH:mm"), not plain calendar dates. Every date-only comparison
// here must strip the time first — otherwise appending "T00:00:00" to an
// already-timestamped string (e.g. "2026-09-10T14:00" + "T00:00:00") builds
// an invalid Date, which silently produced NaN day-indexes and made booked
// bars vanish from the calendar entirely.
function dateOnly(s) {
  return (s || '').slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateOnly(dateStr) + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}
function dayIndex(dateStr, windowStart) {
  return Math.round((new Date(dateOnly(dateStr) + 'T00:00:00') - new Date(dateOnly(windowStart) + 'T00:00:00')) / 86400000);
}
function todayStr() {
  return toDateStr(new Date());
}
function isWeekend(dateStr) {
  const day = new Date(dateStr + 'T00:00:00').getDay();
  return day === 0 || day === 6;
}
function fmtShort(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export default function RoomCalendarView() {
  // On phones/small tablets, default to Week view (7 columns) instead of
  // Month (30 columns) — 30 narrow day-columns simply don't fit a phone
  // screen and forcing a long horizontal scroll to see the tape chart felt
  // broken. Week view is then sized to the actual available width (below)
  // so it needs little to no horizontal scrolling on mobile.
  const isMobileViewport = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;
  const [viewMode, setViewMode] = useState(() => (isMobileViewport() ? 'week' : 'month'));
  const [anchor, setAnchor] = useState(todayStr());
  const [rooms, setRooms] = useState([]);
  const [bookCell, setBookCell] = useState(null); // { roomId, date } | null
  const [containerWidth, setContainerWidth] = useState(0);
  const [showNewBooking, setShowNewBooking] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState(null); // full booking details, fetched on bar click
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false); // collapsed-card summary (guest/rooms/status), matching the Bookings tab's mobile card — tapping it reveals the info + action buttons
  const [editingBooking, setEditingBooking] = useState(null);
  const [addRoomTarget, setAddRoomTarget] = useState(null);
  const [checkoutMode, setCheckoutMode] = useState(false);
  const [checkoutPaymentMethod, setCheckoutPaymentMethod] = useState('CASH');
  const [cancelMode, setCancelMode] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelRefund, setCancelRefund] = useState('0');
  const [cancelRefundMethod, setCancelRefundMethod] = useState('CASH');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const scrollRef = React.useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const windowDays = viewMode === 'month' ? 30 : 7;
  const windowStart = anchor;
  const windowEnd = useMemo(() => addDays(windowStart, windowDays), [windowStart, windowDays]);
  const days = useMemo(
    () => Array.from({ length: windowDays }, (_, i) => addDays(windowStart, i)),
    [windowStart, windowDays]
  );

  const load = useCallback(() => {
    window.api.getRoomCalendar({ from: windowStart, to: windowEnd }).then(setRooms);
  }, [windowStart, windowEnd]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  // Direct search box below the calendar: search by guest name, phone,
  // booking no, or bill no and jump straight to that booking's detail panel
  // — same backend search used by the Bookings tab's search box.
  useEffect(() => {
    const term = searchInput.trim();
    if (!term) { setSearchResults([]); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      window.api.listBookings({ search: term }).then((rows) => {
        setSearchResults(rows.slice(0, 8));
        setSearching(false);
      });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  function pickSearchResult(bookingId) {
    openBookingDetail(bookingId);
    setSearchInput('');
    setSearchResults([]);
  }

  function switchView(mode) {
    setViewMode(mode);
    setAnchor(todayStr());
  }
  function goToday() {
    setAnchor(todayStr());
  }
  function goPrev() {
    setAnchor((d) => addDays(d, -windowDays));
  }
  function goNext() {
    setAnchor((d) => addDays(d, windowDays));
  }

  // Clicking a booking bar fetches its full record (total/advance/addons
  // etc. aren't in the lightweight calendar payload) and shows a detail
  // panel below the tape chart to view/act on it without leaving the
  // calendar.
  function openBookingDetail(bookingId) {
    setActionError('');
    setCheckoutMode(false);
    setCancelMode(false);
    setDetailExpanded(false);
    setSelectedLoading(true);
    setSelectedBooking({ id: bookingId }); // placeholder so the panel opens immediately
    window.api.getBookingById(bookingId).then((b) => {
      setSelectedBooking(b);
      setSelectedLoading(false);
    });
  }
  function closeBookingDetail() {
    setSelectedBooking(null);
    setCheckoutMode(false);
    setCancelMode(false);
    setDetailExpanded(false);
    setActionError('');
  }
  function bookingTotals(b) {
    // b.groupRooms carries every sibling in the same reservation (with all
    // the fields allocateGroupAdvance needs) whenever this booking is part
    // of a multi-room group — combine with the booking itself to run the
    // same capped/carry-forward advance math used at real checkout.
    const siblings = [b, ...(b.groupRooms || [])];
    const allocated = allocateGroupAdvance(siblings);
    const mine = allocated.find((t) => t.room.id === b.id) || allocated[0];
    return { total: mine.total, advance: mine.advance, balanceDue: mine.balanceDue };
  }
  async function handleCheckIn() {
    setActionBusy(true);
    setActionError('');
    try {
      const booking = await window.api.checkInBooking(selectedBooking.id);
      openBookingDetail(selectedBooking.id);
      load();
      try {
        await handoffRoomWhatsApp('checkin', booking);
      } catch (shareError) {
        setActionError(`Guest checked in, but WhatsApp could not be opened: ${shareError?.message || 'Unknown error.'}`);
      }
    } catch (err) {
      setActionError(err.message);
    } finally {
      setActionBusy(false);
    }
  }
  async function confirmCheckout() {
    setActionBusy(true);
    setActionError('');
    try {
      const result = await window.api.checkOutBooking(selectedBooking.id, checkoutPaymentMethod);
      setCheckoutMode(false);
      openBookingDetail(selectedBooking.id);
      load();
      try {
        await handoffRoomWhatsApp('checkout', result.booking, result.bill);
      } catch (shareError) {
        setActionError(`Guest checked out, but WhatsApp could not be opened: ${shareError?.message || 'Unknown error.'}`);
      }
    } catch (err) {
      setActionError(err.message);
    } finally {
      setActionBusy(false);
    }
  }
  async function confirmCancel() {
    setActionBusy(true);
    setActionError('');
    try {
      await window.api.cancelBooking(selectedBooking.id, cancelReason, parseFloat(cancelRefund) || 0, cancelRefundMethod);
      setCancelMode(false);
      closeBookingDetail();
      load();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setActionBusy(false);
    }
  }

  const today = todayStr();
  const rangeLabel = `${fmtShort(days[0])} – ${fmtShort(days[days.length - 1])}`;
  // Week view stretches its columns to fill whatever width is actually
  // available (so on a phone it fits with zero/near-zero horizontal
  // scrolling). Month view now does the same on desktop — shrinking all 30
  // columns down as needed to fit the available width with zero horizontal
  // scroll, since a mouse-driven desktop view has no natural "swipe" gesture
  // and a visible scrollbar felt like wasted space when the window is wide
  // enough to just show the whole month at once. On phones the floor stays
  // higher (30 genuinely-tiny columns would be unreadable/untappable), so
  // scrolling remains expected there, matching every real hotel PMS tape
  // chart's mobile behavior.
  // `containerWidth` is measured on `.room-cal-scroll` (the days-only
  // scrolling pane, now split from the frozen room-label column below), so
  // it no longer needs a labelWidth subtracted out here.
  // Month view must scroll horizontally on tablets and phones instead of
  // squeezing 30 dates into unreadable 20px columns. Desktop keeps the
  // compact fit when there is enough room; touch layouts get a stable,
  // tappable date width for both Week and Month views.
  const isDesktopViewport = typeof window !== 'undefined'
    && window.matchMedia('(min-width: 1025px)').matches;
  const monthMinColWidth = isDesktopViewport ? 24 : 58;
  const fitColWidth = containerWidth ? Math.max(monthMinColWidth, Math.floor((containerWidth - 2) / windowDays)) : 110;
  const colWidth = viewMode === 'month' ? fitColWidth : Math.max(58, fitColWidth);

  function isRoomFreeOn(room, dateStr) {
    // A room under MAINTENANCE is never bookable, even on a date with no
    // clashing reservation — it must never show as "Free — click to book".
    if (room.status === 'MAINTENANCE') return false;
    // A checked-out reservation is historical and must not keep the room
    // unbookable on the calendar. This is especially important when a guest
    // checks out early: the scheduled check-out date can still be in the
    // future, but the room is already available for a new reservation.
    return !room.bookings.some((b) => (
      ['BOOKED', 'CHECKED_IN'].includes(b.status)
      && !(dateOnly(b.checkOutDate) <= dateStr || dateOnly(b.checkInDate) > dateStr)
    ));
  }

  return (
    <div className="fm-list-card room-calendar-card">
      {/* Circular FAB, pinned top-left above the calendar. Absolutely
          positioned so expanding it into the "New Booking" pill on hover
          never shifts/reflows the header or toolbar next to it. */}
      <button
        type="button"
        className="room-cal-fab"
        onClick={() => setShowNewBooking(true)}
        aria-label="New Booking"
      >
        <span className="room-cal-fab-icon">+</span>
        <span className="room-cal-fab-label">New Booking</span>
      </button>
      <div className="fm-list-header">
        <h3>📅 Booking Calendar</h3>
        <div className="room-calendar-nav">
          <div className="report-source-switch">
            <button type="button" className={`cat-tab ${viewMode === 'week' ? 'active' : ''}`} onClick={() => switchView('week')}>Week</button>
            <button type="button" className={`cat-tab ${viewMode === 'month' ? 'active' : ''}`} onClick={() => switchView('month')}>Month</button>
          </div>
          <div className="room-cal-nav-group">
            <button type="button" className="room-cal-nav-btn" onClick={goPrev} aria-label="Previous">‹</button>
            <button type="button" className="room-cal-nav-btn room-cal-nav-today" onClick={goToday}>Today</button>
            <button type="button" className="room-cal-nav-btn" onClick={goNext} aria-label="Next">›</button>
          </div>
          <span className="room-calendar-range">{rangeLabel}</span>
        </div>
      </div>

      <p className="room-cal-tip">Select a free date to create a booking · Select a booking bar to manage it</p>

      <div className="room-cal-legend">
        <span className="room-cal-legend-item"><i className="room-cal-status-dot reserved" />Reserved</span>
        <span className="room-cal-legend-item"><i className="room-cal-status-dot checked-in" />Checked-in</span>
        <span className="room-cal-legend-item"><i className="room-cal-status-dot checked-out" />Checked-out</span>
        <span className="room-cal-legend-item"><i className="room-cal-status-dot free" />Available</span>
        <span className="room-cal-legend-item"><i className="room-cal-status-dot maintenance" />Maintenance</span>
      </div>

      <div className="room-cal-split">
        {/* Frozen room-label column — deliberately a SEPARATE, non-scrolling
            pane (not `position: sticky` inside the scrolling one) so it can
            never interfere with the day-grid's own horizontal scroll range.
            An earlier sticky-column attempt caused the scrollable pane to
            stop short partway through the month on some mobile browsers;
            keeping the two panes fully independent avoids that class of bug
            entirely — this is also how every real hotel tape chart (Cloudbeds
            etc.) implements a frozen first column. */}
        <div className="room-cal-frozen-col">
          <div className="room-cal-frozen-row room-cal-frozen-header room-cal-corner">Room</div>
          {rooms.map((r, idx) => (
            <div key={r.id} className={`room-cal-frozen-row ${idx % 2 === 1 ? 'room-cal-row-alt' : ''}`}>
              <span className="room-cal-room-number">🛏️ {r.roomNumber}{r.status === 'MAINTENANCE' ? ' 🔧' : ''}</span>
              <span className="room-cal-room-type">{r.roomType}{r.status === 'MAINTENANCE' ? ' — Maintenance' : ''}</span>
            </div>
          ))}
          {rooms.length === 0 && <div className="room-cal-frozen-row" />}
        </div>

        <div className="room-cal-scroll" ref={scrollRef}>
          {/* `key` forces a remount on window change, which restarts the
              fade/slide-in CSS animation below — giving Prev/Next/Today a
              light, responsive feel instead of an abrupt content swap. */}
          <div className="room-cal-table" key={windowStart}>
            <div className="room-cal-row room-cal-header-row">
              <div className="room-cal-days-grid" style={{ gridTemplateColumns: `repeat(${windowDays}, ${colWidth}px)`, width: colWidth * windowDays }}>
                {days.map((d) => (
                  <div key={d} className={`room-cal-day-header ${d === today ? 'is-today' : ''} ${isWeekend(d) ? 'is-weekend' : ''}`}>
                    <span className="room-cal-day-name">{new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' })}</span>
                    <span className="room-cal-day-num">{Number(d.slice(8, 10))}</span>
                  </div>
                ))}
              </div>
            </div>

            {rooms.map((r, idx) => (
              <div key={r.id} className={`room-cal-row ${idx % 2 === 1 ? 'room-cal-row-alt' : ''}`}>
                <div className="room-cal-days-grid" style={{ gridTemplateColumns: `repeat(${windowDays}, ${colWidth}px)`, width: colWidth * windowDays }}>
                  {days.map((d) => {
                    const free = isRoomFreeOn(r, d);
                    const underMaintenance = r.status === 'MAINTENANCE';
                    return (
                      <div
                        key={d}
                        className={`room-cal-day-cell ${d === today ? 'is-today' : ''} ${isWeekend(d) ? 'is-weekend' : ''} ${free ? 'is-free' : ''} ${underMaintenance ? 'is-maintenance' : ''}`}
                        onClick={() => free && setBookCell({ roomId: r.id, date: d })}
                        title={underMaintenance ? `${r.roomNumber} is under maintenance — not bookable` : (free ? `Click to book ${r.roomNumber} on ${d}` : '')}
                      />
                    );
                  })}
                  <div className="room-cal-bars-layer">
                    {r.bookings.map((b) => {
                      // Bars are positioned with pixel-precise math (not whole
                      // CSS grid columns) so two back-to-back bookings on the
                      // same room always meet EXACTLY at the mid-point of their
                      // shared day (~11am checkout / ~2pm check-in), regardless
                      // of how long either stay is.
                      const rawStartFrac = dayIndex(b.checkInDate, windowStart) + 0.5;
                      const rawEndFrac = dayIndex(b.checkOutDate, windowStart) + 0.5;
                      const startFrac = Math.max(0, rawStartFrac);
                      const endFrac = Math.min(windowDays, rawEndFrac);
                      if (endFrac <= startFrac) return null;
                      const meta = STATUS_BAR_META[b.status] || STATUS_BAR_META.BOOKED;
                      const [c1, c2] = PALETTE[b.id % PALETTE.length];
                      const trueLeftPx = startFrac * colWidth;
                      const trueWidthPx = (endFrac - startFrac) * colWidth;
                      // No cut (flush edge) on a side truncated by the visible
                      // window — there's no "other half" to notch against there.
                      const leftCut = startFrac === rawStartFrac;
                      const rightCut = endFrac === rawEndFrac;
                      // Fixed-size notch (not a % of the bar's own width) so
                      // every bar's slant looks the same regardless of stay
                      // length. Each cut side EXTENDS the box half a notch
                      // past the true boundary and the adjoining bar extends
                      // the same half-notch back the other way — together
                      // their two clipped triangles form one continuous
                      // diagonal seam with no gap, instead of both bars
                      // independently receding away from the boundary (which
                      // is what left a diamond-shaped hole between them).
                      const notch = Math.max(0, Math.min(16, colWidth * 0.4, trueWidthPx - 2));
                      const half = Math.max(0, notch) / 2;
                      const boxLeft = trueLeftPx - (leftCut ? half : 0);
                      const boxWidth = trueWidthPx + (leftCut ? half : 0) + (rightCut ? half : 0);
                      const topLeftX = leftCut ? 0 : 0;
                      const bottomLeftX = leftCut ? notch : 0;
                      const topRightX = rightCut ? boxWidth - notch : boxWidth;
                      const bottomRightX = boxWidth;
                      const clipPath = `polygon(${topLeftX}px 0, ${topRightX}px 0, ${bottomRightX}px 100%, ${bottomLeftX}px 100%)`;
                      const isCheckedOut = b.status === 'CHECKED_OUT';
                      const background = isCheckedOut
                        ? 'linear-gradient(135deg, #fce7f3, #fbcfe8)'
                        : `linear-gradient(135deg, ${c1}, ${c2})`;
                      return (
                        <div
                          key={b.id}
                          className={`room-cal-bar ${b.status === 'CHECKED_IN' ? 'room-cal-bar-occupied' : ''} ${isCheckedOut ? 'room-cal-bar-checked-out' : ''} ${b.isGroupBooking ? 'room-cal-bar-grouped' : ''}`}
                          style={{
                            left: boxLeft,
                            width: boxWidth,
                            background,
                            clipPath,
                            WebkitClipPath: clipPath,
                          }}
                          onClick={() => openBookingDetail(b.id)}
                          title={`${b.guestName || 'Guest'} · ${b.checkInDate} to ${b.checkOutDate} · ${meta.label}${b.isGroupBooking ? ` · Group booking (${b.groupRoomCount} rooms)` : ''} · Click for details`}
                        >
                          <span className="room-cal-bar-label">
                            {isCheckedOut ? '🚪 ' : b.status === 'CHECKED_IN' ? '🔑 ' : '👤 '}{b.guestName || 'Guest'}
                            {b.isGroupBooking && <span className="room-cal-group-badge" title={`Group booking · ${b.groupRoomCount} rooms`}>👥{b.groupRoomCount}</span>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
            {rooms.length === 0 && <div className="empty-state small">No rooms configured yet. Add rooms in the Rooms tab.</div>}
          </div>
        </div>
      </div>

      <div className="room-cal-search-bar">
        <div className="bookings-search-bar">
          <input
            type="text"
            className="bookings-search-input"
            placeholder="🔍 Search bookings by guest name, phone, booking no, or bill no…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {searchInput && (
            <button type="button" className="bookings-search-clear" onClick={() => setSearchInput('')} aria-label="Clear search">✕</button>
          )}
        </div>
        {searchInput.trim() && (
          <div className="room-cal-search-results">
            {searching && <div className="empty-state small">Searching…</div>}
            {!searching && searchResults.length === 0 && <div className="empty-state small">No bookings match "{searchInput.trim()}".</div>}
            {!searching && searchResults.map((b) => (
              <button
                type="button"
                key={b.id}
                className="room-cal-search-result-row"
                onClick={() => pickSearchResult(b.id)}
              >
                <span className="room-cal-search-result-main">
                  <strong>{b.guestName || 'Guest'}</strong> · Room {b.roomNumber} · {b.bookingNumber}
                </span>
                <span className={`status-badge ${STATUS_BADGE_CLASS[b.status] || ''}`}>{(b.status || '').replace('_', ' ')}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {bookCell && (
        <BookingFormModal
          rooms={rooms}
          preselectedRoomId={bookCell.roomId}
          defaultCheckIn={bookCell.date}
          defaultCheckOut={addDays(bookCell.date, 1)}
          onClose={() => setBookCell(null)}
          onSaved={() => { setBookCell(null); load(); }}
        />
      )}
      {showNewBooking && (
        <BookingFormModal
          rooms={rooms}
          onClose={() => setShowNewBooking(false)}
          onSaved={() => { setShowNewBooking(false); load(); }}
        />
      )}
      {editingBooking && (
        <BookingFormModal
          rooms={rooms}
          booking={editingBooking}
          onClose={() => setEditingBooking(null)}
          onSaved={() => { setEditingBooking(null); openBookingDetail(editingBooking.id); load(); }}
        />
      )}
      {addRoomTarget && (
        <AddRoomToBookingModal
          group={addRoomTarget}
          rooms={rooms}
          onClose={() => setAddRoomTarget(null)}
          onSaved={() => { const id = addRoomTarget.primary.id; setAddRoomTarget(null); openBookingDetail(id); load(); }}
        />
      )}

      {/* Detail panel for whichever booking bar was just clicked — shown
          directly below the calendar so staff can see/act on a booking
          without leaving the calendar view. */}
      {selectedBooking && (
        <div className="room-cal-detail-panel">
          <div className="room-cal-detail-header">
            <h4>Booking Details</h4>
            <button type="button" className="modal-close" onClick={closeBookingDetail} aria-label="Close">✕</button>
          </div>
          {selectedLoading ? (
            <div className="empty-state small">Loading…</div>
          ) : (() => {
            const b = selectedBooking;
            const { total, advance, balanceDue } = bookingTotals(b);
            // For a group booking, "Total ... (all rooms)" must actually add
            // up every sibling room's own amount — bookingTotals() only
            // returns the currently-viewed room's share, which previously
            // got mislabeled "(all rooms)" and showed the wrong (too-small)
            // figure. Sum allocateGroupAdvance's per-room results instead.
            const groupTotals = b.groupRooms?.length
              ? allocateGroupAdvance([b, ...b.groupRooms]).reduce(
                  (acc, a) => ({
                    total: acc.total + a.total,
                    advance: acc.advance + a.advance,
                    balanceDue: acc.balanceDue + a.balanceDue,
                  }),
                  { total: 0, advance: 0, balanceDue: 0 }
                )
              : null;
            const roomSummary = b.groupRooms?.length
              ? `${b.groupRooms.length + 1} rooms: ${[b.roomNumber, ...b.groupRooms.map((r) => r.roomNumber)].join(', ')}`
              : `Room ${b.roomNumber}${b.roomType ? ` (${b.roomType})` : ''}`;
            return (
              // Same collapsed-card format as the Bookings tab's mobile
              // list (guest name / room summary / status badge + chevron)
              // — tapping the summary reveals the info fields and the
              // editable action buttons below, instead of always showing
              // everything expanded.
              <div className={`booking-card room-cal-booking-card ${detailExpanded ? 'expanded' : ''}`}>
                <button type="button" className="booking-card-summary" onClick={() => setDetailExpanded((x) => !x)}>
                  <div className="booking-card-main">
                    <span className="booking-card-guest">{b.bookingNumber}</span>
                    <span className="booking-card-room">{b.guestName || 'Guest'} · {roomSummary}</span>
                  </div>
                  <div className="booking-card-right">
                    <span className={`status-badge ${STATUS_BADGE_CLASS[b.status] || ''}`}>{(b.status || '').replace('_', ' ')}</span>
                    <span className="booking-card-arrow">›</span>
                  </div>
                </button>

                {b.groupRooms?.length > 0 && (() => {
                  // Per-room cost preview using the same allocateGroupAdvance
                  // math used for the overall totals below, so each room's
                  // own share of the group's booking is visible at a glance
                  // (previously this only listed the room + guest + status,
                  // which made "how much did MY 2 rooms actually cost" a
                  // manual, error-prone add-it-up-yourself exercise).
                  const siblings = [b, ...b.groupRooms];
                  const allocated = allocateGroupAdvance(siblings);
                  const rows = allocated
                    .map((a) => ({ ...a.room, current: a.room.id === b.id, roomAmount: a.total }))
                    .sort((x, y) => (x.roomNumber || '').localeCompare(y.roomNumber || ''));
                  return (
                    <div className="room-cal-group-banner">
                      <span className="room-cal-group-banner-title">👥 Group Booking — {b.groupRooms.length + 1} Rooms<InfoTip text="This reservation covers multiple rooms for the same guest, booked together. The amount shown per room below is that room's own share of the total." /></span>
                      <div className="room-cal-group-banner-list">
                        {rows.map((room) => (
                          <div key={room.id} className={`room-cal-group-banner-row ${room.current ? 'is-current' : ''}`}>
                            <span className="room-cal-group-banner-room">Room {room.roomNumber}{room.roomType ? ` (${room.roomType})` : ''}{room.current ? ' — viewing' : ''}</span>
                            <span className={`status-badge ${STATUS_BADGE_CLASS[room.status] || ''}`}>{(room.status || '').replace('_', ' ')}</span>
                            <span className="room-cal-group-banner-amount">{formatCurrency(room.roomAmount)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {detailExpanded && (
                  <div className="booking-card-details">
                    <div className="booking-card-row"><span>{groupTotals ? 'Total Amount (all rooms)' : 'Amount'}</span><span>{formatCurrency(groupTotals ? groupTotals.total : total)}</span></div>
                    <div className="booking-card-row"><span>{groupTotals ? 'Total Advance Received (all rooms)' : 'Advance Received'}</span><span>{formatCurrency(groupTotals ? groupTotals.advance : advance)}</span></div>
                    {b.status !== 'CHECKED_OUT' && b.status !== 'CANCELLED' && (
                      <div className="booking-card-row"><span>{groupTotals ? 'Total Balance Due (all rooms)' : 'Balance Due'}</span><strong>{formatCurrency(groupTotals ? groupTotals.balanceDue : balanceDue)}</strong></div>
                    )}
                    {b.status === 'CANCELLED' && b.refundAmount != null && (
                      <div className="booking-card-row">
                        <span>Refund</span>
                        {b.refundAmount > 0 ? <strong>{formatCurrency(b.refundAmount)}</strong> : <span>Not refunded</span>}
                      </div>
                    )}

                    {actionError && <p className="form-error">{actionError}</p>}

                    {!checkoutMode && !cancelMode && (
                      <div className="fm-row-actions room-cal-detail-actions">
                        {(b.status === 'BOOKED' || b.status === 'CHECKED_IN') && (
                          <button type="button" className="btn-link" disabled={actionBusy} onClick={() => setEditingBooking(b)}>Edit</button>
                        )}
                        {b.status === 'BOOKED' && (() => {
                          const isFuture = (b.checkInDate || '').slice(0, 10) > new Date().toLocaleDateString('en-CA');
                          return (
                            <button
                              type="button"
                              className="btn-link"
                              disabled={actionBusy || isFuture}
                              title={isFuture ? `Check-in date is ${fmtShort(dateOnly(b.checkInDate))} — not checkable in yet` : undefined}
                              onClick={handleCheckIn}
                            >
                              Check In
                            </button>
                          );
                        })()}
                        {b.status === 'CHECKED_IN' && (
                          <button type="button" className="btn-link" disabled={actionBusy} onClick={() => setCheckoutMode(true)}>Check Out</button>
                        )}
                        {(b.status === 'BOOKED' || b.status === 'CHECKED_IN') && (
                          <button
                            type="button"
                            className="btn-link"
                            disabled={actionBusy}
                            onClick={() => setAddRoomTarget({
                              key: b.bookingGroupId,
                              rooms: [{ roomId: b.roomId }, ...(b.groupRooms || [])],
                              primary: b,
                            })}
                          >
                            + Add Room
                          </button>
                        )}
                        {(b.status === 'BOOKED' || b.status === 'CHECKED_IN') && (
                          <button
                            type="button"
                            className="btn-link danger"
                            disabled={actionBusy}
                            onClick={() => {
                              setCancelReason('');
                              setCancelRefund(b.advancePayment > 0 ? String(b.advancePayment) : '0');
                              setCancelRefundMethod(b.advancePaymentMethod || 'CASH');
                              setCancelMode(true);
                            }}
                          >
                            Cancel
                          </button>
                        )}
                        {b.status === 'CHECKED_OUT' && b.billId && (
                          <button type="button" className="btn-link" onClick={() => window.api.openBillWindow(b.billId)}>View Invoice</button>
                        )}
                      </div>
                    )}

                    {checkoutMode && (
                      <div className="room-cal-detail-inline-form">
                        <label>
                          Payment Method
                          <select value={checkoutPaymentMethod} onChange={(e) => setCheckoutPaymentMethod(e.target.value)}>
                            <option value="CASH">Cash</option>
                            <option value="ONLINE">Online</option>
                          </select>
                        </label>
                        <div className="modal-actions">
                          <button type="button" className="btn btn-secondary" disabled={actionBusy} onClick={() => setCheckoutMode(false)}>Back</button>
                          <button type="button" className="btn btn-primary" disabled={actionBusy} onClick={confirmCheckout}>Confirm Check Out</button>
                        </div>
                      </div>
                    )}

                    {cancelMode && (
                      <div className="room-cal-detail-inline-form">
                        <label>
                          Reason (optional)
                          <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="e.g. Guest requested cancellation" />
                        </label>
                        {b.advancePayment > 0 && (
                          <>
                            <p className="settings-sub" style={{ margin: '0' }}>
                              Advance already collected: <strong>{formatCurrency(b.advancePayment)}</strong>. How much is being refunded?
                            </p>
                            <label>
                              Refund Amount (₹) — 0 keeps it as a cancellation fee
                              <input
                                type="number"
                                min="0"
                                max={b.advancePayment}
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
                        <div className="modal-actions">
                          <button type="button" className="btn btn-secondary" disabled={actionBusy} onClick={() => setCancelMode(false)}>Back</button>
                          <button type="button" className="btn btn-danger" disabled={actionBusy} onClick={confirmCancel}>Confirm Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
