const state = { licenses: [], editingExtendId: null };

const els = {
  rows: document.getElementById('licenseRows'),
  emptyState: document.getElementById('emptyState'),
  statTotal: document.getElementById('statTotal'),
  statActive: document.getElementById('statActive'),
  statExpired: document.getElementById('statExpired'),
  statPerpetual: document.getElementById('statPerpetual'),
  modalOverlay: document.getElementById('modalOverlay'),
  modalTitle: document.getElementById('modalTitle'),
  form: document.getElementById('licenseForm'),
  fClientName: document.getElementById('fClientName'),
  fMachineId: document.getElementById('fMachineId'),
  fModules: document.getElementById('fModules'),
  fPerpetual: document.getElementById('fPerpetual'),
  fExpiry: document.getElementById('fExpiry'),
  fNotes: document.getElementById('fNotes'),
  expiryDateRow: document.getElementById('expiryDateRow'),
  resultOverlay: document.getElementById('resultOverlay'),
  resultBlob: document.getElementById('resultBlob'),
};

function fmtDate(iso) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function moduleLabel(mods) {
  return mods.map((m) => `<span class="module-chip">${m === 'food' ? 'Food Billing' : 'Room Booking'}</span>`).join('');
}

function statusBadge(status) {
  const map = {
    ACTIVE: '<span class="badge badge-active">Active</span>',
    EXPIRED: '<span class="badge badge-expired">Expired</span>',
    PERPETUAL: '<span class="badge badge-perpetual">Perpetual</span>',
  };
  return map[status] || status;
}

async function loadLicenses() {
  const res = await fetch('/api/licenses');
  state.licenses = await res.json();
  render();
}

function render() {
  const { licenses } = state;
  els.statTotal.textContent = licenses.length;
  els.statActive.textContent = licenses.filter((l) => l.status === 'ACTIVE').length;
  els.statExpired.textContent = licenses.filter((l) => l.status === 'EXPIRED').length;
  els.statPerpetual.textContent = licenses.filter((l) => l.status === 'PERPETUAL').length;

  els.emptyState.style.display = licenses.length ? 'none' : 'block';
  els.rows.innerHTML = licenses.map((l) => `
    <tr>
      <td><strong>${escapeHtml(l.clientName)}</strong></td>
      <td><span class="mono" title="${escapeHtml(l.machineId)}">${escapeHtml(l.machineId.slice(0, 14))}…</span></td>
      <td>${moduleLabel(l.modules)}</td>
      <td>${fmtDate(l.issuedAt)}</td>
      <td>${fmtDate(l.expiresAt)}</td>
      <td>${statusBadge(l.status)}</td>
      <td>${escapeHtml(l.notes || '—')}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-link" data-action="view" data-id="${l.id}">Code</button>
          <button class="btn btn-link" data-action="extend" data-id="${l.id}">Extend</button>
          <button class="btn btn-link btn-revoke" data-action="revoke" data-id="${l.id}">Revoke</button>
          <button class="btn btn-danger" data-action="delete" data-id="${l.id}">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openCreateModal() {
  state.editingExtendId = null;
  els.modalTitle.textContent = 'New License';
  document.getElementById('submitBtn').textContent = 'Generate License';
  els.form.reset();
  els.fMachineId.disabled = false;
  els.fClientName.disabled = false;
  els.expiryDateRow.style.display = 'flex';
  els.modalOverlay.classList.add('open');
}

function openExtendModal(license) {
  state.editingExtendId = license.id;
  els.modalTitle.textContent = `Extend License — ${license.clientName}`;
  document.getElementById('submitBtn').textContent = 'Save & Re-issue';
  els.fClientName.value = license.clientName;
  els.fMachineId.value = license.machineId;
  els.fClientName.disabled = true;
  els.fMachineId.disabled = true;
  els.fModules.value = license.modules.includes('food') && license.modules.includes('rooms')
    ? 'both' : license.modules.includes('food') ? 'food' : 'rooms';
  els.fPerpetual.checked = !license.expiresAt;
  els.fExpiry.value = license.expiresAt ? license.expiresAt.slice(0, 10) : '';
  els.fNotes.value = license.notes || '';
  els.expiryDateRow.style.display = els.fPerpetual.checked ? 'none' : 'flex';
  els.modalOverlay.classList.add('open');
}

function closeModal() {
  els.modalOverlay.classList.remove('open');
  els.form.reset();
  els.fClientName.disabled = false;
  els.fMachineId.disabled = false;
}

els.fPerpetual.addEventListener('change', () => {
  els.expiryDateRow.style.display = els.fPerpetual.checked ? 'none' : 'flex';
});

document.getElementById('newLicenseBtn').addEventListener('click', openCreateModal);
document.getElementById('cancelBtn').addEventListener('click', closeModal);
document.getElementById('modalClose').addEventListener('click', closeModal);
els.modalOverlay.addEventListener('click', (e) => { if (e.target === els.modalOverlay) closeModal(); });

document.getElementById('resultClose').addEventListener('click', () => document.getElementById('resultOverlay').classList.remove('open'));
document.getElementById('copyBlobBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(els.resultBlob.value);
  const btn = document.getElementById('copyBlobBtn');
  const original = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = original; }, 1500);
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const expiry = els.fPerpetual.checked ? 'perpetual' : els.fExpiry.value;
  const modules = els.fModules.value;
  const notes = els.fNotes.value;

  try {
    let result;
    if (state.editingExtendId) {
      const res = await fetch(`/api/licenses/${state.editingExtendId}/extend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiry, modules, notes }),
      });
      result = await res.json();
      if (!res.ok) throw new Error(result.error);
    } else {
      const res = await fetch('/api/licenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: els.fClientName.value,
          machineId: els.fMachineId.value,
          expiry,
          modules,
          notes,
        }),
      });
      result = await res.json();
      if (!res.ok) throw new Error(result.error);
    }
    closeModal();
    await loadLicenses();
    els.resultBlob.value = result.blob;
    document.getElementById('resultOverlay').querySelector('h2').textContent = '✅ License Ready';
    document.getElementById('resultOverlay').querySelector('.hint').textContent =
      "Send this whole code to the customer — they paste it into BillNest's Activation screen.";
    document.getElementById('resultOverlay').classList.add('open');
  } catch (err) {
    alert(`Could not generate license: ${err.message}`);
  }
});

