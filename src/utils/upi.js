// Builds a standard UPI deep-link string that any UPI app (GPay, PhonePe, Paytm, etc.)
// can scan and understand, so no external payment gateway integration is required.
export function buildUpiUri({ upiId, payeeName, amount, note }) {
  if (!upiId) return '';
  const params = new URLSearchParams({
    pa: upiId,
    pn: payeeName || 'Hotel',
    cu: 'INR',
  });
  if (amount != null && amount > 0) params.set('am', Number(amount).toFixed(2));
  if (note) params.set('tn', note);
  return `upi://pay?${params.toString()}`;
}
