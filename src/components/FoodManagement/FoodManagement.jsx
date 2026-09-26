import React, { useEffect, useState, useCallback } from 'react';
import FoodImage from '../common/FoodImage';
import { formatCurrency } from '../../utils/format';
import ScanMenuModal from './ScanMenuModal';

const emptyForm = { id: null, name: '', category_id: '', price: '', image_path: '', is_veg: true, available: true };

export default function FoodManagement() {
  const [categories, setCategories] = useState([]);
  const [foods, setFoods] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [newCategory, setNewCategory] = useState('');
  const [filterCategory, setFilterCategory] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [showScanModal, setShowScanModal] = useState(false);
  const [scanToast, setScanToast] = useState('');
  const [error, setError] = useState('');

  const loadCategories = useCallback(() => window.api.listCategories().then(setCategories), []);
  const loadFoods = useCallback(() => {
    window.api.listFood({ categoryId: filterCategory || undefined }).then(setFoods);
  }, [filterCategory]);

  useEffect(() => { loadCategories(); }, [loadCategories]);
  useEffect(() => { loadFoods(); }, [loadFoods]);

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handlePickImage() {
    const filePath = await window.api.pickImage();
    if (filePath) update('image_path', filePath);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name || !form.category_id || form.price === '') return;
    setError('');
    try {
      await window.api.saveFood({
        id: form.id,
        name: form.name,
        category_id: Number(form.category_id),
        price: parseFloat(form.price),
        image_path: form.image_path,
        is_veg: form.is_veg,
        available: form.available,
      });
      setForm(emptyForm);
      loadFoods();
    } catch (err) {
      setError(err.message || 'Could not save this food item.');
    }
  }

  function handleEdit(food) {
    setForm({
      id: food.id,
      name: food.name,
      category_id: food.category_id,
      price: food.price,
      image_path: food.image_path || '',
      is_veg: !!food.is_veg,
      available: !!food.available,
    });
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this food item?')) return;
    setError('');
    try {
      await window.api.deleteFood(id);
      loadFoods();
    } catch (err) {
      setError(err.message || 'Could not delete this food item.');
    }
  }

  async function handleAddCategory(e) {
    e.preventDefault();
    if (!newCategory.trim()) return;
    await window.api.addCategory(newCategory.trim());
    setNewCategory('');
    loadCategories();
  }

  return (
    <div className="food-management">
      <div className="fm-form-card">
        <h3>{form.id ? 'Edit Food Item' : 'Add New Food Item'}</h3>
        <form onSubmit={handleSubmit} className="fm-form">
          <label>
            Name
            <input value={form.name} onChange={(e) => update('name', e.target.value)} required />
          </label>
          <label>
            Category
            <select value={form.category_id} onChange={(e) => update('category_id', e.target.value)} required>
              <option value="">Select category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label>
            Price (₹)
            <input type="number" min="0" step="0.5" value={form.price} onChange={(e) => update('price', e.target.value)} required />
          </label>
          <div className="fm-image-row">
            <FoodImage src={form.image_path} alt="preview" size={56} />
            <button type="button" className="btn btn-secondary" onClick={handlePickImage}>
              Choose Image
            </button>
          </div>
          <div className="fm-food-type-row">
            <span className="fm-food-type-label">Type</span>
            <label className="radio-label">
              <input type="radio" name="foodType" checked={form.is_veg} onChange={() => update('is_veg', true)} />
              <span className="veg-badge veg-badge-inline veg" aria-hidden="true"><span className="veg-badge-dot" /></span> Veg
            </label>
            <label className="radio-label">
              <input type="radio" name="foodType" checked={!form.is_veg} onChange={() => update('is_veg', false)} />
              <span className="veg-badge veg-badge-inline nonveg" aria-hidden="true"><span className="veg-badge-dot" /></span> Non-Veg
            </label>
          </div>
          <label className="checkbox-label">
            <input type="checkbox" checked={form.available} onChange={(e) => update('available', e.target.checked)} />
            Available
          </label>
          {error && <div className="form-error">{error}</div>}
          <div className="fm-form-actions">
            {form.id && (
              <button type="button" className="btn btn-secondary" onClick={() => setForm(emptyForm)}>
                Cancel Edit
              </button>
            )}
            <button type="submit" className="btn btn-primary">{form.id ? 'Update Item' : 'Add Item'}</button>
          </div>
        </form>

        <form onSubmit={handleAddCategory} className="fm-category-form">
          <input
            placeholder="New category name"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
          />
          <button type="submit" className="btn btn-secondary">+ Add Category</button>
        </form>
      </div>

      <div className="fm-list-card">
        <div className="fm-list-header">
          <h3>Menu Items ({foods.length})</h3>
          <div className="fm-list-header-actions">
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setShowScanModal(true)}>
              📷 Scan Menu (Bulk Add)
            </button>
            <select value={filterCategory || ''} onChange={(e) => setFilterCategory(e.target.value || null)}>
              <option value="">All Categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="fm-table-wrapper food-desktop-table">
          <table className="fm-table">
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Category</th>
                <th>Price</th>
                <th>Veg / Non-Veg</th>
                <th>Available</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {foods.map((f) => (
                <tr key={f.id}>
                  <td><FoodImage src={f.image_path} alt={f.name} size={40} /></td>
                  <td>{f.name}</td>
                  <td>{f.category_name}</td>
                  <td>{formatCurrency(f.price)}</td>
                  <td>
                    <span className={`veg-badge veg-badge-inline ${f.is_veg ? 'veg' : 'nonveg'}`} title={f.is_veg ? 'Veg' : 'Non-Veg'}>
                      <span className="veg-badge-dot" />
                    </span>
                    {' '}{f.is_veg ? 'Veg' : 'Non-Veg'}
                  </td>
                  <td>{f.available ? 'Yes' : 'No'}</td>
                  <td>
                    <div className="fm-row-actions">
                      <button className="btn-link" onClick={() => handleEdit(f)}>Edit</button>
                      <button className="btn-link danger" onClick={() => handleDelete(f.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="food-mobile-cards">
          {foods.map((f) => {
            const expanded = expandedId === f.id;
            return (
              <div className={`booking-card${expanded ? ' expanded' : ''}`} key={f.id}>
                <button
                  type="button"
                  className="booking-card-summary"
                  onClick={() => setExpandedId(expanded ? null : f.id)}
                >
                  <FoodImage src={f.image_path} alt={f.name} size={40} />
                  <div className="booking-card-main">
                    <span className="booking-card-guest">{f.name}</span>
                    <span className="booking-card-room">{f.category_name} · {formatCurrency(f.price)}</span>
                  </div>
                  <div className="booking-card-right">
                    <span className={`veg-badge veg-badge-inline ${f.is_veg ? 'veg' : 'nonveg'}`} title={f.is_veg ? 'Veg' : 'Non-Veg'}>
                      <span className="veg-badge-dot" />
                    </span>
                    <span className="booking-card-arrow">›</span>
                  </div>
                </button>
                {expanded && (
                  <div className="booking-card-details">
                    <div className="booking-card-row"><span>Category</span><span>{f.category_name}</span></div>
                    <div className="booking-card-row"><span>Price</span><span>{formatCurrency(f.price)}</span></div>
                    <div className="booking-card-row"><span>Type</span><span>{f.is_veg ? 'Veg' : 'Non-Veg'}</span></div>
                    <div className="booking-card-row"><span>Available</span><span>{f.available ? 'Yes' : 'No'}</span></div>
                    <div className="fm-row-actions">
                      <button className="btn-link" onClick={() => handleEdit(f)}>Edit</button>
                      <button className="btn-link danger" onClick={() => handleDelete(f.id)}>Delete</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {showScanModal && (
        <ScanMenuModal
          categories={categories}
          onCategoriesChanged={loadCategories}
          onClose={() => setShowScanModal(false)}
          onSaved={(count) => {
            loadFoods();
            setScanToast(`✅ Added ${count} item${count === 1 ? '' : 's'} from the scanned menu.`);
            setTimeout(() => setScanToast(''), 4000);
          }}
        />
      )}
      {scanToast && <div className="toast-success">{scanToast}</div>}
    </div>
  );
}