els.rows.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const license = state.licenses.find((l) => l.id === id);
  if (!license) return;

  if (btn.dataset.action === 'view') {
    els.resultBlob.value = license.blob;
    document.getElementById('resultOverlay').querySelector('h2').textContent = '✅ License Ready';
    document.getElementById('resultOverlay').querySelector('.hint').textContent =
      "Send this whole code to the customer — they paste it into BillNest's Activation screen.";
    document.getElementById('resultOverlay').classList.add('open');
  } else if (btn.dataset.action === 'extend') {
    openExtendModal(license);
  } else if (btn.dataset.action === 'revoke') {
    if (!confirm(`Revoke access for "${license.clientName}"?\n\nThis re-issues the license with an expired date.\n\nSend them the new code — once they apply it (or on their next app restart), their app will block access and show the Activation screen.\n\nNote: their current license remains on their machine until they apply this new code.`)) return;
    const res = await fetch(`/api/licenses/${id}/revoke`, { method: 'POST' });
    const result = await res.json();
    if (!res.ok) { alert(`Revoke failed: ${result.error}`); return; }
    await loadLicenses();
    document.getElementById('resultOverlay').querySelector('h2').textContent = '🚫 Revoked License Code';
    document.getElementById('resultOverlay').querySelector('.hint').textContent =
      'Send this code to the customer. Once they paste it into BillNest, access is blocked immediately (or on their next app restart).';
    els.resultBlob.value = result.blob;
    document.getElementById('resultOverlay').classList.add('open');
  } else if (btn.dataset.action === 'delete') {
    if (!confirm(`Delete the history record for "${license.clientName}"?\n\nThis ONLY removes the entry from this dashboard — it does NOT cut off access on their machine. Use "Revoke" to actually block access.`)) return;
    await fetch(`/api/licenses/${id}`, { method: 'DELETE' });
    await loadLicenses();
  }
});

loadLicenses();
