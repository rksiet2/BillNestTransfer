import React from 'react';

function daysRemaining(expiresAt) {
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function ExpiryBadge({ expiresAt, gracePeriodDaysLeft }) {
  if (!expiresAt) return <span className="license-expiry-badge license-expiry-perpetual">Perpetual</span>;
  if (gracePeriodDaysLeft != null) {
    return (
      <span className="license-expiry-badge license-expiry-grace">
        Grace period — {gracePeriodDaysLeft}d left to renew
      </span>
    );
  }
  const days = daysRemaining(expiresAt);
  if (days <= 0) return <span className="license-expiry-badge license-expiry-expired">Expired</span>;
  if (days <= 7)  return <span className="license-expiry-badge license-expiry-red">{days}d remaining</span>;
  if (days <= 30) return <span className="license-expiry-badge license-expiry-yellow">{days}d remaining</span>;
  return <span className="license-expiry-badge license-expiry-green">{days}d remaining</span>;
}

// Only rendered in Electron desktop (where window.api is present). Never
// shown on mobile/Captain/browser builds — those don't carry a license payload.
export default function LicenseInfoSection({ licenseStatus }) {
  if (!window.api) return null;

  const { payload, machineId } = licenseStatus || {};

  return (
    <div className="settings-section">
      <h2>License</h2>
      {payload ? (
        <div className="license-info-grid">
          <div className="license-info-row">
            <span className="license-info-label">Licensed to</span>
            <span className="license-info-value">{payload.hotelName || '—'}</span>
          </div>
          <div className="license-info-row">
            <span className="license-info-label">Modules</span>
            <span className="license-info-value">
              {(payload.modules || []).map((m) => (
                <span key={m} className="license-module-badge">
                  {m === 'food' ? 'Food Billing' : 'Room Booking'}
                </span>
              ))}
            </span>
          </div>
          <div className="license-info-row">
            <span className="license-info-label">Issued on</span>
            <span className="license-info-value">
              {payload.issuedAt ? new Date(payload.issuedAt).toLocaleDateString() : '—'}
            </span>
          </div>
          <div className="license-info-row">
            <span className="license-info-label">Expires on</span>
            <span className="license-info-value">
              {payload.expiresAt ? new Date(payload.expiresAt).toLocaleDateString() : 'Never'}
              &nbsp;
              <ExpiryBadge expiresAt={payload.expiresAt} gracePeriodDaysLeft={payload.gracePeriodDaysLeft} />
            </span>
          </div>
          <div className="license-info-row">
            <span className="license-info-label">Machine ID</span>
            <span className="license-info-value license-info-machineid">{machineId || '—'}</span>
          </div>
        </div>
      ) : (
        <p className="license-info-no-payload">
          License details not available. This may be a Client terminal or a legacy license.
        </p>
      )}
    </div>
  );
}
