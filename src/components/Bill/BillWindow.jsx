import React, { useEffect, useState } from 'react';
import { formatCurrency, formatDate, splitGst } from '../../utils/format';
import { buildUpiUri } from '../../utils/upi';
import QRCodeImage from '../common/QRCodeImage';
import { APP_NAME } from '../../constants/brand';
import billnestMark from '../../assets/billnest-mark.png';
import RoomInvoice from './RoomInvoice';
import { canShareBillFromDevice, shareBillFile } from '../../utils/billShare';

export default function BillWindow({ billId }) {
  const [bill, setBill] = useState(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'loaded' | 'notfound' | 'error'
  const [downloading, setDownloading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState('');
  const [printSettings, setPrintSettings] = useState({ printer_paper_width: '80', printer_scale_percent: '100' });

  useEffect(() => {
    let cancelled = false;
    setBill(null);
    setStatus('loading');
    window.api.getBillById(Number(billId))
      .then((b) => {
        if (cancelled) return;
        if (b) { setBill(b); setStatus('loaded'); }
        else setStatus('notfound');
      })
      // If the IPC/lookup itself throws, make sure we still leave the
      // "Loading…" state so the user isn't stuck on a spinner forever.
      .catch(() => { if (!cancelled) setStatus('error'); });
    window.api.getSettings?.().then((settings) => {
      if (!cancelled) setPrintSettings(settings || {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [billId]);

  // Always give the user a way out — the old version had no Close button at
  // all while loading, so a slow/failed/missing lookup left them stuck on
  // "Loading bill…" forever with no navigation option.
  //
  // window.close() only works for script-opened windows — true on desktop's
  // dedicated BillWindow BrowserWindow, but a no-op inside the single mobile
  // WebView where this route just replaces MainApp. The timeout fallback
  // returns to MainApp on mobile; on desktop the window is already gone
  // before it fires.
  function closeWindow() {
    window.close();
    setTimeout(() => { window.location.hash = ''; }, 150);
  }

  // FOOD bills download as a PNG snapshot; ROOM bills download as a proper A4
  // PDF. Sharing from a mobile device always creates a paginated PDF.
  async function handleDownload() {
    if (!bill) return;
    setDownloading(true);
    try {
      if (bill.source === 'ROOM') await window.api.downloadBillPdf(bill.id);
      else await window.api.downloadBillImage(bill.id);
    } finally {
      setDownloading(false);
    }
  }

  async function handlePrint() {
    if (!bill || printing) return;
    setPrinting(true);
    try {
      if (typeof window.api?.printBill === 'function') {
        await window.api.printBill(bill.id);
      } else if (typeof window.print === 'function') {
        window.print();
      }
    } finally {
      setPrinting(false);
    }
  }

  async function handleShare() {
    if (!bill || sharing) return;
    setSharing(true);
    setShareError('');
    try {
      await shareBillFile(bill);
    } catch (err) {
      if (err?.name !== 'AbortError') setShareError(err?.message || 'Could not share this bill.');
    } finally {
      setSharing(false);
    }
  }

  const canDownload = bill && bill.source === 'ROOM' ? !!window.api?.downloadBillPdf : !!window.api?.downloadBillImage;
  const canShareFile = canShareBillFromDevice();

  if (status !== 'loaded') {
    const message = {
      loading: 'Loading bill…',
      notfound: 'Bill not found. It may have been removed.',
      error: 'Could not load this bill. Please try again.',
    }[status];
    return (
      <div className={`bill-window ${bill?.source === 'ROOM' ? 'room-bill-window' : 'thermal-bill-window'}`}>
        <div className="empty-state">{message}</div>
        <div className="receipt-actions no-print">
          <button className="btn btn-secondary" onClick={closeWindow}>Close</button>
        </div>
      </div>
    );
  }

  const upiUri = bill.payment_method === 'ONLINE' && bill.upiId
    ? buildUpiUri({ upiId: bill.upiId, payeeName: bill.hotelName, amount: bill.total, note: bill.bill_number })
    : '';

  return (
    <div className="bill-window">
      {bill.source === 'ROOM' ? (
        <RoomInvoice bill={bill} />
      ) : (
        <div
          className="receipt"
          style={{
            '--receipt-width': `${Math.max(48, Math.min(112, Number(printSettings.printer_paper_width) || 80))}mm`,
            '--receipt-scale': `${Math.max(70, Math.min(150, Number(printSettings.printer_scale_percent) || 100))}%`,
          }}
        >
          <h2>{bill.hotelName}</h2>
          {bill.hotelAddress && <p className="receipt-sub">{bill.hotelAddress}</p>}
          {bill.hotelPhone && <p className="receipt-sub">Ph: {bill.hotelPhone}</p>}
          {bill.hotelGstin && <p className="receipt-sub">{bill.hotelGstin}</p>}
          <p className="receipt-title">TAX INVOICE</p>
          <hr />
          <div className="receipt-meta">
            <span>Bill No: {bill.bill_number}</span>
            <span>Token: {bill.token} ({bill.payment_method})</span>
            <span>Date: {formatDate(bill.created_at)}</span>
            {bill.customer_name && <span>Customer: {bill.customer_name}</span>}
            {bill.status === 'CANCELLED' && <span className="status-badge cancelled">CANCELLED</span>}
          </div>
          <hr />
          <table className="receipt-table">
            <thead>
              <tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr>
            </thead>
            <tbody>
              {bill.items.map((it) => (
                <tr key={it.id}>
                  <td>{it.name}</td>
                  <td>{it.quantity}</td>
                  <td>{formatCurrency(it.price)}</td>
                  <td>{formatCurrency(it.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <hr />
          <div className="receipt-totals">
            <div><span>Subtotal</span><span>{formatCurrency(bill.subtotal)}</span></div>
            {bill.tax_amount > 0 ? (
              (() => {
                const { halfPercent, cgstAmount, sgstAmount } = splitGst(bill.tax_percent, bill.tax_amount);
                return (
                  <>
                    <div><span>CGST ({halfPercent}%)</span><span>{formatCurrency(cgstAmount)}</span></div>
                    <div><span>SGST ({halfPercent}%)</span><span>{formatCurrency(sgstAmount)}</span></div>
                  </>
                );
              })()
            ) : (
              <div><span>Tax ({bill.tax_percent}%)</span><span>{formatCurrency(bill.tax_amount)}</span></div>
            )}
            {bill.discount > 0 && <div><span>Discount</span><span>-{formatCurrency(bill.discount)}</span></div>}
            <div className="grand-total"><span>Total</span><span>{formatCurrency(bill.total)}</span></div>
            {bill.advance_payment > 0 && (
              <>
                <div className="receipt-advance-row"><span>Advance Paid</span><span>-{formatCurrency(bill.advance_payment)}</span></div>
                <div className="receipt-balance-row"><span>Balance Paid Now</span><span>{formatCurrency(bill.balance_due != null ? bill.balance_due : bill.total)}</span></div>
              </>
            )}
          </div>
          <hr />
          <p className="receipt-footer">{bill.billFooter}</p>
          {upiUri && (
            <div className="receipt-upi">
              <QRCodeImage value={upiUri} size={150} />
              <p className="receipt-sub">Scan to pay via UPI</p>
            </div>
          )}
          <p className="receipt-powered-by">
            <img src={billnestMark} alt="" className="receipt-powered-by-logo" />
            <span>Powered by <strong>{APP_NAME}</strong></span>
          </p>
        </div>
      )}
      <div className="receipt-actions no-print">
        {canShareFile && (
          <button className="btn btn-primary" onClick={handleShare} disabled={sharing}>
            {sharing ? 'Preparing bill…' : '💬 Share Bill'}
          </button>
        )}
        <button className="btn btn-primary" onClick={handlePrint} disabled={printing}>
          {printing ? 'Printing…' : '🖨️ Print'}
        </button>
        {canDownload && (
          <button className="btn btn-secondary" onClick={handleDownload} disabled={downloading}>
            {downloading ? 'Preparing…' : `⬇️ Download ${bill.source === 'ROOM' ? 'PDF' : 'Image'}`}
          </button>
        )}
        <button
          className="btn btn-secondary"
          onClick={closeWindow}
        >
          Close
        </button>
      </div>
      {shareError && <div className="error-text" role="alert">{shareError}</div>}
      {canShareFile && <p className="receipt-sub no-print">Choose WhatsApp in the share menu, select the customer, then tap Send.</p>}
    </div>
  );
}
