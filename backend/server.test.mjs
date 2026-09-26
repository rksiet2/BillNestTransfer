import test from 'node:test';
import assert from 'node:assert/strict';
import { createBillNestServer } from './server.mjs';

test('dry-run authenticates and replays idempotent requests without Meta', async (t) => {
  const apiKey = 'a'.repeat(32);
  const server = createBillNestServer({
    env: { BILLNEST_API_KEYS: JSON.stringify({ [apiKey]: 'tenant-a' }), BILLNEST_DRY_RUN: 'true' },
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/v1/messages/send`;
  const request = () => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'idempotency-key': 'checkout-123' },
    body: JSON.stringify({ to: '919876543210', text: 'Invoice ready' }),
  });
  const first = await request();
  assert.equal(first.status, 202);
  const second = await request();
  assert.equal(second.status, 200);
  assert.equal((await second.json()).idempotentReplay, true);

  const config = await fetch(`http://127.0.0.1:${server.address().port}/health/config`);
  const configBody = await config.json();
  assert.equal(config.status, 200);
  assert.equal(configBody.metaConfigured, false);
  assert.equal('metaAccessToken' in configBody, false);
});
