import React, { useEffect, useState } from 'react';
import { formatDate } from '../../utils/format';

// Kitchen Order Ticket window: a simplified, price-free ticket for kitchen
// staff showing only item names/quantities so the order can be prepared fast.
export default function KotWindow({ billId }) {
  const [bill, setBill] = useState(null);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    window.api.getBillById(Number(billId)).then(setBill);
  }, [billId]);

  if (!bill) return <div className="empty-state">Loading KOT…</div>;

  async function handlePrint() {
    if (printing) return;
    setPrinting(true);
    try {
      if (typeof window.api?.printKot === 'function') await window.api.printKot(bill.id);
      else if (typeof window.print === 'function') window.print();
    } finally {
      setPrinting(false);
    }
  }

  return (
    <div className="bill-window kot-window">
      <div className="receipt kot-receipt">
        <h2>KITCHEN ORDER TICKET</h2>
        <p className="receipt-title">KOT</p>
        <hr />
        <div className="receipt-meta">
          <span>KOT No: {bill.kot_number}</span>
          <span>Token: {bill.token}</span>
          <span>Date: {formatDate(bill.created_at)}</span>
          {bill.customer_name && <span>Customer: {bill.customer_name}</span>}
          {bill.status === 'CANCELLED' && <span className="status-badge cancelled">CANCELLED</span>}
        </div>
        <hr />
        <table className="receipt-table kot-table">
          <thead>
            <tr><th>Item</th><th>Qty</th></tr>
          </thead>
          <tbody>
            {bill.items.map((it) => (
              <tr key={it.id}>
                <td>{it.name}</td>
                <td>{it.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <hr />
        {bill.order_note && (
          <p className="receipt-sub"><strong>Note:</strong> {bill.order_note}</p>
        )}
        <p className="receipt-footer kot-footer">*** PREPARE FRESH &amp; FAST ***</p>
      </div>
      <div className="receipt-actions no-print">
        <button className="btn btn-primary" onClick={handlePrint} disabled={printing}>
          {printing ? 'Printing…' : '🖨️ Print KOT'}
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => {
            window.close();
            setTimeout(() => { window.location.hash = ''; }, 150);
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
