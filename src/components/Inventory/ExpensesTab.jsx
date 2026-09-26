import React, { useEffect, useState, useCallback } from 'react';
import { formatCurrency, formatDate } from '../../utils/format';

const CATEGORIES = [
  { key: 'SALARY', label: '🧑‍💼 Salary' },
  { key: 'RENT', label: '🏠 Rent' },
  { key: 'UTILITIES', label: '💡 Utilities' },
  { key: 'MAINTENANCE', label: '🔧 Maintenance' },
  { key: 'OTHER', label: '📋 Other' },
];

const emptyForm = { category: 'SALARY', paid_to: '', amount: '', payment_method: 'CASH', notes: '' };

export default function ExpensesTab({ onChanged }) {
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadHistory = useCallback(() => window.api.getExpenseHistory({}).then((rows) => setHistory(rows.slice(0, 30))), []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.amount || Number(form.amount) <= 0) return;
    setSaving(true);
    setError('');
    try {
      await window.api.recordExpense({
        category: form.category,
        paid_to: form.paid_to,
        amount: parseFloat(form.amount),
        payment_method: form.payment_method,
        notes: form.notes,
      });
      setForm(emptyForm);
      loadHistory();
      onChanged?.();
    } catch (err) {
      setError(err.message || 'Could not record this expense.');
    } finally {
      setSaving(false);
    }
  }

  const categoryLabel = (key) => CATEGORIES.find((c) => c.key === key)?.label || key;

  return (
    <div className="food-management">
      <div className="fm-form-card">
        <h3>Record an Expense</h3>
        <p className="settings-sub">Log salary, rent, utilities & other spend so it shows up in Profit &amp; Loss.</p>
        <form onSubmit={handleSubmit} className="fm-form">
          <label>
            Category
            <select value={form.category} onChange={(e) => update('category', e.target.value)} required>
              {CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </label>
          <label>
            Paid To (employee / vendor name — optional)
            <input value={form.paid_to} onChange={(e) => update('paid_to', e.target.value)} placeholder="e.g. Ramesh (Chef)" />
          </label>
          <label>
            Amount (₹)
            <input type="number" min="0" step="0.01" value={form.amount} onChange={(e) => update('amount', e.target.value)} required />
          </label>
          <label>
            Payment Method
            <select value={form.payment_method} onChange={(e) => update('payment_method', e.target.value)}>
              <option value="CASH">Cash</option>
              <option value="ONLINE">Online</option>
            </select>
          </label>
          <label>
            Notes (optional)
            <input value={form.notes} onChange={(e) => update('notes', e.target.value)} />
          </label>
          <div className="fm-form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : '+ Record Expense'}
            </button>
          </div>
          {error && <div className="form-error">{error}</div>}
        </form>
      </div>

      <div className="fm-list-card">
        <div className="fm-list-header">
          <h3>Recent Expenses</h3>
        </div>
        <div className="fm-table-wrapper expenses-desktop-table">
          <table className="fm-table">
            <thead>
              <tr><th>Date</th><th>Category</th><th>Paid To</th><th>Amount</th><th>Method</th><th>Notes</th></tr>
            </thead>
            <tbody>
              {history.map((ex) => (
                <tr key={ex.id}>
                  <td>{formatDate(ex.created_at)}</td>
                  <td>{categoryLabel(ex.category)}</td>
                  <td>{ex.paid_to || '-'}</td>
                  <td>{formatCurrency(ex.amount)}</td>
                  <td>{ex.payment_method}</td>
                  <td>{ex.notes || '-'}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td colSpan={6} className="empty-state small">No expenses recorded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile-only: always-visible compact cards — read-only history
            with no row actions, so there's nothing worth hiding. */}
        <div className="expenses-mobile-cards">
          {history.map((ex) => (
            <div className="simple-card" key={ex.id}>
              <div className="simple-card-top">
                <span className="simple-card-title">{categoryLabel(ex.category)}</span>
                <span className="dim">{formatDate(ex.created_at)}</span>
              </div>
              <div className="simple-card-row"><span>Paid To</span><span>{ex.paid_to || '-'}</span></div>
              <div className="simple-card-row"><span>Amount</span><span>{formatCurrency(ex.amount)}</span></div>
              <div className="simple-card-row"><span>Method</span><span>{ex.payment_method}</span></div>
              <div className="simple-card-row"><span>Notes</span><span>{ex.notes || '-'}</span></div>
            </div>
          ))}
          {history.length === 0 && <p className="empty-state small">No expenses recorded yet.</p>}
        </div>
      </div>
    </div>
  );
}
