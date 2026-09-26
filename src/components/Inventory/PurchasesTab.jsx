import React, { useEffect, useState, useCallback } from 'react';
import { formatCurrency, formatDate } from '../../utils/format';

const emptyForm = { raw_material_id: '', quantity: '', cost_per_unit: '', supplier: '', notes: '' };

export default function PurchasesTab({ onChanged }) {
  const [materials, setMaterials] = useState([]);
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadMaterials = useCallback(() => window.api.listRawMaterials().then(setMaterials), []);
  const loadHistory = useCallback(() => window.api.getPurchaseHistory({}).then((rows) => setHistory(rows.slice(0, 30))), []);

  useEffect(() => { loadMaterials(); loadHistory(); }, [loadMaterials, loadHistory]);

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.raw_material_id || !form.quantity || !form.cost_per_unit) return;
    setSaving(true);
    setError('');
    try {
      await window.api.recordPurchase({
        raw_material_id: Number(form.raw_material_id),
        quantity: parseFloat(form.quantity),
        cost_per_unit: parseFloat(form.cost_per_unit),
        supplier: form.supplier,
        notes: form.notes,
      });
      setForm(emptyForm);
      loadMaterials();
      loadHistory();
      onChanged?.();
    } catch (err) {
      setError(err.message || 'Could not record this purchase.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="food-management">
      <div className="fm-form-card">
        <h3>Record a Purchase</h3>
        <p className="settings-hint">Log what you spent so it shows up in Purchase Reports.</p>
        <form onSubmit={handleSubmit} className="fm-form">
          <label>
            Purchase Item
            <select value={form.raw_material_id} onChange={(e) => update('raw_material_id', e.target.value)} required>
              <option value="">Select item</option>
              {materials.map((m) => (
                <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>
              ))}
            </select>
          </label>
          <label>
            Quantity Purchased
            <input type="number" min="0" step="0.01" value={form.quantity} onChange={(e) => update('quantity', e.target.value)} required />
          </label>
          <label>
            Cost per Unit (₹)
            <input type="number" min="0" step="0.01" value={form.cost_per_unit} onChange={(e) => update('cost_per_unit', e.target.value)} required />
          </label>
          <label>
            Supplier (optional)
            <input value={form.supplier} onChange={(e) => update('supplier', e.target.value)} placeholder="e.g. Local Vegetable Market" />
          </label>
          <label>
            Notes (optional)
            <input value={form.notes} onChange={(e) => update('notes', e.target.value)} />
          </label>
          <div className="fm-form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : '+ Record Purchase'}
            </button>
          </div>
          {error && <div className="form-error">{error}</div>}
        </form>
      </div>

      <div className="fm-list-card">
        <div className="fm-list-header">
          <h3>Recent Purchases</h3>
        </div>
        <div className="fm-table-wrapper purchases-desktop-table">
          <table className="fm-table">
            <thead>
              <tr><th>Date</th><th>Material</th><th>Qty</th><th>Cost/Unit</th><th>Total</th><th>Supplier</th></tr>
            </thead>
            <tbody>
              {history.map((p) => (
                <tr key={p.id}>
                  <td>{formatDate(p.created_at)}</td>
                  <td>{p.material_name}</td>
                  <td>{p.quantity} {p.unit}</td>
                  <td>{formatCurrency(p.cost_per_unit)}</td>
                  <td>{formatCurrency(p.total_cost)}</td>
                  <td>{p.supplier || '-'}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td colSpan={6} className="empty-state small">No purchases recorded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile-only: always-visible compact cards — read-only history
            with no row actions, so there's nothing worth hiding. */}
        <div className="purchases-mobile-cards">
          {history.map((p) => (
            <div className="simple-card" key={p.id}>
              <div className="simple-card-top">
                <span className="simple-card-title">{p.material_name}</span>
                <span className="dim">{formatDate(p.created_at)}</span>
              </div>
              <div className="simple-card-row"><span>Qty</span><span>{p.quantity} {p.unit}</span></div>
              <div className="simple-card-row"><span>Cost/Unit</span><span>{formatCurrency(p.cost_per_unit)}</span></div>
              <div className="simple-card-row"><span>Total</span><span>{formatCurrency(p.total_cost)}</span></div>
              <div className="simple-card-row"><span>Supplier</span><span>{p.supplier || '-'}</span></div>
            </div>
          ))}
          {history.length === 0 && <p className="empty-state small">No purchases recorded yet.</p>}
        </div>
      </div>
    </div>
  );
}
