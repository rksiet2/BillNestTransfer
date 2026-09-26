import React, { useEffect, useState, useCallback } from 'react';
import { formatCurrency } from '../../utils/format';

// Simple catalog of things you buy (vegetables, gas, packaging, etc.) — no stock
// quantity/threshold here. The only purpose of this module is to track how much
// money is being spent on purchases, not to manage on-hand inventory levels.
const emptyForm = { id: null, name: '', unit: 'kg' };

export default function RawMaterialsTab({ onChanged }) {
  const [materials, setMaterials] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');

  const load = useCallback(() => window.api.listRawMaterials().then(setMaterials), []);
  useEffect(() => { load(); }, [load]);

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name) return;
    setError('');
    try {
      await window.api.saveRawMaterial({ id: form.id, name: form.name, unit: form.unit });
      setForm(emptyForm);
      load();
      onChanged?.();
    } catch (err) {
      setError(err.message || 'Could not save this purchase item.');
    }
  }

  function handleEdit(m) {
    setForm({ id: m.id, name: m.name, unit: m.unit });
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this purchase item? Its past purchase history is kept, but it will no longer be selectable for new purchases.')) return;
    setError('');
    try {
      await window.api.deleteRawMaterial(id);
      load();
      onChanged?.();
    } catch (err) {
      setError(err.message || 'Could not delete this purchase item.');
    }
  }

  return (
    <div className="food-management">
      <div className="fm-form-card">
        <h3>{form.id ? 'Edit Purchase Item' : 'Add Purchase Item'}</h3>
        <p className="settings-sub">Just a name &amp; unit so you can pick it quickly when recording a purchase.</p>
        <form onSubmit={handleSubmit} className="fm-form">
          <label>
            Name
            <input value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="e.g. Chicken, Cooking Gas, Packaging Boxes" required />
          </label>
          <label>
            Unit
            <select value={form.unit} onChange={(e) => update('unit', e.target.value)}>
              <option value="kg">kg</option>
              <option value="g">g</option>
              <option value="ltr">ltr</option>
              <option value="ml">ml</option>
              <option value="pcs">pcs</option>
            </select>
          </label>
          <div className="fm-form-actions">
            {form.id && (
              <button type="button" className="btn btn-secondary" onClick={() => setForm(emptyForm)}>Cancel Edit</button>
            )}
            <button type="submit" className="btn btn-primary">{form.id ? 'Update' : '+ Add Item'}</button>
          </div>
          {error && <div className="form-error">{error}</div>}
        </form>
      </div>

      <div className="fm-list-card">
        <div className="fm-list-header">
          <h3>Purchase Items ({materials.length})</h3>
        </div>
        <div className="fm-table-wrapper rawmaterials-desktop-table">
          <table className="fm-table">
            <thead>
              <tr><th>Name</th><th>Unit</th><th>Last Cost/Unit</th><th></th></tr>
            </thead>
            <tbody>
              {materials.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.unit}</td>
                  <td>{formatCurrency(m.cost_per_unit)}</td>
                  <td>
                    <div className="fm-row-actions">
                      <button className="btn-link" onClick={() => handleEdit(m)}>Edit</button>
                      <button className="btn-link danger" onClick={() => handleDelete(m.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
              {materials.length === 0 && (
                <tr><td colSpan={4} className="empty-state small">No purchase items yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile-only: always-visible compact cards — only 3 short fields,
            nothing worth hiding behind a tap. */}
        <div className="rawmaterials-mobile-cards">
          {materials.map((m) => (
            <div className="simple-card" key={m.id}>
              <div className="simple-card-top">
                <span className="simple-card-title">{m.name}</span>
                <span className="dim">{m.unit}</span>
              </div>
              <div className="simple-card-row"><span>Last Cost/Unit</span><span>{formatCurrency(m.cost_per_unit)}</span></div>
              <div className="fm-row-actions">
                <button className="btn-link" onClick={() => handleEdit(m)}>Edit</button>
                <button className="btn-link danger" onClick={() => handleDelete(m.id)}>Delete</button>
              </div>
            </div>
          ))}
          {materials.length === 0 && <p className="empty-state small">No purchase items yet.</p>}
        </div>
      </div>
    </div>
  );
}
