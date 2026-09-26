# BillNest shared messaging backend

This small Node 18+ HTTP service is the recommended shared seam for Electron and Android hosts. It keeps Meta Cloud API credentials on the server and does not alter the existing Baileys or direct Cloud modes.

## Setup

1. Copy `.env.example` to a secret environment configuration (do not commit it).
2. Generate a client key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and put it in `BILLNEST_API_KEYS` as JSON, for example `{"<key>":"tenant-a"}`.
3. Set `META_ACCESS_TOKEN` and `META_PHONE_NUMBER_ID` only in the backend environment. Never put a Meta token in an APK, Electron bundle, logs, or client requests.
4. Run `npm run backend:start`. Use `npm run backend:dry-run` for local tests; dry-run never calls Meta.

`GET /health` and `GET /health/config` expose only non-secret readiness/configuration facts. `POST /v1/messages/send` requires `X-API-Key` and JSON. Body shape:

```json
{"to":"919876543210","text":"Your invoice is ready","caption":"Invoice","document":{"filename":"invoice.pdf","mimeType":"application/pdf","dataBase64":"..."}}
```

Send either `text` or `document`; a document is uploaded to Meta and sent with `caption`. Use `Idempotency-Key` (8–200 safe characters) to make retries return the original result instead of sending twice. The default request limit is 8 MiB.

## Client seam

Import `backend/client.mjs` from a Node/Electron host, or mirror its HTTPS request from Android:

```js
import { sendBillNestMessage } from './backend/client.mjs';
await sendBillNestMessage({ baseUrl, apiKey, to, text, idempotencyKey: checkoutId });
```

Deploy behind HTTPS/reverse proxy with rate limiting, firewall the service, rotate keys, and use a persistent idempotency store for multi-instance production deployments. This foundation intentionally has no tenant database, queue, webhook handling, token refresh, or Baileys integration.
