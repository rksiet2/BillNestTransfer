// Live-data "intents" the offline Assistant can answer using the app's own
// data (via the same window.api the rest of the UI uses) instead of static
// text from the knowledge base. Each intent has keywords for matching plus
// an async handler(api) that returns the answer string. `api` is passed in
// explicitly (rather than importing window.api directly) so this module can
// be unit-tested in plain Node with a mock object.
import { extractKeywords } from './kbParser.js';

function money(n) {
  const value = Number(n) || 0;
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function revenueFor(api, period, label) {
  const s = await api.getSummary(period);
  return `${label} revenue is ${money(s.revenue)} from ${s.orderCount || 0} bill(s) — ${money(s.cashRevenue)} cash and ${money(s.onlineRevenue)} online. (${s.cancelledCount || 0} cancelled bill(s) excluded.)`;
}

async function profitLossFor(api, period, label) {
  const p = await api.getProfitLoss(period);
  return `${label}: Revenue ${money(p.revenue)} − Purchases ${money(p.totalPurchases)} − Expenses ${money(p.totalExpenses)} = Net Profit ${money(p.netProfit)}.`;
}

export const liveDataIntents = [
  {
    id: 'revenue-today',
    keywords: ['today', 'revenue', 'sales', 'earning', 'earnings', 'income'],
    handler: (api) => revenueFor(api, 'today', "Today's"),
  },
  {
    id: 'revenue-week',
    keywords: ['week', 'weekly', 'revenue', 'sales', 'earning', 'earnings', 'income'],
    handler: (api) => revenueFor(api, 'week', "This week's"),
  },
  {
    id: 'revenue-month',
    keywords: ['month', 'monthly', 'revenue', 'sales', 'earning', 'earnings', 'income'],
    handler: (api) => revenueFor(api, 'month', "This month's"),
  },
  {
    id: 'revenue-year',
    keywords: ['year', 'yearly', 'annual', 'revenue', 'sales', 'earning', 'earnings', 'income'],
    handler: (api) => revenueFor(api, 'year', "This year's"),
  },
  {
    id: 'profit-loss-today',
    keywords: ['today', 'profit', 'loss', 'net'],
    handler: (api) => profitLossFor(api, 'today', 'Today'),
  },
  {
    id: 'profit-loss-month',
    keywords: ['month', 'monthly', 'profit', 'loss', 'net'],
    handler: (api) => profitLossFor(api, 'month', 'This month'),
  },
  {
    id: 'rooms-available',
    keywords: ['rooms', 'room', 'available', 'free', 'vacant', 'empty'],
    handler: async (api) => {
      const rooms = await api.getRoomAvailability({});
      const free = rooms.filter((r) => r.isAvailable);
      if (!free.length) return 'No rooms are currently available — every room is occupied, reserved, or under maintenance.';
      return `${free.length} room(s) currently available: ${free.map((r) => r.room_number).join(', ')}.`;
    },
  },
  {
    id: 'rooms-occupied',
    keywords: ['rooms', 'room', 'occupied', 'checked', 'guests', 'staying'],
    handler: async (api) => {
      const rooms = await api.getRoomAvailability({});
      const occupied = rooms.filter((r) => r.todayStatus === 'OCCUPIED');
      if (!occupied.length) return 'No rooms are currently occupied.';
      return `${occupied.length} room(s) currently occupied: ${occupied.map((r) => `${r.room_number}${r.guestName ? ` (${r.guestName})` : ''}`).join(', ')}.`;
    },
  },
  {
    id: 'bookings-pending',
    keywords: ['bookings', 'booking', 'pending', 'upcoming', 'arriving', 'booked'],
    handler: async (api) => {
      const list = await api.listBookings({ status: 'BOOKED' });
      if (!list.length) return 'There are no pending (Booked, not yet checked-in) bookings right now.';
      return `${list.length} booking(s) awaiting check-in: ${list.map((b) => `${b.bookingNumber} — Room ${b.roomNumber}, ${b.guestName}`).join('; ')}.`;
    },
  },
];

// Scores every live-data intent against the user's question using the same
// keyword-overlap approach as the static KB, so both kinds of answers are
// compared on equal footing by the engine.
export function scoreIntent(inputKeywords, intent) {
  const inputSet = new Set(inputKeywords);
  const overlap = intent.keywords.filter((k) => inputSet.has(k)).length;
  if (!overlap) return 0;
  return overlap / Math.max(intent.keywords.length, inputKeywords.length);
}

export function extractInputKeywords(text) {
  return extractKeywords(text);
}
