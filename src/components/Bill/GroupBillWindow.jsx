import React, { useEffect, useState } from 'react';
import RoomInvoice from './RoomInvoice';

// Combined Group Invoice: a read-only, "virtual" merge of every already
// -generated per-room bill in one booking group (each room bills
// independently at its own checkout — see roomService.checkOut). This view
// never creates a new bill row; it just displays the existing bills'
// figures together for guests who want one document after everyone in the
// group has checked out.
export default function GroupBillWindow({ groupId }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'loaded' | 'notfound' | 'pending' | 'error'
  const [errorMessage, setErrorMessage] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setStatus('loading');
    window.api.getGroupInvoice(groupId)
      .then((d) => {
        if (cancelled) return;
        if (d) { setData(d); setStatus('loaded'); }
        else setStatus('notfound');
      })
      .catch((err) => {
        if (cancelled) return;
        setErrorMessage(err?.message || '');
        // The backend throws while any room in the group is still
        // BOOKED/CHECKED_IN — surface that as a clear "not ready" message
        // rather than a generic error.
        setStatus(/checked out/i.test(err?.message || '') ? 'pending' : 'error');
      });
    return () => { cancelled = true; };
  }, [groupId]);

  function closeWindow() {
    window.close();
    setTimeout(() => { window.location.hash = ''; }, 150);
  }

  async function handleDownload() {
    setDownloading(true);
    try {
      await window.api.downloadGroupBillPdf(groupId);
    } finally {
      setDownloading(false);
    }
  }

  const canDownload = !!window.api?.downloadGroupBillPdf;

  if (status !== 'loaded') {
    const message = {
      loading: 'Loading combined invoice…',
      notfound: 'No bills found for this booking group.',
      pending: errorMessage || 'All rooms in this booking must be checked out first.',
      error: 'Could not load this combined invoice. Please try again.',
    }[status];
    return (
      <div className="bill-window room-bill-window">
        <div className="empty-state">{message}</div>
        <div className="receipt-actions no-print">
          <button className="btn btn-secondary" onClick={closeWindow}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="bill-window room-bill-window">
      <RoomInvoice group={data} />
      <div className="receipt-actions no-print">
        <button className="btn btn-primary" onClick={() => window.print()}>🖨️ Print</button>
        {canDownload && (
          <button className="btn btn-secondary" onClick={handleDownload} disabled={downloading}>
            {downloading ? 'Preparing…' : '⬇️ Download PDF'}
          </button>
        )}
        <button className="btn btn-secondary" onClick={closeWindow}>Close</button>
      </div>
    </div>
  );
}
