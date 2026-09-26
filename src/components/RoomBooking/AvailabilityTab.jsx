import React from 'react';
import RoomCalendarView from './RoomCalendarView';

// "Check Room Availability" is now the Booking Calendar directly — a
// tape-chart of all rooms with their current/future bookings, week/month
// views, and click-to-book on any free date. The older plain list-of-cards
// view was removed in favor of this single, richer view.
export default function AvailabilityTab() {
  return (
    <div className="room-availability-page">
      <RoomCalendarView />
    </div>
  );
}
