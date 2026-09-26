// Official WhatsApp Cloud API sender.
// Credentials are kept in the Electron main process. Desktop credentials are
// encrypted with Electron safeStorage; environment variables remain supported
// for unattended deployments and backwards compatibility.
const fs = require('fs');
const path = require('path');
const GRAPH_VERSION = process.env.WHATSAPP_CLOUD_API_VERSION || 'v23.0';
let storedCredentials = null;

function readStoredCredentials() {
  if (storedCredentials) return storedCredentials;
  try {
    const { app, safeStorage } = require('electron');
    const file = path.join(app.getPath('userData'), 'whatsapp-cloud-credentials.enc');
    if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return null;
    storedCredentials = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
    return storedCredentials;
  } catch {
    return null;
  }
}

function configuration() {
  const stored = readStoredCredentials() || {};
  return {
    accessToken: stored.accessToken || process.env.WHATSAPP_CLOUD_ACCESS_TOKEN || '',
    phoneNumberId: stored.phoneNumberId || process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID || '',
    businessName: process.env.WHATSAPP_CLOUD_BUSINESS_NAME || 'BillNest',
    templateName: process.env.WHATSAPP_CLOUD_TEMPLATE_NAME || '',
    templateLanguage: process.env.WHATSAPP_CLOUD_TEMPLATE_LANGUAGE || 'en_US',
  };
}

function configure(accessToken, phoneNumberId) {
  if (!accessToken || !phoneNumberId) throw new Error('Access token and phone number ID are required.');
  const { app, safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows secure credential storage is unavailable. Use environment variables instead.');
  }
  const file = path.join(app.getPath('userData'), 'whatsapp-cloud-credentials.enc');
  fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify({ accessToken, phoneNumberId })));
  storedCredentials = { accessToken, phoneNumberId };
  return { configured: true, phoneNumberId };
}

function clearCredentials() {
  try {
    const { app } = require('electron');
    const file = path.join(app.getPath('userData'), 'whatsapp-cloud-credentials.enc');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } finally {
    storedCredentials = null;
  }
  return { configured: isConfigured() };
}

function getStatus() {
  const config = configuration();
  return { configured: Boolean(config.accessToken && config.phoneNumberId), phoneNumberId: config.phoneNumberId || '' };
}

function isConfigured() {
  const config = configuration();
  return Boolean(config.accessToken && config.phoneNumberId);
}

function normalizePhone(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.length === 10 ? `91${digits}` : digits;
}

async function graphRequest(path, init) {
  const config = configuration();
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      ...(init?.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `WhatsApp Cloud API request failed (${response.status}).`);
  }
  return body;
}

function templatePayload(to, templateName, templateLanguage, parameters) {
  const components = parameters?.length
    ? [{ type: 'body', parameters: parameters.map((text) => ({ type: 'text', text: String(text ?? '') })) }]
    : undefined;
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLanguage || 'en_US' },
      ...(components ? { components } : {}),
    },
  };
}

async function sendText(rawPhone, text, options = {}) {
  const to = normalizePhone(rawPhone);
  if (!to) throw new Error('No phone number provided.');
  if (!isConfigured()) throw new Error('WhatsApp Cloud API is not configured on this computer.');
  const config = configuration();
  const templateName = options.templateName || config.templateName;
  const payload = templateName
    ? templatePayload(to, templateName, options.templateLanguage || config.templateLanguage, options.templateParams || [text])
    : {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: true, body: String(text || '') },
    };
  return graphRequest(`${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function sendPdf(rawPhone, pdfBuffer, fileName, caption) {
  const to = normalizePhone(rawPhone);
  if (!to) throw new Error('No phone number provided.');
  if (!isConfigured()) throw new Error('WhatsApp Cloud API is not configured on this computer.');
  const config = configuration();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), fileName || 'Invoice.pdf');
  const upload = await graphRequest(`${config.phoneNumberId}/media`, { method: 'POST', body: form });
  return graphRequest(`${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'document',
      document: { id: upload.id, caption: String(caption || ''), filename: fileName || 'Invoice.pdf' },
    }),
  });
}

// Parses Meta's standard status webhook without pretending this local app is a
// public webhook receiver. A hosted/public endpoint is still required to call it.
function parseWebhookStatuses(payload) {
  const statuses = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      for (const status of change.value?.statuses || []) {
        if (status.id && status.status) {
          statuses.push({
            messageId: status.id,
            status: String(status.status).toUpperCase(),
            recipientId: status.recipient_id || null,
            timestamp: status.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : null,
            error: status.errors?.[0]?.title || status.errors?.[0]?.message || null,
          });
        }
      }
    }
  }
  return statuses;
}

module.exports = {
  configuration, isConfigured, getStatus, configure, clearCredentials, sendText, sendPdf, parseWebhookStatuses,
};
