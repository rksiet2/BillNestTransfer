import React, { useState, useRef } from 'react';
import { parseMenuText } from '../../utils/menuParser';
import { APP_NAME } from '../../constants/brand';

// "Scan Menu → Bulk Add Items": owner uploads/photographs an existing paper
// menu, we run OCR (Tesseract.js, runs fully in-browser/renderer — no
// server needed) on the image, then heuristically split the recognised
// text into name+price rows (see menuParser.js) grouped under any detected
// category headings. Nothing is auto-saved — the owner reviews/edits every
// row (name, price, category, include/exclude) before confirming, since
// OCR on real-world menus (multi-column layouts, decorative fonts) is
// rarely perfect.
//
// Note: the very first scan on a given PC needs an internet connection —
// Tesseract.js downloads its ~2-4MB OCR engine + language data once and
// caches it in the app's local storage; every scan after that works fully
// offline.
export default function ScanMenuModal({ categories, onClose, onSaved, onCategoriesChanged }) {
  const [imagePreview, setImagePreview] = useState(null);
  const [imageFile, setImageFile] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | scanning | review | saving
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);
  const fileInputRef = useRef(null);

  function handlePickFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  }

  async function handleScan() {
    if (!imageFile) return;
    setStatus('scanning');
    setProgress(0);
    setError('');
    try {
      // tesseract.js is an optional heavy OCR dependency that may not be
      // installed on every machine (e.g. this dev environment can't install
      // new npm packages). Building the specifier from two pieces at
      // runtime — instead of a literal import('tesseract.js') — stops
      // Vite/Rolldown's import-analysis from trying to statically resolve
      // and bundle it, which would otherwise break the ENTIRE app at
      // dev-server/build time for everyone, even people who never use Scan
      // Menu. `/* @vite-ignore */` alone wasn't enough to suppress that in
      // this Vite version. It's now only ever touched when Scan Menu is
      // actually clicked, and the catch below shows a clean error if it's
      // genuinely missing on this machine.
      const tesseractPkg = ['tesseract', 'js'].join('.');
      const { createWorker } = await import(/* @vite-ignore */ tesseractPkg);
      const worker = await createWorker('eng', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') setProgress(Math.round((m.progress || 0) * 100));
        },
      });
      const { data } = await worker.recognize(imageFile);
      await worker.terminate();
      const detected = parseMenuText(data.text, categories);
      if (detected.length === 0) {
        setError('No menu items could be detected in this image. Try a clearer, well-lit photo, or add items manually below.');
      }
      setRows(detected.map((d, i) => ({
        key: i,
        include: true,
        name: d.name,
        price: String(d.price),
        categoryId: d.categoryId ? String(d.categoryId) : '',
        categoryGuess: d.categoryGuess,
      })));
      setStatus('review');
    } catch (err) {
      setError(`Scan failed: ${err.message || err}. Please check your internet connection (needed the first time) and try again.`);
      setStatus('idle');
    }
  }

  function updateRow(key, patch) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeRow(key) {
    setRows((rs) => rs.filter((r) => r.key !== key));
  }

  function addBlankRow() {
    setRows((rs) => [...rs, { key: Date.now(), include: true, name: '', price: '', categoryId: '', categoryGuess: '' }]);
  }

  async function handleSaveAll() {
    const toSave = rows.filter((r) => r.include && r.name.trim() && r.price !== '' && r.categoryId);
    if (toSave.length === 0) {
      setError('Select at least one item with a name, price and category before saving.');
      return;
    }
    setStatus('saving');
    setError('');
    try {
      for (const r of toSave) {
        await window.api.saveFood({
          id: null,
          name: r.name.trim(),
          category_id: Number(r.categoryId),
          price: parseFloat(r.price),
          image_path: '',
          is_veg: true,
          available: true,
        });
      }
      onSaved?.(toSave.length);
      onClose?.();
    } catch (err) {
      setError(`Could not save items: ${err.message || err}`);
      setStatus('review');
    }
  }

  const readyCount = rows.filter((r) => r.include && r.name.trim() && r.price !== '' && r.categoryId).length;

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal modal-wide">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h3>📷 Scan Menu — Bulk Add Items</h3>

        {status === 'idle' && (
          <div className="scan-menu-upload">
            <p className="settings-sub">
              Upload a photo of an existing menu. {APP_NAME} extracts the text and pre-fills an item list
              for review before adding — faster than manual entry.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handlePickFile}
            />
            {imagePreview && (
              <div className="scan-menu-preview">
                <img src={imagePreview} alt="Menu preview" />
              </div>
            )}
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={!imageFile} onClick={handleScan}>
                Scan Image
              </button>
            </div>
          </div>
        )}

        {status === 'scanning' && (
          <div className="scan-menu-progress">
            <p className="settings-sub">Reading your menu… {progress}%</p>
            <div className="scan-progress-bar"><div className="scan-progress-fill" style={{ width: `${progress}%` }} /></div>
          </div>
        )}

        {(status === 'review' || status === 'saving') && (
          <div className="scan-menu-review">
            <p className="settings-sub">
              Found {rows.length} possible item{rows.length === 1 ? '' : 's'}. Uncheck anything wrong, fix names/prices/categories,
              or add a row manually — then save.
            </p>
            {error && <div className="form-error">{error}</div>}
            <div className="scan-menu-rows">
              {rows.map((r) => (
                <div className={`scan-menu-row${r.include ? '' : ' excluded'}`} key={r.key}>
                  <input
                    type="checkbox"
                    checked={r.include}
                    onChange={(e) => updateRow(r.key, { include: e.target.checked })}
                    title="Include this item"
                  />
                  <input
                    className="scan-menu-name"
                    value={r.name}
                    onChange={(e) => updateRow(r.key, { name: e.target.value })}
                    placeholder="Item name"
                  />
                  <input
                    className="scan-menu-price"
                    type="number"
                    min="0"
                    step="0.5"
                    value={r.price}
                    onChange={(e) => updateRow(r.key, { price: e.target.value })}
                    placeholder="Price"
                  />
                  <select
                    className="scan-menu-category"
                    value={r.categoryId}
                    onChange={async (e) => {
                      if (e.target.value === '__new__') {
                        const name = window.prompt('New category name:', r.categoryGuess || '');
                        if (name && name.trim()) {
                          const created = await window.api.addCategory(name.trim());
                          await onCategoriesChanged?.();
                          updateRow(r.key, { categoryId: created?.id ? String(created.id) : r.categoryId });
                        }
                        return;
                      }
                      updateRow(r.key, { categoryId: e.target.value });
                    }}
                  >
                    <option value="">
                      {r.categoryGuess ? `Select category (guessed: ${r.categoryGuess})` : 'Select category'}
                    </option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                    <option value="__new__">+ New category…</option>
                  </select>
                  <button type="button" className="btn-link danger" onClick={() => removeRow(r.key)} title="Remove row">✕</button>
                </div>
              ))}
            </div>
            <button type="button" className="btn btn-secondary btn-small" onClick={addBlankRow}>+ Add Row Manually</button>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={status === 'saving'}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={handleSaveAll} disabled={status === 'saving' || readyCount === 0}>
                {status === 'saving' ? 'Saving…' : `Add ${readyCount} Item${readyCount === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
