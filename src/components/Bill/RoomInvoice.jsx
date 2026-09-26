import React from 'react';
import { formatCurrency, splitGst } from '../../utils/format';
import { buildUpiUri } from '../../utils/upi';
import QRCodeImage from '../common/QRCodeImage';
import { APP_NAME } from '../../constants/brand';
import billnestMark from '../../assets/billnest-mark.png';
import FoodImage from '../common/FoodImage';

// Format "2026-09-14T04:47" or "2026-09-14 14:56:29" → "14 Sep 2026, 04:47 AM"
function formatDateTime(str) {
  if (!str) return '—';
  try {
    // Normalise: replace 'T' separator so both forms parse the same way
    const normalised = String(str).replace('T', ' ');
    const d = new Date(normalised);
    if (isNaN(d)) return str;
    return d.toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch { return str; }
}

// Format date-only "2026-09-14" → "14 Sep 2026"
function formatDateOnly(str) {
  if (!str) return '—';
  try {
    // Treat as local date — avoid UTC shift by splitting manually
    const parts = String(str).split(/[-T ]/);
    if (parts.length >= 3) {
      const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    }
    return str;
  } catch { return str; }
}

function nightsBetween(a, b) {
  if (!a || !b) return null;
  try {
    const aParts = String(a).split(/[-T ]/);
    const bParts = String(b).split(/[-T ]/);
    const da = new Date(Number(aParts[0]), Number(aParts[1]) - 1, Number(aParts[2]));
    const db = new Date(Number(bParts[0]), Number(bParts[1]) - 1, Number(bParts[2]));
    const n = Math.round((db - da) / 86400000);
    return n > 0 ? n : null;
  } catch { return null; }
}

// A labelled row used in the info table: left label, right value, consistent alignment.
function InfoRow({ label, value, bold }) {
  if (!value && value !== 0) return null;
  return (
    <tr>
      <td className="ri-info-label">{label}</td>
      <td className="ri-info-value" style={bold ? { fontWeight: 700 } : undefined}>{value}</td>
    </tr>
  );
}

// Full-page A4 hotel stay invoice. Two modes:
//   - Single room: pass `bill` (from getBillById, source=ROOM)
//   - Multi-room group checkout: pass `group` (from getGroupInvoice)
// Never shows internal booking-group terminology to the guest.
export default function RoomInvoice({ bill, group }) {
  const isGroup = !!group;
  const data = group || bill;

  // UPI QR — single bills only, online payment, upiId present
  const upiUri = !isGroup && bill.payment_method === 'ONLINE' && bill.upiId
    ? buildUpiUri({ upiId: bill.upiId, payeeName: bill.hotelName, amount: bill.total, note: bill.bill_number })
    : '';

  const invoiceCheckIn = !isGroup ? (bill.actualCheckIn || bill.checkInDate) : null;
  const invoiceCheckOut = !isGroup ? (bill.actualCheckOut || bill.checkOutDate) : null;
  const nights = !isGroup ? nightsBetween(bill.checkInDate, bill.checkOutDate) : null;

  // Advance / balance display logic (single bill):
  //   advance_payment > 0  → show "Advance Received" and "Balance at Checkout"
  //   balance_due === 0    → add "FULLY PAID" badge
  const advance = !isGroup ? (Number(bill.advance_payment) || 0) : 0;
  const balanceDue = !isGroup
    ? (bill.balance_due != null ? Number(bill.balance_due) : Number(bill.total))
    : 0;
  const fullyPaid = !isGroup && advance > 0 && balanceDue === 0;

  return (
    <div className="room-a4-invoice">

      {/* ── Letterhead ── */}
      <div className="ri-letterhead">
        {data.hotelLogo && <FoodImage src={data.hotelLogo} alt="Hotel logo" size={72} />}
        <div className="ri-letterhead-text">
          <h1>{data.hotelName}</h1>
          {data.hotelAddress && <p>{data.hotelAddress}</p>}
          <p className="ri-letterhead-contact">
            {data.hotelPhone && <span>Ph: {data.hotelPhone}</span>}
            {data.hotelGstin && <span>{data.hotelGstin}</span>}
          </p>
        </div>
      </div>

      {/* ── Title bar ── */}
      <div className="ri-title-bar">
        <span className="ri-title-text">TAX INVOICE</span>
        <span className="ri-title-sub">Room Stay Receipt</span>
        {!isGroup && bill.status === 'CANCELLED' && (
          <span className="status-badge cancelled ri-cancelled-badge">CANCELLED</span>
        )}
        {fullyPaid && <span className="ri-paid-badge">FULLY PAID</span>}
      </div>

      {/* ── Invoice meta + Guest info side by side ── */}
      <div className="ri-header-grid">

        <div className="ri-header-col">
          <p className="ri-section-label">Invoice Details</p>
          <table className="ri-info-table">
            <tbody>
              <InfoRow label="Invoice No." value={isGroup ? data.groupInvoiceNumber : bill.bill_number} bold />
              {!isGroup && bill.booking_number && (
                <InfoRow label="Booking No." value={bill.booking_number} />
              )}
              <InfoRow label="Date" value={
                isGroup
                  ? formatDateOnly(data.createdAt)
                  : formatDateTime(bill.created_at)
              } />
              <InfoRow label="Payment" value={
                (isGroup ? data.paymentMethod : bill.payment_method) || '—'
              } />
            </tbody>
          </table>
        </div>

        <div className="ri-header-col">
          <p className="ri-section-label">Guest Details</p>
          <table className="ri-info-table">
            <tbody>
              <InfoRow label="Name" value={data.guestName || '—'} bold />
              {/* Phone: always shown — use first room's phone for group invoices */}
              <InfoRow
                label="Mobile"
                value={
                  isGroup
                    ? (data.rooms?.[0]?.guestPhone || data.guestPhone || '—')
                    : (bill.guestPhone || '—')
                }
              />
              {!isGroup && bill.guestGstin && <InfoRow label="GSTIN" value={bill.guestGstin} />}
              {!isGroup && bill.guestIdType && bill.guestIdNumber && (
                <InfoRow label={bill.guestIdType} value={bill.guestIdNumber} />
              )}
            </tbody>
          </table>
        </div>

      </div>

      {/* ── Divider ── */}
      <div className="ri-divider" />

      {/* ══ SINGLE ROOM BILL ══ */}
      {!isGroup && (
        <>
          {/* Stay summary row */}
          <div className="ri-stay-bar">
            <div className="ri-stay-cell">
              <span className="ri-stay-label">Room</span>
              <span className="ri-stay-val">{bill.roomNumber} <span className="ri-stay-type">({bill.roomType})</span></span>
            </div>
            <div className="ri-stay-cell">
              <span className="ri-stay-label">Check-in</span>
              <span className="ri-stay-val">{formatDateTime(invoiceCheckIn)}</span>
            </div>
            <div className="ri-stay-cell">
              <span className="ri-stay-label">Check-out</span>
              <span className="ri-stay-val">{formatDateTime(invoiceCheckOut)}</span>
            </div>
            {nights && (
              <div className="ri-stay-cell">
                <span className="ri-stay-label">Duration</span>
                <span className="ri-stay-val">{nights} Night{nights > 1 ? 's' : ''}{bill.numGuests ? `, ${bill.numGuests} Guest${bill.numGuests > 1 ? 's' : ''}` : ''}</span>
              </div>
            )}
          </div>

          {/* Charges table */}
          <table className="ri-table">
            <thead>
              <tr>
                <th>Description</th>
                <th>Nights</th>
                <th>Rate / Night</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {bill.items.map((it) => (
                <tr key={it.id}>
                  <td>{it.name}</td>
                  <td className="ri-td-num">{it.quantity}</td>
                  <td className="ri-td-num">{formatCurrency(it.price)}</td>
                  <td className="ri-td-num">{formatCurrency(it.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals block */}
          <div className="ri-totals-wrap">
            <div className="ri-totals">
              <div className="ri-total-row">
                <span>Subtotal</span>
                <span>{formatCurrency(bill.subtotal)}</span>
              </div>
              {bill.tax_amount > 0 && (() => {
                const { halfPercent, cgstAmount, sgstAmount } = splitGst(bill.tax_percent, bill.tax_amount);
                return (
                  <>
                    <div className="ri-total-row ri-total-muted">
                      <span>CGST ({halfPercent}%)</span>
                      <span>{formatCurrency(cgstAmount)}</span>
                    </div>
                    <div className="ri-total-row ri-total-muted">
                      <span>SGST ({halfPercent}%)</span>
                      <span>{formatCurrency(sgstAmount)}</span>
                    </div>
                  </>
                );
              })()}
              {bill.discount > 0 && (
                <div className="ri-total-row ri-total-muted">
                  <span>Discount</span>
                  <span>− {formatCurrency(bill.discount)}</span>
                </div>
              )}
              <div className="ri-total-row ri-grand-total">
                <span>Total Charges</span>
                <span>{formatCurrency(bill.total)}</span>
              </div>
              {advance > 0 && (
                <>
                  <div className="ri-total-row ri-advance-row">
                    <span>Advance Received</span>
                    <span>− {formatCurrency(advance)}</span>
                  </div>
                  <div className={`ri-total-row ri-balance-row${fullyPaid ? ' ri-fully-paid' : ''}`}>
                    <span>{fullyPaid ? 'Balance Due' : 'Balance Collected at Checkout'}</span>
                    <span>{fullyPaid ? formatCurrency(0) : formatCurrency(balanceDue)}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* ══ GROUP (MULTI-ROOM) BILL ══ */}
      {isGroup && data.rooms.map((room, idx) => (
        <div key={room.bookingId || idx} className="ri-room-section">

          <div className="ri-room-header">
            <span className="ri-room-badge">Room {idx + 1}</span>
            <span className="ri-room-title">
              {room.roomNumber} ({room.roomType})
              {room.guestName && room.guestName !== data.guestName ? ` · ${room.guestName}` : ''}
            </span>
            <span className="ri-room-dates">
              {formatDateOnly(room.checkInDate)} → {formatDateOnly(room.checkOutDate)}
            </span>
          </div>

          <table className="ri-table">
            <thead>
              <tr>
                <th>Description</th>
                <th>Nights</th>
                <th>Rate / Night</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {room.items.map((it) => (
                <tr key={it.id}>
                  <td>{it.name}</td>
                  <td className="ri-td-num">{it.quantity}</td>
                  <td className="ri-td-num">{formatCurrency(it.price)}</td>
                  <td className="ri-td-num">{formatCurrency(it.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="ri-totals-wrap ri-room-totals-wrap">
            <div className="ri-totals">
              <div className="ri-total-row ri-total-muted">
                <span>Room Subtotal</span>
                <span>{formatCurrency(room.subtotal)}</span>
              </div>
              {room.taxAmount > 0 && (
                <div className="ri-total-row ri-total-muted">
                  <span>Tax</span>
                  <span>{formatCurrency(room.taxAmount)}</span>
                </div>
              )}
              {room.discount > 0 && (
                <div className="ri-total-row ri-total-muted">
                  <span>Discount</span>
                  <span>− {formatCurrency(room.discount)}</span>
                </div>
              )}
              <div className="ri-total-row" style={{ fontWeight: 600 }}>
                <span>Room Total</span>
                <span>{formatCurrency(room.total)}</span>
              </div>
              {Number(room.advancePayment) > 0 && (
                <>
                  <div className="ri-total-row ri-advance-row">
                    <span>Advance Received</span>
                    <span>− {formatCurrency(room.advancePayment)}</span>
                  </div>
                  <div className={`ri-total-row ri-balance-row${Number(room.balanceDue) === 0 ? ' ri-fully-paid' : ''}`}>
                    <span>{Number(room.balanceDue) === 0 ? 'Balance Due' : 'Balance Collected'}</span>
                    <span>{formatCurrency(room.balanceDue)}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ))}

      {/* ── Group grand total ── */}
      {isGroup && (
        <div className="ri-totals-wrap">
          <div className="ri-totals">
            <div className="ri-total-row ri-total-muted">
              <span>Combined Subtotal</span>
              <span>{formatCurrency(data.subtotal)}</span>
            </div>
            {data.taxAmount > 0 && (
              <div className="ri-total-row ri-total-muted">
                <span>Total Tax</span>
                <span>{formatCurrency(data.taxAmount)}</span>
              </div>
            )}
            {data.discount > 0 && (
              <div className="ri-total-row ri-total-muted">
                <span>Total Discount</span>
                <span>− {formatCurrency(data.discount)}</span>
              </div>
            )}
            <div className="ri-total-row ri-grand-total">
              <span>Grand Total</span>
              <span>{formatCurrency(data.total)}</span>
            </div>
            {Number(data.advancePayment) > 0 && (
              <>
                <div className="ri-total-row ri-advance-row">
                  <span>Total Advance Received</span>
                  <span>− {formatCurrency(data.advancePayment)}</span>
                </div>
                <div className={`ri-total-row ri-balance-row${Number(data.balanceDue) === 0 ? ' ri-fully-paid' : ''}`}>
                  <span>{Number(data.balanceDue) === 0 ? 'Balance Due' : 'Balance Collected at Checkout'}</span>
                  <span>{formatCurrency(data.balanceDue)}</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── UPI QR (single, online) ── */}
      {upiUri && (
        <div className="ri-upi">
          <QRCodeImage value={upiUri} size={120} />
          <p>Scan to pay via UPI</p>
        </div>
      )}

      {/* ── Footer ── */}
      {data.billFooter && <p className="ri-footer">{data.billFooter}</p>}

      {/* ── Signature boxes ── */}
      <div className="ri-signature-row">
        <div className="ri-signature-box">
          <div className="ri-signature-line" />
          <span>Guest Signature</span>
        </div>
        <div className="ri-signature-box">
          <div className="ri-signature-line" />
          <span>Authorized Signatory</span>
        </div>
      </div>

      {/* ── Powered-by strip ── */}
      <p className="ri-powered-by">
        <img src={billnestMark} alt="" className="ri-powered-by-logo" />
        <span>Powered by <strong>{APP_NAME}</strong></span>
      </p>

    </div>
  );
}
