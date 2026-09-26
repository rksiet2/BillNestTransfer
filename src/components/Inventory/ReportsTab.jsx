import React, { useEffect, useState, useCallback } from 'react';
import { formatCurrency } from '../../utils/format';
import TrendChart from '../Reporting/TrendChart';

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Weekly' },
  { key: 'month', label: 'Monthly' },
  { key: 'year', label: 'Annually' },
  { key: 'all', label: 'All Time' },
  { key: 'custom', label: '📅 Custom Range' },
];

function todayStr() {
  return new Date().toLocaleDateString('en-CA');
}

export default function ReportsTab() {
  const [period, setPeriod] = useState('today');
  const [customFrom, setCustomFrom] = useState(todayStr());
  const [customTo, setCustomTo] = useState(todayStr());
  const [summary, setSummary] = useState(null);
  const [trend, setTrend] = useState([]);

  const isCustom = period === 'custom';
  const payload = isCustom ? { period: 'custom', from: customFrom, to: customTo } : period;

  const load = useCallback(async () => {
    if (isCustom && (!customFrom || !customTo || customFrom > customTo)) return;
    const [s, t] = await Promise.all([
      window.api.getPurchaseSummary(payload),
      window.api.getPurchaseTrend(payload),
    ]);
    setSummary(s);
    setTrend(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customFrom, customTo]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="reporting-page">
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
            <span className="stat-label">Total Spend</span>
            <span className="stat-value">{formatCurrency(summary.totalSpend)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Purchases</span>
            <span className="stat-value">{summary.purchaseCount}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Avg. Purchase</span>
            <span className="stat-value">{formatCurrency(summary.avgPurchase)}</span>
          </div>
        </div>
      )}

      <div className="report-grid">
        <div className="report-card">
          <h4>Purchase Spend Trend</h4>
          <TrendChart trend={trend} unitLabel="purchase" />
        </div>

        <div className="report-card">
          <h4>Top Items by Spend</h4>
          <table className="fm-table">
            <thead>
              <tr><th>Item</th><th>Qty Purchased</th><th>Spend</th></tr>
            </thead>
            <tbody>
              {summary?.topItems?.map((it) => (
                <tr key={it.name}>
                  <td>{it.name}</td>
                  <td>{it.qty}</td>
                  <td>{formatCurrency(it.spend)}</td>
                </tr>
              ))}
              {(!summary?.topItems || summary.topItems.length === 0) && (
                <tr><td colSpan={3} className="empty-state small">No purchases recorded for this period.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

