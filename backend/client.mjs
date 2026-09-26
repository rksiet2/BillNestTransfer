export async function sendBillNestMessage({
  baseUrl,
  apiKey,
  to,
  text,
  document,
  caption,
  idempotencyKey,
  signal,
}) {
  if (!baseUrl || !apiKey) throw new Error('baseUrl and apiKey are required');
  const response = await fetch(new URL('/v1/messages/send', baseUrl), {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify({ to, text, document, caption }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Messaging backend returned ${response.status}`);
  return payload;
}
