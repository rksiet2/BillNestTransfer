export function formatCurrency(value) {
  const num = Number(value) || 0;
  return `₹${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDate(dateStr) {
  try {
    return new Date(dateStr).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

// Indian GST invoices show tax as two equal halves — CGST (Central) + SGST
// (State) — rather than one combined "Tax" line, whenever GST actually
// applies (i.e. tax percent/amount > 0). Splits an already-computed
// percent/amount evenly; each half keeps its own rounding so the two halves
// always sum back to the original amount.
export function splitGst(taxPercent, taxAmount) {
  const percent = Number(taxPercent) || 0;
  const amount = Number(taxAmount) || 0;
  const halfPercent = +(percent / 2).toFixed(2);
  const cgstAmount = +(amount / 2).toFixed(2);
  const sgstAmount = +(amount - cgstAmount).toFixed(2);
  return { halfPercent, cgstAmount, sgstAmount };
}
