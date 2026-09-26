// Shared period → {from, to} date-range calculator used by both the
// Reporting page (Sales History) and the Room Bookings tab, so "Today /
// Weekly / Monthly / Annually / All Time / Custom Range" mean exactly the
// same thing everywhere in the app.
export function periodToRange(period) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  switch (period) {
    case 'today':
      return { from: iso(now), to: iso(now) };
    case 'week': {
      const start = new Date(now);
      start.setDate(start.getDate() - 6);
      return { from: iso(start), to: iso(now) };
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { from: iso(start), to: iso(end) };
    }
    case 'year': {
      const start = new Date(now.getFullYear(), 0, 1);
      const end = new Date(now.getFullYear(), 11, 31);
      return { from: iso(start), to: iso(end) };
    }
    default:
      return { from: undefined, to: undefined }; // 'all'
  }
}

export function todayStr() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
}
