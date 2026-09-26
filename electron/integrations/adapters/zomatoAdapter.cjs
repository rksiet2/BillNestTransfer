// Zomato Order Manager adapter — POLLING model (BillNest asks Zomato for new
// orders every few seconds; nothing needs to reach into this PC from outside).
//
// ⚠️ PLACEHOLDER ENDPOINTS: Zomato's actual partner API base URL, auth header
// name, and response field names are only visible once you're approved into
// their POS/Order Manager partner program (https://www.zomato.com/business/order-manager).
// When you get their real API docs, update BASE_URL + the field mappings
// below (marked with "REPLACE ME") — the polling engine, notifications,
// bill creation and UI around this adapter do NOT need to change.

const BASE_URL = 'https://api.zomato.com/order-manager/v1'; // REPLACE ME with real base URL from docs

async function fetchNewOrders({ apiKey, partnerId }) {
  try {
    const res = await fetch(`${BASE_URL}/restaurants/${partnerId}/orders?status=new`, {
      headers: { Authorization: `Bearer ${apiKey}` }, // REPLACE ME with real auth scheme
    });
    if (!res.ok) return [];
    const data = await res.json();
    // REPLACE ME: map Zomato's real response shape to this normalized shape.
    return (data.orders || []).map((o) => ({
      externalId: o.order_id,
      platform: 'ZOMATO',
      kind: 'FOOD_ORDER',
      customerName: o.customer_name,
      customerPhone: o.customer_phone,
      items: (o.items || []).map((it) => ({ name: it.name, price: it.price, quantity: it.quantity })),
      total: o.total_amount,
      raw: o,
    }));
  } catch {
    // Network/auth errors are expected until real credentials + endpoint exist —
    // fail quietly so the polling loop just tries again next interval.
    return [];
  }
}

async function acceptOrder({ apiKey, partnerId }, externalId) {
  try {
    const res = await fetch(`${BASE_URL}/restaurants/${partnerId}/orders/${externalId}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function rejectOrder({ apiKey, partnerId }, externalId, reason) {
  try {
    const res = await fetch(`${BASE_URL}/restaurants/${partnerId}/orders/${externalId}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || 'Unavailable' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { platform: 'ZOMATO', fetchNewOrders, acceptOrder, rejectOrder };
