import React from 'react';

// Standard GST/tax slabs commonly used by restaurants and hotels in India,
// plus a "Custom" option at the end for anything else (a different state's
// rate, a special scheme, etc.) — used identically for Food billing and
// Room/Hotel billing so both flows offer the same quick-pick + custom entry.
export const STANDARD_TAX_RATES = [0, 5, 12, 18, 28];

// `value` is always the numeric percentage actually in effect; this renders
// as one of the standard buttons when it matches a preset, or "Custom" (with
// a free number input alongside) when it doesn't.
export default function TaxRateSelect({ value, onChange, label = 'GST / Tax Rate' }) {
  const isStandard = STANDARD_TAX_RATES.includes(Number(value));
  const selectValue = isStandard ? String(value) : 'custom';

  function handleSelectChange(v) {
    if (v === 'custom') {
      onChange(value); // keep current value, just switch the input into custom mode
    } else {
      onChange(Number(v));
    }
  }

  return (
    <label className="tax-rate-select">
      {label}
      <div className="tax-rate-select-row">
        <select value={selectValue} onChange={(e) => handleSelectChange(e.target.value)}>
          {STANDARD_TAX_RATES.map((r) => (
            <option key={r} value={r}>{r}%</option>
          ))}
          <option value="custom">Custom…</option>
        </select>
        {!isStandard && (
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            className="tax-rate-custom-input"
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
            placeholder="Custom %"
          />
        )}
      </div>
    </label>
  );
}
