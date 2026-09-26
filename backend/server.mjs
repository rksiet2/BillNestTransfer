import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function envBoolean(value) {
  return value === '1' || value?.toLowerCase() === 'true';
}

function loadConfig(env = process.env) {
  let apiKeys = {};
  try {
    apiKeys = JSON.parse(env.BILLNEST_API_KEYS || '{}');
  } catch {
    throw new Error('BILLNEST_API_KEYS must be valid JSON');
  }
  if (!apiKeys || typeof apiKeys !== 'object' || Array.isArray(apiKeys)) {
    throw new Error('BILLNEST_API_KEYS must be a JSON object');
  }
  const maxBodyBytes = Number(env.BILLNEST_MAX_BODY_BYTES || DEFAULT_MAX_BODY_BYTES);
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 50 * 1024 * 1024) {
    throw new Error('BILLNEST_MAX_BODY_BYTES must be between 1024 and 52428800');
  }
  return {
    apiKeys,
    maxBodyBytes,
    dryRun: envBoolean(env.BILLNEST_DRY_RUN),
    metaConfigured: Boolean(env.META_ACCESS_TOKEN && env.META_PHONE_NUMBER_ID),
    metaAccessToken: env.META_ACCESS_TOKEN,
    metaPhoneNumberId: env.META_PHONE_NUMBER_ID,
    metaApiVersion: env.META_API_VERSION || 'v21.0',
  };
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseApiKeys(raw) {
  return Object.entries(raw).filter(([key, tenant]) =>
    key.length >= 32 && typeof tenant === 'string' && tenant.length > 0
  );
}

async function readJson(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) throw Object.assign(new Error('Request body too large'), { status: 413 });
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Body must be valid JSON'), { status: 400 });
  }
}

function validateMessage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON object required');
  const rawTo = String(body.to || '');
  if (!/^[\d\s+().-]+$/.test(rawTo)) throw new Error('to must be an international phone number');
  const to = rawTo.replace(/[^\d]/g, '');
  if (!/^\d{8,15}$/.test(to)) throw new Error('to must be an international phone number');
  const hasText = typeof body.text === 'string' && body.text.length > 0;
  const document = body.document;
  const hasDocument = document && typeof document === 'object' &&
    typeof document.dataBase64 === 'string' && document.dataBase64.length > 0;
  if (hasText && hasDocument) throw new Error('Send either text or document, not both');
  if (!hasText && !hasDocument) throw new Error('text or document.dataBase64 is required');
  if (hasText && body.text.length > 4096) throw new Error('text is too long');
  if (hasDocument) {
    if (document.dataBase64.length > 7 * 1024 * 1024 * 4 / 3) throw new Error('document is too large');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(document.dataBase64)) throw new Error('document.dataBase64 is invalid');
    if (!/^[\w.-]{1,120}\.(pdf|png|jpg|jpeg)$/i.test(String(document.filename || 'invoice.pdf'))) {
      throw new Error('document.filename is invalid');
    }
  }
  const caption = body.caption == null ? '' : String(body.caption);
  if (caption.length > 4096) throw new Error('caption is too long');
  return {
    to,
    text: hasText ? body.text : undefined,
    caption,
    document: hasDocument ? {
      filename: String(document.filename || 'invoice.pdf'),
      mimeType: String(document.mimeType || 'application/pdf'),
      dataBase64: document.dataBase64,
    } : undefined,
  };
}

async function metaRequest(config, path, options) {
  const response = await fetch(`https://graph.facebook.com/${config.metaApiVersion}/${path}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Meta API request failed (${response.status})`);
  return payload;
}

async function sendToMeta(config, message) {
  const base = { Authorization: `Bearer ${config.metaAccessToken}` };
  if (message.document) {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('file', new Blob([Buffer.from(message.document.dataBase64, 'base64')], { type: message.document.mimeType }));
    const media = await metaRequest(config, `${config.metaPhoneNumberId}/media`, { method: 'POST', headers: base, body: form });
    const payload = {
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'document',
      document: { id: media.id, filename: message.document.filename, caption: message.caption },
    };
    return metaRequest(config, `${config.metaPhoneNumberId}/messages`, {
      method: 'POST',
      headers: { ...base, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
  return metaRequest(config, `${config.metaPhoneNumberId}/messages`, {
    method: 'POST',
    headers: { ...base, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: message.to, type: 'text', text: { body: message.text } }),
  });
}

export function createBillNestServer({ env = process.env } = {}) {
  const config = loadConfig(env);
  const keys = parseApiKeys(config.apiKeys);
  const idempotency = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, service: 'billnest-messaging', dryRun: config.dryRun });
      }
      if (req.method === 'GET' && url.pathname === '/health/config') {
        return json(res, 200, {
          ok: true,
          metaConfigured: config.metaConfigured,
          dryRun: config.dryRun,
          apiKeyCount: keys.length,
          maxBodyBytes: config.maxBodyBytes,
        });
      }
      if (req.method !== 'POST' || url.pathname !== '/v1/messages/send') return json(res, 404, { error: 'Not found' });
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        return json(res, 415, { error: 'Content-Type must be application/json' });
      }
      const supplied = req.headers['x-api-key'];
      const entry = keys.find(([key]) => supplied && safeEqual(key, supplied));
      if (!entry) return json(res, 401, { error: 'Unauthorized' });
      const body = validateMessage(await readJson(req, config.maxBodyBytes));
      const idempotencyKey = req.headers['idempotency-key'];
      if (idempotencyKey && !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) return json(res, 400, { error: 'Invalid Idempotency-Key' });
      const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      if (idempotencyKey) {
        const prior = idempotency.get(`${entry[1]}:${idempotencyKey}`);
        if (prior && prior.expiresAt > Date.now()) {
          if (prior.fingerprint !== fingerprint) return json(res, 409, { error: 'Idempotency key reused with different request' });
          return json(res, 200, { ...prior.result, idempotentReplay: true });
        }
      }
      if (!config.dryRun && !config.metaConfigured) return json(res, 503, { error: 'Meta Cloud API is not configured' });
      const result = config.dryRun
        ? { accepted: true, dryRun: true, messageType: body.document ? 'document' : 'text' }
        : { accepted: true, dryRun: false, meta: await sendToMeta(config, body) };
      if (idempotencyKey) {
        idempotency.set(`${entry[1]}:${idempotencyKey}`, { fingerprint, result, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
      }
      return json(res, 202, result);
    } catch (error) {
      const status = error.status || (error.message?.startsWith('Meta API request failed') ? 502 : 400);
      return json(res, status, { error: error.status === 413 ? error.message : (error.message || 'Request failed') });
    }
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createBillNestServer();
  const port = Number(process.env.PORT || 8787);
  server.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`BillNest messaging backend listening on ${process.env.HOST || '127.0.0.1'}:${port}`);
  });
}
