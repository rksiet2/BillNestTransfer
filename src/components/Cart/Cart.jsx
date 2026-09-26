import React, { useState, useEffect } from 'react';
import { useCart } from '../../context/CartContext';
import { formatCurrency, splitGst } from '../../utils/format';
import { buildUpiUri } from '../../utils/upi';
import QuantityStepper from '../common/QuantityStepper';
import QRCodeImage from '../common/QRCodeImage';
import TaxRateSelect from '../common/TaxRateSelect';
import { canShareBillFromDevice, createBillShareMessage, shareBillFile } from '../../utils/billShare';

export default function Cart({ onBillGenerated, mobileOpen, onMobileClose }) {
  const {
    items, paymentMethod, setPaymentMethod, customerName, setCustomerName,
    customerPhone, setCustomerPhone, activeTable, subtotal, updateQuantity,
    removeItem, clearCart, selectTable, clearTableDraft,
    tableSyncStatus,
  } = useCart();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [settings, setSettings] = useState(null);
  const [orderNote, setOrderNote] = useState('');
  // null = "follow Settings' default tax rate"; becomes a number once the
  // cashier overrides it for this particular order via the dropdown below.
  const [taxPercentOverride, setTaxPercentOverride] = useState(null);
  const [discount, setDiscount] = useState(0);
  const [showPrintOptions, setShowPrintOptions] = useState(false);
  const itemCount = items.reduce((count, item) => count + item.quantity, 0);

  useEffect(() => {
    window.api.getSettings().then(setSettings);
    const refresh = () => window.api.getSettings().then(setSettings);
    window.addEventListener('billnest:settings-updated', refresh);
    return () => window.removeEventListener('billnest:settings-updated', refresh);
  }, []);

  const taxPercent = taxPercentOverride != null
    ? taxPercentOverride
    // Auto-select the Cash vs Online GST slab configured in Settings the
    // moment the cashier picks a payment method; still overridable below.
    : parseFloat(
        (paymentMethod === 'ONLINE' ? settings?.tax_percent_online : settings?.tax_percent_cash)
          ?? settings?.tax_percent
          ?? 5
      );
  const taxAmount = +(subtotal * (taxPercent / 100)).toFixed(2);
  const total = +(subtotal + taxAmount - (parseFloat(discount) || 0)).toFixed(2);

  const upiUri = settings?.upi_id
    ? buildUpiUri({ upiId: settings.upi_id, payeeName: settings.hotel_name, amount: total, note: 'Order payment' })
    : '';

  async function handleGenerateBill(printMode) {
    if (items.length === 0) {
      setError('Please add at least 1 item to generate a bill.');
      return;
    }
    setError('');
    setGenerating(true);
    try {
      const bill = await window.api.createBill({
        items,
        paymentMethod,
        customerName,
        customerPhone,
        orderNote,
        discount: parseFloat(discount) || 0,
        taxPercent,
        tableId: activeTable?.id,
      });
      clearCart();
      setOrderNote('');
      setDiscount(0);
      setTaxPercentOverride(null);
      // A table order is done once billed — free the table for the next
      // guest (kitchen/floor staff physically clear it, then the "Clear
      // Table" tap on the Tables screen resets status back to EMPTY).
      if (activeTable) {
        await window.api.updateTableStatus(activeTable.id, 'BILLED');
        clearTableDraft(activeTable.id);
        selectTable(null, { discardOutgoing: true });
      }
      if (
        canShareBillFromDevice()
        && settings?.whatsapp_send_food_bill === 'true'
        && customerPhone.trim()
      ) {
        try {
          await shareBillFile(bill, createBillShareMessage(bill, settings?.whatsapp_food_bill_template));
        } catch (shareErr) {
          if (shareErr?.name !== 'AbortError') {
            setError(`Bill saved, but WhatsApp could not be opened: ${shareErr?.message || 'Unknown error.'}`);
          }
        }
      }
      onBillGenerated?.(bill);
      onMobileClose?.();
      // Awaited sequentially (not fire-and-forget) so mobile's single-webview
      // hash navigation for bill/KOT doesn't have one call's route-switch
      // stomp the other's before its print dialog fires. Safe on desktop too,
      // since its native windows never conflicted with sequential awaits.
      // Cart.jsx is the single source of truth for which window ends up on
      // screen — createBill() itself never navigates (see webApi.js).
      // Order matters: whichever prints last ends up the focused/visible
      // window. For "Both", KOT (kitchen-only) goes first so the customer-
      // facing Bill is what's left on screen — otherwise "Both" ends up
      // looking identical to "Generate + Print KOT" alone (KOT window on top).
      if (printMode === 'kot' || printMode === 'both') await window.api.printKot(bill.id);
      if (printMode === 'bill' || printMode === 'both') await window.api.printBill(bill.id);
      if (!printMode) await window.api.openBillWindow(bill.id);
    } catch (err) {
      setError(err.message || 'Failed to generate bill.');
    } finally {
      setGenerating(false);
    }
  }

  async function handleCancelOrder() {
    clearCart();
    // Cancelling a table's order entirely means the table is free again.
    if (activeTable) {
      await window.api.updateTableStatus(activeTable.id, 'EMPTY');
      clearTableDraft(activeTable.id);
      selectTable(null, { discardOutgoing: true });
    }
    setShowCancelConfirm(false);
  }

  return (
    <aside className={`cart-panel ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className="cart-header">
        <h3>Current Order</h3>
        <span className="cart-count">{itemCount} item{itemCount === 1 ? '' : 's'}</span>
        <button className="cart-mobile-close" onClick={onMobileClose} aria-label="Close order">✕</button>
      </div>

      {activeTable && (
        <div className="cart-table-badge">
          🍽️ Table: <strong>{activeTable.name}</strong>
          <span className={`table-save-status ${tableSyncStatus}`}>
            {tableSyncStatus === 'saving' ? 'Saving…' : tableSyncStatus === 'error' ? 'Not saved' : 'Saved'}
          </span>
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              if (items.length > 0 && !window.confirm('Leave this table? Its order stays saved — you can resume it from Tables.')) return;
              selectTable(null);
            }}
          >
            Switch to Counter
          </button>
        </div>
      )}

      <div className="cart-scroll-area">
        <input
          className="customer-input"
          placeholder="Customer name (optional)"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
        />

        <input
          className="customer-input"
          type="tel"
          inputMode="numeric"
          placeholder="Customer phone (optional)"
          value={customerPhone}
          onChange={(e) => setCustomerPhone(e.target.value.replace(/[^\d+ ]/g, ''))}
        />

      <textarea
        className="order-note-input"
        placeholder="Kitchen note (e.g. less spicy, no onion) — optional, shown on KOT"
        value={orderNote}
        onChange={(e) => setOrderNote(e.target.value)}
        rows={2}
      />

      <div className="cart-items">
        {items.length === 0 && <div className="empty-state small">Cart is empty. Add items from the menu.</div>}
        {items.map((it) => (
          <div key={it.id} className="cart-item">
            <div className="cart-item-info">
              <span className="cart-item-name">{it.name}</span>
              <span className="cart-item-price">{formatCurrency(it.price)} each</span>
            </div>
            <QuantityStepper
              size="sm"
              quantity={it.quantity}
              onIncrement={() => updateQuantity(it.id, 1)}
              onDecrement={() => updateQuantity(it.id, -1)}
            />
            <span className="cart-item-total">{formatCurrency(it.price * it.quantity)}</span>
            <button className="remove-btn" onClick={() => removeItem(it.id)} aria-label="Remove item">
              🗑
            </button>
          </div>
        ))}
      </div>

      <div className="payment-method">
        <span>Payment Method</span>
        <div className="payment-options">
          <button
            className={`pay-btn ${paymentMethod === 'CASH' ? 'active' : ''}`}
            onClick={() => { setPaymentMethod('CASH'); setTaxPercentOverride(null); }}
          >
            💵 Cash
          </button>
          <button
            className={`pay-btn ${paymentMethod === 'ONLINE' ? 'active' : ''}`}
            onClick={() => { setPaymentMethod('ONLINE'); setTaxPercentOverride(null); }}
          >
            📱 Online (UPI/Card)
          </button>
        </div>
        {paymentMethod === 'ONLINE' && items.length > 0 && (
          <div className="upi-qr-box">
            {upiUri ? (
              <>
                <QRCodeImage value={upiUri} size={140} />
                <span className="upi-qr-hint">Ask customer to scan &amp; pay {formatCurrency(total)}</span>
              </>
            ) : (
              <span className="upi-qr-hint warn">
                No UPI ID set up yet. Add it in ⚙️ Settings to show a scannable QR here.
              </span>
            )}
          </div>
        )}
      </div>

      <div className="cart-billing-options">
        <TaxRateSelect label="Tax / GST Rate" value={taxPercent} onChange={setTaxPercentOverride} />
        <label>
          Discount (₹)
          <input
            type="number"
            min="0"
            step="1"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            placeholder="0"
          />
        </label>
      </div>

      </div>

      <div className="cart-summary" aria-live="polite">
        <div className="summary-row">
          <span>Subtotal</span>
          <span>{formatCurrency(subtotal)}</span>
        </div>
        {taxAmount > 0 ? (
          (() => {
            const { halfPercent, cgstAmount, sgstAmount } = splitGst(taxPercent, taxAmount);
            return (
              <>
                <div className="summary-row">
                  <span>CGST ({halfPercent}%)</span>
                  <span>{formatCurrency(cgstAmount)}</span>
                </div>
                <div className="summary-row">
                  <span>SGST ({halfPercent}%)</span>
                  <span>{formatCurrency(sgstAmount)}</span>
                </div>
              </>
            );
          })()
        ) : (
          <div className="summary-row">
            <span>Tax ({taxPercent}%)</span>
            <span>{formatCurrency(taxAmount)}</span>
          </div>
        )}
        {discount > 0 && (
          <div className="summary-row">
            <span>Discount</span>
            <span>-{formatCurrency(discount)}</span>
          </div>
        )}
        <div className="summary-row total-row">
          <span>Total</span>
          <span>{formatCurrency(total)}</span>
        </div>
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}

      <div className="cart-actions">
        <button className="btn btn-secondary" onClick={() => setShowCancelConfirm(true)} disabled={items.length === 0}>
          Cancel Order
        </button>
        <button className="btn btn-primary" onClick={() => handleGenerateBill()} disabled={items.length === 0 || generating}>
          {generating ? 'Saving bill…' : `Generate Bill · ${formatCurrency(total)}`}
        </button>
      </div>
      <details className="cart-print-options" open={showPrintOptions} onToggle={(event) => setShowPrintOptions(event.currentTarget.open)}>
        <summary>More options · Generate and print</summary>
        <div className="cart-actions cart-actions-print">
          <button className="btn btn-outline" onClick={() => handleGenerateBill('kot')} disabled={items.length === 0 || generating}>
            🧑‍🍳 Bill + KOT
          </button>
          <button className="btn btn-outline" onClick={() => handleGenerateBill('bill')} disabled={items.length === 0 || generating}>
            🖨️ Bill only
          </button>
          <button className="btn btn-outline" onClick={() => handleGenerateBill('both')} disabled={items.length === 0 || generating}>
            🖨️ Print both
          </button>
        </div>
      </details>

      {showCancelConfirm && (
        <div className="modal-overlay">
          <div className="modal">
            <h4>Cancel this order?</h4>
            <p>All items in the current order will be removed.</p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowCancelConfirm(false)}>
                Keep Order
              </button>
              <button className="btn btn-danger" onClick={handleCancelOrder}>
                Yes, Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
