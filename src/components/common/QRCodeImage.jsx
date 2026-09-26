import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// Renders a QR code image for any text value (used for UPI payment links).
// Generated fully offline on-device via the 'qrcode' library - no network/API calls.
export default function QRCodeImage({ value, size = 160 }) {
  const [dataUrl, setDataUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    if (!value) {
      setDataUrl(null);
      return;
    }
    setDataUrl(null);
    QRCode.toDataURL(value, { width: size, margin: 1 })
      .then((url) => { if (!cancelled) setDataUrl(url); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [value, size]);

  // `data-qr-state` lets the Electron main process (see captureBillImage in
  // electron/main.cjs) poll the DOM and know exactly when it's safe to
  // screenshot this bill window for WhatsApp — 'ready'/'failed'/'none' are
  // all terminal (capture can proceed), only 'loading' means "keep waiting".
  // Without this, a fixed short delay could screenshot the "Generating QR…"
  // placeholder text instead of the real QR code.
  if (!value) return <div data-qr-state="none" style={{ display: 'none' }} />;
  if (failed) {
    // Generation genuinely failed (e.g. invalid UPI URI) — never block/fail
    // the whole bill capture over a missing QR; just omit it.
    return <div className="qr-loading" data-qr-state="failed" style={{ width: size, height: size }}>QR unavailable</div>;
  }
  if (!dataUrl) return <div className="qr-loading" data-qr-state="loading" style={{ width: size, height: size }}>Generating QR…</div>;

  return <img className="qr-code-img" data-qr-state="ready" src={dataUrl} width={size} height={size} alt="UPI payment QR code" />;
}
