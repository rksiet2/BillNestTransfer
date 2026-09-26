import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCurrency } from '../../utils/format';

function localDate(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dateOnly(value) {
  return String(value || '').slice(0, 10);
}

function statusLabel(status) {
  return String(status || '').replaceAll('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export default function Dashboard({ appModule, currentUser, settings, onNavigate }) {
  const [summary, setSummary] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [availability, setAvailability] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const today = useMemo(() => localDate(), []);
  const tomorrow = useMemo(() => localDate(1), []);
  const isRooms = appModule === 'rooms';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const requests = [
        window.api.getSummary({ period: 'today', source: isRooms ? 'ROOM' : 'FOOD' }),
      ];
      if (isRooms) {
        requests.push(
          window.api.listBookings({}),
          window.api.getRoomAvailability({ from: today, to: tomorrow })
        );
      }
      const [todaySummary, todayBookings = [], roomAvailability = []] = await Promise.all(requests);
      setSummary(todaySummary);
      setBookings(todayBookings);
      setAvailability(roomAvailability);
    } catch (err) {
      setError(err?.message || 'Unable to load today’s dashboard.');
    } finally {
      setLoading(false);
    }
  }, [isRooms, today, tomorrow]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  const roomCounts = useMemo(() => ({
    total: availability.length,
    active: availability.filter((room) => room.status === 'ACTIVE').length,
    available: availability.filter((room) => room.isAvailable).length,
    occupied: availability.filter((room) => room.isCheckedIn).length,
    reserved: availability.filter((room) => room.todayStatus === 'RESERVED').length,
    maintenance: availability.filter((room) => room.status === 'MAINTENANCE').length,
  }), [availability]);

  const roomBookings = useMemo(
    () => bookings
      .filter((booking) => !['CANCELLED'].includes(booking.status)
        && (dateOnly(booking.createdAt) === today
          || dateOnly(booking.checkInDate) === today
          || dateOnly(booking.checkOutDate) === today
          || dateOnly(booking.actualCheckIn) === today
          || dateOnly(booking.actualCheckOut) === today
          || (dateOnly(booking.checkInDate) < today && dateOnly(booking.checkOutDate) > today)))
      .sort((a, b) => String(b.createdAt || b.checkInDate || '').localeCompare(String(a.createdAt || a.checkInDate || '')))
      .slice(0, 8),
    [bookings, today]
  );
  const bookingCount = bookings.filter((booking) => dateOnly(booking.createdAt) === today).length;
  const checkInCount = bookings.filter((booking) => dateOnly(booking.actualCheckIn) === today).length;
  const checkOutCount = bookings.filter((booking) => dateOnly(booking.actualCheckOut) === today).length;
  const arrivalCount = bookings.filter((booking) => dateOnly(booking.checkInDate) === today && booking.status !== 'CANCELLED').length;
  const departureCount = new Set(
    bookings
      .filter((booking) => booking.status !== 'CANCELLED')
      .filter((booking) => dateOnly(booking.checkOutDate) === today || dateOnly(booking.actualCheckOut) === today)
      .map((booking) => booking.id)
  ).size;

  return (
    <div className="dashboard-page">
      <div className="dashboard-welcome">
        <div>
          <p className="dashboard-eyebrow">Today at a glance</p>
          <h2>{currentUser?.name ? `Welcome, ${currentUser.name}` : 'Welcome back'}</h2>
          <p className="dashboard-date">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>
        <button type="button" className="btn-secondary dashboard-refresh" onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && <div className="dashboard-error">{error}</div>}

      <div className="dashboard-actions">
        {isRooms ? (
          <>
            <button type="button" className="dashboard-action primary" onClick={() => onNavigate('room-bookings-new')}>＋ New booking</button>
            <button type="button" className="dashboard-action" onClick={() => onNavigate('room-availability')}>View room availability</button>
          </>
        ) : (
          <>
            <button type="button" className="dashboard-action primary" onClick={() => onNavigate('billing')}>＋ New food bill</button>
            {settings?.feature_table_management === 'true' && (
              <button type="button" className="dashboard-action" onClick={() => onNavigate('tables')}>Open tables</button>
            )}
          </>
        )}
      </div>

      {loading && !summary ? (
        <div className="dashboard-loading">Loading today’s information…</div>
      ) : (
        <>
          <div className="dashboard-metrics">
            <div className="dashboard-metric"><span>Today’s revenue</span><strong>{formatCurrency(Number(summary?.revenue || 0))}</strong><small>{summary?.orderCount || 0} completed {isRooms ? 'stay' : 'bill'}{summary?.orderCount === 1 ? '' : 's'}</small></div>
            {isRooms ? (
              <>
                <div className="dashboard-metric"><span>Rooms available</span><strong>{roomCounts.available}</strong><small>{roomCounts.total} total · {roomCounts.occupied} occupied · {roomCounts.reserved} reserved</small></div>
                <div className="dashboard-metric"><span>Today’s activity</span><strong>{bookingCount}</strong><small>{arrivalCount} arrivals · {checkInCount} checked in</small></div>
                <div className="dashboard-metric"><span>Departures</span><strong>{departureCount}</strong><small>{checkOutCount} checked out · {roomCounts.maintenance} maintenance</small></div>
              </>
            ) : (
              <>
                <div className="dashboard-metric"><span>Cash collected</span><strong>{formatCurrency(Number(summary?.cashRevenue || 0))}</strong><small>Today</small></div>
                <div className="dashboard-metric"><span>Online collected</span><strong>{formatCurrency(Number(summary?.onlineRevenue || 0))}</strong><small>Today</small></div>
                <div className="dashboard-metric"><span>Completed bills</span><strong>{summary?.orderCount || 0}</strong><small>{summary?.cancelledCount || 0} cancelled</small></div>
              </>
            )}
          </div>

          {isRooms && (
            <section className="dashboard-section">
              <div className="dashboard-section-heading"><h3>Today’s room activity</h3><button type="button" className="btn-link" onClick={() => onNavigate('room-bookings')}>View all</button></div>
              {roomBookings.length === 0 ? (
                <div className="dashboard-empty">No arrivals or active stays for today.</div>
              ) : (
                <div className="dashboard-booking-list">
                  {roomBookings.map((booking) => (
                    <button type="button" className="dashboard-booking-row" key={booking.id} onClick={() => onNavigate('room-bookings')}>
                      <span className="dashboard-booking-room">{booking.roomNumber || '—'}</span>
                      <span className="dashboard-booking-main"><strong>{booking.guestName || 'Guest'}</strong><small>{booking.bookingNumber || 'Booking'} · {booking.checkInDate?.slice(0, 10)} → {booking.checkOutDate?.slice(0, 10)}{booking.actualCheckIn ? ` · Checked in ${booking.actualCheckIn.slice(11, 16)}` : ''}{booking.actualCheckOut ? ` · Checked out ${booking.actualCheckOut.slice(11, 16)}` : ''}</small></span>
                      <span className={`dashboard-status ${String(booking.status || '').toLowerCase()}`}>{statusLabel(booking.status)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
