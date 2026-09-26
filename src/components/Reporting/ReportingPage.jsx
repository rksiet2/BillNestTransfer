import React, { useEffect, useState, useCallback } from 'react';
import {
  UilWallet, UilShoppingBag, UilReceipt, UilTimesCircle,
  UilCreditCard, UilBox, UilFileAlt, UilChartGrowth,
} from '@iconscout/react-unicons';
import { formatCurrency, formatDate } from '../../utils/format';
import { periodToRange, todayStr } from '../../utils/dateRange';
import { APP_NAME } from '../../constants/brand';
import TrendChart from './TrendChart';

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Weekly' },
  { key: 'month', label: 'Monthly' },
  { key: 'year', label: 'Annually' },
  { key: 'all', label: 'All Time' },
  { key: 'custom', label: '📅 Custom Range' },
];

export default function ReportingPage() {
  const [period, setPeriod] = useState('today');
  const [source, setSource] = useState('ALL');
  const [customFrom, setCustomFrom] = useState(todayStr());
  const [customTo, setCustomTo] = useState(todayStr());
  const [summary, setSummary] = useState(null);
  const [trend, setTrend] = useState([]);
  const [bills, setBills] = useState([]);
  const [billsPage, setBillsPage] = useState(0);
  const BILLS_PAGE_SIZE = 25;
  const [pnl, setPnl] = useState(null);
  const [cancelId, setCancelId] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const [expandedBillId, setExpandedBillId] = useState(null);

  const isCustom = period === 'custom';
  const sourceFilter = source === 'ALL' ? undefined : source;
  const reportPayload = isCustom
    ? { period: 'custom', from: customFrom, to: customTo, source: sourceFilter }
    : { period, source: sourceFilter };
  // Profit & Loss always covers BOTH Food + Room revenue (purchases/expenses
  // aren't tracked per-source), so it uses its own payload without `source`.
  const pnlPayload = isCustom ? { period: 'custom', from: customFrom, to: customTo } : period;

  const load = useCallback(async () => {
    if (isCustom && (!customFrom || !customTo || customFrom > customTo)) return;
    const billsRange = isCustom ? { from: customFrom, to: customTo } : periodToRange(period);
    const [s, t, b, p] = await Promise.all([
      window.api.getSummary(reportPayload),
      window.api.getSalesTrend(reportPayload),
      window.api.listBills({ ...billsRange, source: sourceFilter }),
      window.api.getProfitLoss(pnlPayload),
    ]);
    setSummary(s);
    setTrend(t);
    setBills(b);
    setPnl(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customFrom, customTo, source]);

  // Reset back to page 1 whenever the selected range/source actually changes
  // (but NOT on the 15s auto-refresh tick below, so the user isn't bumped
  // back to page 1 while browsing older pages).
  useEffect(() => {
    setBillsPage(0);
    setExpandedBillId(null);
  }, [period, customFrom, customTo, source]);

  useEffect(() => {
    load();
    // Real-time refresh every 15s so stats stay current while orders come in.
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  const billsTotalPages = Math.max(1, Math.ceil(bills.length / BILLS_PAGE_SIZE));
  const safeBillsPage = Math.min(billsPage, billsTotalPages - 1);
  const pageBills = bills.slice(safeBillsPage * BILLS_PAGE_SIZE, safeBillsPage * BILLS_PAGE_SIZE + BILLS_PAGE_SIZE);

  async function confirmCancel() {
    await window.api.cancelBill(cancelId, cancelReason || 'Cancelled from reporting');
    setCancelId(null);
    setCancelReason('');
    load();
  }

  // Exports every bill currently matching the selected date range + Food/
  // Hotel/Both filter (not just the visible page) as a CSV file the owner
  // can open in Excel/Sheets — fully client-side (Blob + <a download>), so
  // it works the same in the Electron app, the browser build, and mobile.
  function handleDownloadSalesHistory() {
    const header = ['Bill No.', 'Token', 'Date', 'Source', 'Payment', 'Total', 'Status'];
    const escapeCsv = (val) => {
      const s = String(val ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = bills.map((b) => [
      b.bill_number,
      b.token,
      formatDate(b.created_at),
      b.source === 'ROOM' ? 'Hotel' : 'Food',
      b.payment_method,
      b.total,
      b.status,
    ]);
    const csv = [header, ...rows].map((r) => r.map(escapeCsv).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const rangeLabel = isCustom ? `${customFrom}_to_${customTo}` : period;
    a.href = url;
    a.download = `${APP_NAME}-Sales-History-${rangeLabel}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }


  return (
    <div className="reporting-page">
      <div className="bookings-filter-group">
        <span className="bookings-filter-label">Date Range</span>
        <div className="report-period-tabs">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              className={`cat-tab ${period === p.key ? 'active' : ''}`}
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bookings-filter-group">
        <div className="report-source-switch">
          <button className={`cat-tab ${source === 'ALL' ? 'active' : ''}`} onClick={() => setSource('ALL')}>🔀 Both</button>
          <button className={`cat-tab ${source === 'FOOD' ? 'active' : ''}`} onClick={() => setSource('FOOD')}>🍽️ Food</button>
          <button className={`cat-tab ${source === 'ROOM' ? 'active' : ''}`} onClick={() => setSource('ROOM')}>🛏️ Hotel</button>
        </div>
      </div>

      {isCustom && (
        <div className="custom-range-bar">
          <label>
            From
            <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={customTo} min={customFrom} max={todayStr()} onChange={(e) => setCustomTo(e.target.value)} />
          </label>
          {customFrom > customTo && <span className="custom-range-error">"From" date must be before "To" date.</span>}
        </div>
      )}

      {summary && (
        <div className="stat-cards">
          <div className="stat-card">
            <span className="stat-icon"><UilWallet size={17} /></span>
            <span className="stat-label">Revenue</span>
            <span className="stat-value">{formatCurrency(summary.revenue)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-icon"><UilShoppingBag size={17} /></span>
            <span className="stat-label">Orders</span>
            <span className="stat-value">{summary.orderCount}</span>
          </div>
          <div className="stat-card">
            <span className="stat-icon"><UilReceipt size={17} /></span>
            <span className="stat-label">Avg. Bill</span>
            <span className="stat-value">{formatCurrency(summary.avgBill)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-icon"><UilTimesCircle size={17} /></span>
            <span className="stat-label">Cancelled</span>
            <span className="stat-value">{summary.cancelledCount}</span>
          </div>
          <div className="stat-card">
            <span className="stat-icon"><UilCreditCard size={17} /></span>
            <span className="stat-label">Cash / Online</span>
            <span className="stat-value small">
              {formatCurrency(summary.cashRevenue)} / {formatCurrency(summary.onlineRevenue)}
            </span>
          </div>
        </div>
      )}

      {pnl && (
        <div className="report-card">
          <h4>Profit &amp; Loss <span className="stat-label" style={{ fontWeight: 400 }}>(combined Food + Hotel revenue)</span></h4>
          <div className="stat-cards">
            <div className="stat-card">
              <span className="stat-icon"><UilWallet size={17} /></span>
              <span className="stat-label">Revenue</span>
              <span className="stat-value">{formatCurrency(pnl.revenue)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-icon"><UilBox size={17} /></span>
              <span className="stat-label">Purchases</span>
              <span className="stat-value">{formatCurrency(pnl.totalPurchases)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-icon"><UilFileAlt size={17} /></span>
              <span className="stat-label">Expenses</span>
              <span className="stat-value">{formatCurrency(pnl.totalExpenses)}</span>
            </div>
            <div className="stat-card">
              <span className="stat-icon"><UilChartGrowth size={17} /></span>
              <span className="stat-label">Net Profit</span>
              <span className={`stat-value ${pnl.netProfit < 0 ? 'negative' : ''}`}>{formatCurrency(pnl.netProfit)}</span>
            </div>
          </div>
          {pnl.expensesByCategory?.length > 0 && (
            <table className="fm-table">
              <thead><tr><th>Expense Category</th><th>Spend</th></tr></thead>
              <tbody>
                {pnl.expensesByCategory.map((c) => (
                  <tr key={c.category}><td>{c.category}</td><td>{formatCurrency(c.spend)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="report-grid">
        <div className="report-card">
          <h4>Sales Trend</h4>
          <TrendChart trend={trend} />
        </div>

        <div className="report-card">
          <h4>{source === 'ROOM' ? 'Top Rooms & Add-ons' : source === 'FOOD' ? 'Top Selling Items' : 'Top Sellers'}</h4>
          <table className="fm-table top-sellers-table">
            <thead>
              <tr><th>Item</th><th>Qty Sold</th><th>Revenue</th></tr>
            </thead>
            <tbody>
              {summary?.topItems?.map((it) => (
                <tr key={it.name}>
                  <td>{it.name}</td>
                  <td>{it.qty}</td>
                  <td>{formatCurrency(it.revenue)}</td>
                </tr>
              ))}
              {(!summary?.topItems || summary.topItems.length === 0) && (
                <tr><td colSpan={3} className="empty-state small">No data yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="report-card">
        <div className="fm-list-header">
          <h4>Sales History</h4>
          <button
            type="button"
            className="btn-icon-only"
            onClick={handleDownloadSalesHistory}
            disabled={bills.length === 0}
            title="Download Sales History (CSV)"
            aria-label="Download Sales History (CSV)"
          >
            ↓
          </button>
        </div>
        {bills.length > 0 && (
          <p className="sales-history-note">
            Showing {safeBillsPage * BILLS_PAGE_SIZE + 1}-{Math.min((safeBillsPage + 1) * BILLS_PAGE_SIZE, bills.length)} of {bills.length} matching bill{bills.length === 1 ? '' : 's'} for this range.
          </p>
        )}
        <div className="fm-table-wrapper bills-desktop-table">
          <table className="fm-table">
            <thead>
              <tr>
                <th>Bill No.</th>
                <th>Token</th>
                <th>Date</th>
                <th>Source</th>
                <th>Payment</th>
                <th>Total</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageBills.map((b) => (
                <tr key={b.id}>
                  <td>{b.bill_number}</td>
                  <td>{b.token}</td>
                  <td>{formatDate(b.created_at)}</td>
                  <td>{b.source === 'ROOM' ? '🛏️ Hotel' : '🍽️ Food'}</td>
                  <td>{b.payment_method}</td>
                  <td>{formatCurrency(b.total)}</td>
                  <td>
                    <span className={`status-badge ${b.status.toLowerCase()}`}>{b.status}</span>
                  </td>
                  <td>
                    <div className="fm-row-actions">
                      <button className="btn-link" onClick={() => window.api.openBillWindow(b.id)}>View</button>
                      {b.status === 'COMPLETED' && (
                        <button className="btn-link danger" onClick={() => setCancelId(b.id)}>Cancel</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {bills.length === 0 && (
                <tr><td colSpan={8} className="empty-state small">No bills yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile-only: collapsible cards (same pattern as Bookings) — Bill
            No., Date, Total and Status stay visible; tap the arrow to reveal
            Token, Source, Payment method and actions. */}
        <div className="bills-mobile-cards">
          {pageBills.map((b) => {
            const expanded = expandedBillId === b.id;
            return (
              <div className={`booking-card${expanded ? ' expanded' : ''}`} key={b.id}>
                <button
                  type="button"
                  className="booking-card-summary"
                  onClick={() => setExpandedBillId(expanded ? null : b.id)}
                >
                  <div className="booking-card-main">
                    <span className="booking-card-guest">{b.bill_number} · {formatCurrency(b.total)}</span>
                    <span className="booking-card-room">{formatDate(b.created_at)}</span>
                  </div>
                  <div className="booking-card-right">
                    <span className={`status-badge ${b.status.toLowerCase()}`}>{b.status}</span>
                    <span className="booking-card-arrow">›</span>
                  </div>
                </button>
                {expanded && (
                  <div className="booking-card-details">
                    <div className="booking-card-row"><span>Token</span><span>{b.token}</span></div>
                    <div className="booking-card-row"><span>Source</span><span>{b.source === 'ROOM' ? '🛏️ Hotel' : '🍽️ Food'}</span></div>
                    <div className="booking-card-row"><span>Payment</span><span>{b.payment_method}</span></div>
                    <div className="fm-row-actions">
                      <button className="btn-link" onClick={() => window.api.openBillWindow(b.id)}>View</button>
                      {b.status === 'COMPLETED' && (
                        <button className="btn-link danger" onClick={() => setCancelId(b.id)}>Cancel</button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {bills.length === 0 && <p className="empty-state small">No bills yet.</p>}
        </div>
        {bills.length > BILLS_PAGE_SIZE && (
          <div className="sales-history-pagination">
            <button
              className="btn btn-secondary"
              disabled={safeBillsPage === 0}
              onClick={() => setBillsPage((p) => Math.max(0, p - 1))}
            >
              ← Previous
            </button>
            <span>Page {safeBillsPage + 1} of {billsTotalPages}</span>
            <button
              className="btn btn-secondary"
              disabled={safeBillsPage >= billsTotalPages - 1}
              onClick={() => setBillsPage((p) => Math.min(billsTotalPages - 1, p + 1))}
            >
              Next →
            </button>
          </div>
        )}
      </div>

      {cancelId && (
        <div className="modal-overlay">
          <div className="modal">
            <h4>Cancel this bill?</h4>
            <p>This marks the order as cancelled in sales history. This cannot be undone.</p>
            <input
              className="customer-input"
              placeholder="Reason (optional)"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setCancelId(null)}>Keep Bill</button>
              <button className="btn btn-danger" onClick={confirmCancel}>Yes, Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
