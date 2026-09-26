// Swiggy Order Manager adapter — same POLLING model as Zomato's adapter.
//
// ⚠️ PLACEHOLDER ENDPOINTS: real base URL / auth / field names come from
// Swiggy's partner API docs once approved (https://partner.swiggy.com).
// Update BASE_URL + the "REPLACE ME" mappings below when you have them —
// nothing else needs to change.

const BASE_URL = 'https://partner-api.swiggy.com/v1'; // REPLACE ME with real base URL from docs

async function fetchNewOrders({ apiKey, partnerId }) {
  try {
    const res = await fetch(`${BASE_URL}/restaurants/${partnerId}/orders?status=new`, {
      headers: { Authorization: `Bearer ${apiKey}` }, // REPLACE ME with real auth scheme
    });
    if (!res.ok) return [];
    const data = await res.json();
    // REPLACE ME: map Swiggy's real response shape to this normalized shape.
    return (data.orders || []).map((o) => ({
      externalId: o.order_id,
      platform: 'SWIGGY',
      kind: 'FOOD_ORDER',
      customerName: o.customer_name,
      customerPhone: o.customer_phone,
      items: (o.items || []).map((it) => ({ name: it.name, price: it.price, quantity: it.quantity })),
      total: o.total_amount,
      raw: o,
    }));
  } catch {
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

module.exports = { platform: 'SWIGGY', fetchNewOrders, acceptOrder, rejectOrder };
