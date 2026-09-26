// Guided, multi-turn "create a booking via chat" flow for the offline
// Assistant. Unlike answerQuestion() (stateless, one question -> one
// answer), this is a small step-by-step state machine: the caller (the
// widget) keeps the returned `session` object and passes it back in on the
// next message until `done` is true. Every step is validated locally before
// moving on, and the final "confirm" step calls the real window.api.createBooking
// so it goes through all the same backend validation/atomicity as the normal
// booking form (room availability, maintenance checks, etc.).
export function isBookingRequest(text) {
  const t = (text || '').toLowerCase();
  return /\b(book|reserve|reservation)\b.*\b(room|hotel|stay)\b/.test(t)
    || /\bnew booking\b/.test(t)
    || /\bcreate\b.*\bbooking\b/.test(t)
    || /\bmake\b.*\breservation\b/.test(t);
}

export function createBookingSession() {
  return { step: 'guestName', data: {} };
}

function parseDateInput(text, fallbackTime) {
  const t = text.trim().toLowerCase();
  let d;
  if (t === 'today') {
    d = new Date();
  } else if (t === 'tomorrow') {
    d = new Date();
    d.setDate(d.getDate() + 1);
  } else {
    d = new Date(text.trim());
  }
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${fallbackTime}`;
}

// `session` — as returned by createBookingSession()/a previous call, or null
// to abort. `input` — the user's latest chat message. `api` — window.api (or
// a mock in tests).
export async function processBookingStep(session, input, api) {
  const text = (input || '').trim();
  const lower = text.toLowerCase();

  if (lower === 'cancel') {
    return { session: null, reply: 'Okay, I\'ve cancelled the new booking. Let me know if you want to start again.', done: true };
  }

  switch (session.step) {
    case 'guestName': {
      if (!text) return { session, reply: 'Please tell me the guest\'s name (or type "cancel" to stop).', done: false };
      return {
        session: { step: 'guestPhone', data: { ...session.data, guestName: text } },
        reply: `Got it — booking for ${text}. What's their contact number?`,
        done: false,
      };
    }

    case 'guestPhone': {
      if (!text) return { session, reply: 'Please enter a contact number (or type "cancel").', done: false };
      const rooms = (await api.listRooms()).filter((r) => r.status === 'ACTIVE');
      if (!rooms.length) {
        return { session: null, reply: 'There are no active rooms set up yet, so I can\'t create a booking. Add a room first under Room Booking → Rooms.', done: true };
      }
      const list = rooms.map((r) => `${r.room_number} (${r.room_type}, ₹${r.base_price}/night)`).join(', ');
      return {
        session: { step: 'room', data: { ...session.data, guestPhone: text }, rooms },
        reply: `Which room would you like to book? Available: ${list}`,
        done: false,
      };
    }

    case 'room': {
      const rooms = session.rooms || [];
      const match = rooms.find((r) => r.room_number.toLowerCase() === lower || String(r.id) === text);
      if (!match) {
        return { session, reply: `I couldn't find a room called "${text}". Please type the exact room number from the list, or "cancel".`, done: false };
      }
      return {
        session: { step: 'checkIn', data: { ...session.data, roomId: match.id, roomNumber: match.room_number, roomRate: match.base_price }, rooms },
        reply: `Room ${match.room_number} it is. What's the check-in date? (e.g. 2026-09-10, "today", or "tomorrow")`,
        done: false,
      };
    }

    case 'checkIn': {
      const parsed = parseDateInput(text, '14:00');
      if (!parsed) return { session, reply: 'I didn\'t understand that date — please use YYYY-MM-DD, "today", or "tomorrow".', done: false };
      return {
        session: { ...session, step: 'checkOut', data: { ...session.data, checkInDate: parsed } },
        reply: 'And the check-out date?',
        done: false,
      };
    }

    case 'checkOut': {
      const parsed = parseDateInput(text, '11:00');
      if (!parsed) return { session, reply: 'I didn\'t understand that date — please use YYYY-MM-DD, "today", or "tomorrow".', done: false };
      if (parsed <= session.data.checkInDate) {
        return { session, reply: 'Check-out must be after check-in — please enter a later date.', done: false };
      }
      return {
        session: { ...session, step: 'paymentMethod', data: { ...session.data, checkOutDate: parsed } },
        reply: 'How will payment be made — Cash or Online?',
        done: false,
      };
    }

    case 'paymentMethod': {
      if (!/^(cash|online)$/i.test(text)) return { session, reply: 'Please reply "Cash" or "Online".', done: false };
      return {
        session: { ...session, step: 'advance', data: { ...session.data, paymentMethod: text.toUpperCase() } },
        reply: 'Any advance payment to record now? Enter an amount in ₹, or type "skip".',
        done: false,
      };
    }

    case 'advance': {
      let advance = 0;
      if (!/^skip$/i.test(text)) {
        const n = Number(text.replace(/[^0-9.]/g, ''));
        if (!Number.isFinite(n) || n < 0) return { session, reply: 'Please enter a valid amount, or type "skip".', done: false };
        advance = n;
      }
      const d = { ...session.data, advancePayment: advance };
      const summary = [
        'Please confirm these details:',
        `- Guest: ${d.guestName} (${d.guestPhone})`,
        `- Room: ${d.roomNumber}`,
        `- Check-in: ${d.checkInDate.replace('T', ' ')}`,
        `- Check-out: ${d.checkOutDate.replace('T', ' ')}`,
        `- Rate: ₹${d.roomRate}/night`,
        `- Payment: ${d.paymentMethod}`,
        advance ? `- Advance paid: ₹${advance}` : null,
        '',
        'Shall I create this booking? (yes/no)',
      ].filter(Boolean).join('\n');
      return { session: { step: 'confirm', data: d }, reply: summary, done: false };
    }

    case 'confirm': {
      if (/^(no|n)$/i.test(lower)) return { session: null, reply: 'Okay, I\'ve cancelled the new booking.', done: true };
      if (!/^(yes|y)$/i.test(lower)) return { session, reply: 'Please reply "yes" to confirm or "no" to cancel.', done: false };
      try {
        const d = session.data;
        const result = await api.createBooking({
          checkInDate: d.checkInDate,
          checkOutDate: d.checkOutDate,
          rooms: [{ roomId: d.roomId, roomRate: d.roomRate }],
          contacts: [{ name: d.guestName, phone: d.guestPhone }],
          paymentMethod: d.paymentMethod,
          advancePayment: d.advancePayment || 0,
        });
        const booking = Array.isArray(result) ? result[0] : result;
        return {
          session: null,
          reply: `✅ Booking created! Booking #${booking.bookingNumber} for Room ${booking.roomNumber}, status ${booking.status}.`,
          done: true,
        };
      } catch (err) {
        return {
          session,
          reply: `I couldn't create that booking: ${err.message}\nReply "yes" to try again once the issue is fixed elsewhere, or "no" to cancel.`,
          done: false,
        };
      }
    }

    default:
      return { session: null, reply: 'Something went wrong — let\'s start over. Say "book a room" to try again.', done: true };
  }
}
