import React, { useEffect, useMemo, useState } from 'react';

const DEFAULTS = {
  hotel_name: 'Your Restaurant Name',
  hotel_address: '',
  hotel_phone: '',
  hotel_gstin: '',
  bill_footer: 'Thank you! Visit again.',
  room_biz_name: 'Your Hotel Name',
  room_biz_address: '',
  room_biz_phone: '',
  room_biz_gstin: '',
  room_bill_footer: 'Thank you for staying with us.',
  food_printer_name: '',
  room_printer_name: '',
  kot_printer_name: '',
  printer_paper_width: '80',
  printer_scale_percent: '100',
};

export default function PrinterSettingsSection({ settings, onSave }) {
  const [form, setForm] = useState({ ...DEFAULTS, ...(settings || {}) });
  const [printers, setPrinters] = useState([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [previewType, setPreviewType] = useState('FOOD_BILL');

  useEffect(() => {
    setForm((current) => ({ ...current, ...settings }));
  }, [settings]);

  useEffect(() => {
    if (typeof window.api?.getPrinters !== 'function') return;
    window.api.getPrinters().then(setPrinters).catch((err) => setError(err?.message || 'Could not load printers.'));
  }, []);

  const paperWidth = Math.max(48, Math.min(112, Number(form.printer_paper_width) || 80));
  const scale = Math.max(70, Math.min(150, Number(form.printer_scale_percent) || 100));
  const previewWidth = Math.min(112, Math.max(58, paperWidth));
  const printerOptions = useMemo(() => printers.map((printer) => ({
    value: printer.name,
    label: printer.displayName || printer.name,
  })), [printers]);
  const selectedPrinterName = previewType === 'KOT'
    ? form.kot_printer_name
    : previewType === 'ROOM' ? form.room_printer_name : form.food_printer_name;
  const selectedPrinter = printers.find((printer) => printer.name === selectedPrinterName);

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setError('');
    try {
      const updated = await onSave({
        ...form,
        printer_paper_width: String(paperWidth),
        printer_scale_percent: String(scale),
      });
      setForm((current) => ({ ...current, ...updated }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err?.message || 'Could not save printer settings.');
    }
  }

  async function testPrint() {
    setError('');
    try {
      if (typeof window.api?.printSample !== 'function') throw new Error('Test printing is available in the desktop app only.');
      await window.api.printSample({
        deviceName: previewType === 'KOT' ? form.kot_printer_name || '' : previewType === 'ROOM' ? form.room_printer_name || '' : form.food_printer_name || '',
        paperWidth,
        scale,
        type: previewType,
        business: {
          foodName: form.hotel_name,
          foodAddress: form.hotel_address,
          foodPhone: form.hotel_phone,
          foodGstin: form.hotel_gstin,
          foodFooter: form.bill_footer,
          roomName: form.room_biz_name,
          roomAddress: form.room_biz_address,
          roomPhone: form.room_biz_phone,
          roomGstin: form.room_biz_gstin,
          roomFooter: form.room_bill_footer,
        },
      });
    } catch (err) {
      setError(err?.message || 'Could not print the sample.');
    }
  }

  return (
    <section className="settings-section printer-settings-section">
      <div className="printer-section-heading">
        <div>
          <span className="settings-eyebrow">PRINTING WORKSPACE</span>
          <h2>🖨️ Printer &amp; Receipt Preview</h2>
          <p className="settings-sub">Choose a printer and see how the receipt will be laid out before you print a real bill.</p>
        </div>
        <div className="printer-status-badge">● Live preview</div>
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="settings-row">
        <label>
          Food bill printer
          <select value={form.food_printer_name || ''} onChange={(e) => update('food_printer_name', e.target.value)}>
            <option value="">Ask me each time</option>
            {printerOptions.map((printer) => <option key={printer.value} value={printer.value}>{printer.label}</option>)}
          </select>
        </label>
        <label>
          Room invoice printer
          <select value={form.room_printer_name || ''} onChange={(e) => update('room_printer_name', e.target.value)}>
            <option value="">Ask me each time</option>
            {printerOptions.map((printer) => <option key={printer.value} value={printer.value}>{printer.label}</option>)}
          </select>
        </label>
        <label>
          KOT printer
          <select value={form.kot_printer_name || ''} onChange={(e) => update('kot_printer_name', e.target.value)}>
            <option value="">Ask me each time</option>
            {printerOptions.map((printer) => <option key={printer.value} value={printer.value}>{printer.label}</option>)}
          </select>
        </label>
      </div>
      <div className="settings-row">
        <label>
          Thermal paper width
          <select value={form.printer_paper_width || '80'} onChange={(e) => update('printer_paper_width', e.target.value)}>
            <option value="58">58 mm</option>
            <option value="80">80 mm</option>
            <option value="112">112 mm</option>
          </select>
        </label>
        <label>
          Receipt scale
          <input type="number" min="70" max="150" step="5" value={form.printer_scale_percent || '100'} onChange={(e) => update('printer_scale_percent', e.target.value)} />
          <small className="settings-hint">70–150%. Increase this only if the printer output is too small.</small>
        </label>
      </div>
      <div className="printer-routing-note">
        <strong>Print routing</strong>
        <span>Food bills and KOTs can use the same thermal printer or two different printers. Room bookings print as a full A4 invoice.</span>
      </div>
      <div className="printer-preview-panel">
        <div className="printer-preview-toolbar">
          <label className="printer-preview-select">Preview
            <select value={previewType} onChange={(e) => setPreviewType(e.target.value)}>
              <option value="FOOD_BILL">Food bill · thermal</option>
              <option value="KOT">KOT · kitchen ticket</option>
              <option value="ROOM">Room invoice · A4</option>
            </select>
          </label>
          <div>
            <strong>{previewType === 'KOT' ? 'Sample kitchen ticket' : previewType === 'ROOM' ? 'Sample A4 room invoice' : 'Sample food bill'}</strong>
            <span>{selectedPrinter?.displayName || selectedPrinterName || 'No printer selected — Windows will ask at print time'} · Updates live</span>
          </div>
          <div className="printer-preview-metrics"><b>{previewType === 'ROOM' ? 'A4' : `${paperWidth} mm`}</b><b>{previewType === 'ROOM' ? 'Full page' : `${scale}% size`}</b></div>
        </div>
        <div className="printer-preview-stage">
          {previewType === 'ROOM' ? (
            <div className="printer-preview room-preview">
              <div className="room-preview-brand">{form.room_biz_name || 'Your Hotel Name'}</div>
              <h3>ROOM INVOICE</h3>
              {form.room_biz_address && <span className="printer-preview-muted">{form.room_biz_address}</span>}
              {form.room_biz_phone && <span className="printer-preview-muted">Ph: {form.room_biz_phone}</span>}
              {form.room_biz_gstin && <span className="printer-preview-muted">{form.room_biz_gstin}</span>}
              <div className="room-preview-grid"><span>Guest</span><b>Rahul Sharma</b><span>Room</span><b>204 · Deluxe</b><span>Check-in</span><b>19 Sep 2026</b><span>Check-out</span><b>21 Sep 2026</b></div>
              <hr /><div className="printer-preview-line"><span>Room charges (2 nights)</span><b>₹6,000</b></div><div className="printer-preview-line"><span>Tax</span><b>₹720</b></div>
              <hr /><div className="printer-preview-line printer-preview-total"><span>GRAND TOTAL</span><b>₹6,720</b></div>
              <span className="printer-preview-muted">{form.room_bill_footer || 'Thank you for staying with us.'}</span>
            </div>
          ) : (
            <div className={`printer-preview ${previewType === 'KOT' ? 'kot-preview' : ''}`} style={{ '--paper-ratio': previewWidth / 80, '--receipt-scale': scale / 100 }}>
              <div className="printer-preview-logo">{previewType === 'KOT' ? 'K' : 'B'}</div>
              <strong>{previewType === 'KOT' ? (form.hotel_name || 'Your Restaurant Name') : (form.hotel_name || 'Your Restaurant Name')}</strong>
              {form.hotel_address && <span className="printer-preview-muted">{form.hotel_address}</span>}
              {form.hotel_phone && <span className="printer-preview-muted">Ph: {form.hotel_phone}</span>}
              {form.hotel_gstin && <span className="printer-preview-muted">{form.hotel_gstin}</span>}
              <span className="printer-preview-muted">{previewType === 'KOT' ? 'KITCHEN ORDER TICKET · Order #104 · Table 4' : 'Tax Invoice · Dine-in'}</span>
              <hr />
              <div className="printer-preview-line"><span>Paneer Tikka × 2</span><b>{previewType === 'KOT' ? '' : '₹440'}</b></div>
              <div className="printer-preview-line"><span>Veg Biryani × 1</span><b>{previewType === 'KOT' ? '' : '₹180'}</b></div>
              {previewType !== 'KOT' && <><div className="printer-preview-line"><span>Tax 12%</span><b>₹74</b></div><hr /><div className="printer-preview-line printer-preview-total"><span>TOTAL</span><b>₹694</b></div></>}
              <span className="printer-preview-muted">{previewType === 'KOT' ? 'Please prepare immediately' : (form.bill_footer || 'Thank you! Visit again.')}</span>
            </div>
          )}
        </div>
        <div className="printer-driver-status">
          <strong>Connected printer check</strong>
          <span>
            {selectedPrinter
              ? `${selectedPrinter.displayName || selectedPrinter.name}${selectedPrinter.description ? ` · ${selectedPrinter.description}` : ''}`
              : 'Select a connected printer above to see its Windows printer entry.'}
          </span>
          <small>
            The layout above is the exact BillNest document profile. Use the test button below to send this sample through the real Windows printer driver and confirm the physical size, margins, and cutting.
          </small>
        </div>
      </div>
      <div className="settings-extra">
        <button type="button" className="btn btn-primary" onClick={save}>Save printer settings</button>
        <button type="button" className="btn btn-secondary" onClick={testPrint}>🖨️ Send test through printer driver</button>
        {saved && <span className="settings-hint">Saved.</span>}
      </div>
    </section>
  );
}
