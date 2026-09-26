import React, { useState, useEffect } from 'react';
import TaxRateSelect from '../common/TaxRateSelect';
import FoodImage from '../common/FoodImage';

const BLANK_FORM = {
  hotel_name: '',
  hotel_address: '',
  hotel_phone: '',
  hotel_gstin: '',
  bill_footer: '',
  tax_percent: '5',
  tax_percent_cash: '5',
  tax_percent_online: '5',
  upi_id: '',
  room_biz_name: '',
  room_biz_address: '',
  room_biz_phone: '',
  room_biz_gstin: '',
  room_bill_footer: '',
  room_upi_id: '',
  room_tax_percent_cash: '0',
  room_tax_percent_online: '0',
  room_biz_logo_path: '',
};

// Reusable form for the business details printed on invoices. Used both by
// the first-run Setup Wizard and the regular Settings screen.
//
// Food Billing (`hotel_name`/`hotel_address`/etc.) and Room Booking
// (`room_biz_*`) are deliberately TWO SEPARATE business identities — a
// restaurant and a hotel can be different legal entities with their own
// name, GSTIN, footer message and UPI ID, even when run from the same
// install. `showFood`/`showRooms` (driven by this install's license — see
// App.jsx's `licensedFood`/`licensedRooms`) decide which section(s) appear;
// a Food-Billing-only or Hotel-Billing-only license only ever shows its own
// section, so nobody edits details for a module they haven't bought.
export default function SettingsForm({ initial, onSave, mode = 'edit', onCancel, showFood = true, showRooms = true }) {
  const [form, setForm] = useState(BLANK_FORM);
  const [saving, setSaving] = useState(null); // null | 'food' | 'rooms' | 'both' — tracks which section's Save button is spinning
  const [savedSection, setSavedSection] = useState(null);
  // Setup Wizard (mode="setup") still uses a single dropdown + one combined
  // Save button — a first-run onboarding flow shouldn't ask the owner to
  // save two separate forms before they can even get into the app. The
  // regular Settings screen (mode="edit"), when BOTH modules are licensed,
  // instead shows both profiles as independently expandable sections with
  // their own Save button (see dualEditMode below) so editing one business's
  // details never risks accidentally resubmitting the other's.
  const dualEditMode = mode === 'edit' && showFood && showRooms;
  const [activeSection, setActiveSection] = useState(showFood ? 'food' : 'rooms');
  const [expanded, setExpanded] = useState({ food: true, rooms: false });

  useEffect(() => {
    if (initial) {
      setForm((f) => ({
        ...f,
        hotel_name: initial.hotel_name || '',
        hotel_address: initial.hotel_address || '',
        hotel_phone: initial.hotel_phone || '',
        hotel_gstin: initial.hotel_gstin || '',
        bill_footer: initial.bill_footer || '',
        tax_percent: initial.tax_percent || '5',
        tax_percent_cash: initial.tax_percent_cash ?? initial.tax_percent ?? '5',
        tax_percent_online: initial.tax_percent_online ?? initial.tax_percent ?? '5',
        upi_id: initial.upi_id || '',
        room_biz_name: initial.room_biz_name || '',
        room_biz_address: initial.room_biz_address || '',
        room_biz_phone: initial.room_biz_phone || '',
        room_biz_gstin: initial.room_biz_gstin || '',
        room_bill_footer: initial.room_bill_footer || '',
        room_upi_id: initial.room_upi_id || '',
        room_tax_percent_cash: initial.room_tax_percent_cash ?? '0',
        room_tax_percent_online: initial.room_tax_percent_online ?? '0',
        room_biz_logo_path: initial.room_biz_logo_path || '',
      }));
    }
  }, [initial]);

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Reuses the same generic image-file picker as Food Management's "Choose
  // Image" — it just returns an OS file path, no food-specific logic.
  async function handlePickLogo() {
    const filePath = await window.api.pickImage();
    if (filePath) update('room_biz_logo_path', filePath);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving('both');
    try {
      await onSave({ ...form, setup_completed: 'true' });
    } finally {
      setSaving(null);
    }
  }

  // Dual-edit mode's per-section Save buttons — each just saves the CURRENT
  // full form snapshot (identical payload either button would send; Settings
  // has no per-key partial-save endpoint), but distinctly labelled/scoped so
  // an owner editing only the Restaurant section isn't left wondering
  // whether clicking Save also touched their separately-priced Hotel profile.
  async function handleSectionSave(section) {
    setSaving(section);
    try {
      await onSave({ ...form, setup_completed: 'true' });
      setSavedSection(section);
      setTimeout(() => setSavedSection(null), 2500);
    } finally {
      setSaving(null);
    }
  }

  function toggleExpanded(section) {
    setExpanded((prev) => ({ ...prev, [section]: !prev[section] }));
  }

  return (
    <form className="settings-form" onSubmit={dualEditMode ? (e) => e.preventDefault() : handleSubmit}>
      {mode === 'setup' && (
        <p className="settings-intro">
          Welcome! Enter your business details below. These appear on every printed bill and can be
          changed anytime later from <strong>Settings</strong>.
        </p>
      )}

      {!dualEditMode && showFood && showRooms && (
        <label className="settings-section-picker">
          Which business's details?
          <select value={activeSection} onChange={(e) => setActiveSection(e.target.value)}>
            <option value="food">🍽️ Restaurant / Food Billing</option>
            <option value="rooms">🏨 Hotel / Room Booking</option>
          </select>
        </label>
      )}

      {dualEditMode && showFood && (
        <button
          type="button"
          className="settings-section-toggle"
          onClick={() => toggleExpanded('food')}
          aria-expanded={expanded.food}
        >
          {expanded.food ? '▾' : '▸'} 🍽️ Restaurant / Food Billing
        </button>
      )}

      {showFood && (dualEditMode ? expanded.food : (!showRooms || activeSection === 'food')) && (
        <fieldset className="settings-fieldset">
          <label>
            Restaurant Name
            <input
              value={form.hotel_name}
              placeholder="e.g. Green Leaf Restaurant"
              onChange={(e) => update('hotel_name', e.target.value)}
              required
            />
          </label>

          <label>
            Address
            <textarea
              value={form.hotel_address}
              placeholder="e.g. 123, Main Street, Your City, State - 000000"
              onChange={(e) => update('hotel_address', e.target.value)}
              rows={2}
            />
          </label>

          <div className="settings-row">
            <label>
              Phone Number
              <input
                value={form.hotel_phone}
                placeholder="e.g. +91 90000 00000"
                onChange={(e) => update('hotel_phone', e.target.value)}
              />
            </label>
            <label>
              GSTIN / Tax ID (optional)
              <input
                value={form.hotel_gstin}
                placeholder="e.g. GSTIN: 00AAAAA0000A1Z5"
                onChange={(e) => update('hotel_gstin', e.target.value)}
              />
            </label>
          </div>

          <div className="settings-group">
            <span className="settings-group-label">Tax / GST Rate</span>
            <div className="settings-row">
              <TaxRateSelect
                label="Cash"
                value={form.tax_percent_cash}
                onChange={(v) => update('tax_percent_cash', v)}
              />
              <TaxRateSelect
                label="Online (UPI/Card)"
                value={form.tax_percent_online}
                onChange={(v) => update('tax_percent_online', v)}
              />
            </div>
          </div>

          <div className="settings-row">
            <label>
              Bill Footer Message
              <input
                value={form.bill_footer}
                placeholder="e.g. Thank you! Visit again."
                onChange={(e) => update('bill_footer', e.target.value)}
              />
            </label>
          </div>

          <label>
            UPI ID for Online Payments (for bill QR code)
            <input
              value={form.upi_id}
              placeholder="e.g. yourrestaurant@okaxis"
              onChange={(e) => update('upi_id', e.target.value)}
            />
          </label>

          {dualEditMode && (
            <div className="modal-actions fm-form-actions-center">
              <button type="button" className="btn btn-primary" onClick={() => handleSectionSave('food')} disabled={saving === 'food'}>
                {saving === 'food' ? 'Saving…' : '💾 Save Restaurant Details'}
              </button>
              {savedSection === 'food' && <span className="toast-success">✅ Saved.</span>}
            </div>
          )}
        </fieldset>
      )}

      {dualEditMode && showRooms && (
        <button
          type="button"
          className="settings-section-toggle"
          onClick={() => toggleExpanded('rooms')}
          aria-expanded={expanded.rooms}
        >
          {expanded.rooms ? '▾' : '▸'} 🏨 Hotel / Room Booking
        </button>
      )}

      {showRooms && (dualEditMode ? expanded.rooms : (!showFood || activeSection === 'rooms')) && (
        <fieldset className="settings-fieldset">
          <label>
            Hotel Name
            <input
              value={form.room_biz_name}
              placeholder="e.g. Green Leaf Residency"
              onChange={(e) => update('room_biz_name', e.target.value)}
              required
            />
          </label>

          <label>
            Hotel Logo (shown on printed A4 room bills)
            <div className="settings-logo-row">
              <FoodImage src={form.room_biz_logo_path} alt="Hotel logo" size={56} />
              <button type="button" className="btn btn-secondary" onClick={handlePickLogo}>
                Choose Logo
              </button>
              {form.room_biz_logo_path && (
                <button type="button" className="btn btn-link" onClick={() => update('room_biz_logo_path', '')}>
                  Remove
                </button>
              )}
            </div>
          </label>

          <label>
            Address
            <textarea
              value={form.room_biz_address}
              placeholder="e.g. 123, Main Street, Your City, State - 000000"
              onChange={(e) => update('room_biz_address', e.target.value)}
              rows={2}
            />
          </label>

          <div className="settings-row">
            <label>
              Phone Number
              <input
                value={form.room_biz_phone}
                placeholder="e.g. +91 90000 00000"
                onChange={(e) => update('room_biz_phone', e.target.value)}
              />
            </label>
            <label>
              GSTIN / Tax ID (optional)
              <input
                value={form.room_biz_gstin}
                placeholder="e.g. GSTIN: 00AAAAA0000A1Z5"
                onChange={(e) => update('room_biz_gstin', e.target.value)}
              />
            </label>
          </div>

          <div className="settings-group">
            <span className="settings-group-label">Tax / GST Rate</span>
            <div className="settings-row">
              <TaxRateSelect
                label="Cash"
                value={form.room_tax_percent_cash}
                onChange={(v) => update('room_tax_percent_cash', v)}
              />
              <TaxRateSelect
                label="Online (UPI/Card)"
                value={form.room_tax_percent_online}
                onChange={(v) => update('room_tax_percent_online', v)}
              />
            </div>
          </div>

          <div className="settings-row">
            <label>
              Bill Footer Message
              <input
                value={form.room_bill_footer}
                placeholder="e.g. Thank you! Visit again."
                onChange={(e) => update('room_bill_footer', e.target.value)}
              />
            </label>
          </div>

          <label>
            UPI ID for Online Payments (for bill QR code)
            <input
              value={form.room_upi_id}
              placeholder="e.g. yourhotel@okaxis"
              onChange={(e) => update('room_upi_id', e.target.value)}
            />
          </label>

          {dualEditMode && (
            <div className="modal-actions fm-form-actions-center">
              <button type="button" className="btn btn-primary" onClick={() => handleSectionSave('rooms')} disabled={saving === 'rooms'}>
                {saving === 'rooms' ? 'Saving…' : '💾 Save Hotel Details'}
              </button>
              {savedSection === 'rooms' && <span className="toast-success">✅ Saved.</span>}
            </div>
          )}
        </fieldset>
      )}

      {mode === 'setup' && (
        <p className="settings-hint">
          UPI ID is optional, but recommended — skip it now and add it anytime later from Settings. Once
          set, every bill paid via "Online" will show a scannable UPI QR code so the customer can pay
          instantly using any UPI app (Google Pay, PhonePe, Paytm, etc.).
        </p>
      )}

      {!dualEditMode && (
        <div className={`modal-actions${mode === 'edit' && !onCancel ? ' fm-form-actions-center' : ''}`}>
          {mode === 'edit' && onCancel && (
            <button type="button" className="btn btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={!!saving}>
            {saving ? 'Saving…' : mode === 'setup' ? 'Save & Continue' : 'Save Changes'}
          </button>
        </div>
      )}
    </form>
  );
}
