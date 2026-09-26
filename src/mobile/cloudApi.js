import { Capacitor } from '@capacitor/core';

function plugin() {
  if (typeof Capacitor === 'undefined' || !Capacitor.isNativePlatform()) return null;
  return window.Capacitor?.Plugins?.MobileHost || null;
}

export function getCloudApiStatus() {
  return plugin()?.getCloudApiStatus?.() || Promise.resolve({ configured: false, supported: false });
}

export function configureCloudApi(accessToken, phoneNumberId) {
  const p = plugin();
  if (!p?.configureCloudApi) return Promise.reject(new Error('Cloud API secure storage is available only on Android.'));
  return p.configureCloudApi({ accessToken, phoneNumberId });
}

export function clearCloudApi() {
  return plugin()?.clearCloudApi?.() || Promise.resolve({ ok: false });
}

export function sendCloudText(to, body, options = {}) {
  const p = plugin();
  if (!p?.sendCloudText) return Promise.reject(new Error('WhatsApp Cloud API is not configured on this Android host.'));
  return p.sendCloudText({ to, body, ...options });
}

export function createInvoicePdf(bill) {
  const p = plugin();
  if (!p?.createInvoicePdf) return Promise.reject(new Error('Android invoice PDF generation is unavailable.'));
  return p.createInvoicePdf({ bill: JSON.stringify(bill) });
}

export function sendCloudPdf(to, pdfBase64, fileName, caption, options = {}) {
  const p = plugin();
  if (!p?.sendCloudPdf) return Promise.reject(new Error('WhatsApp Cloud API PDF sending is available only on the Android host.'));
  return p.sendCloudPdf({ to, pdfBase64, fileName, caption, ...options });
}
