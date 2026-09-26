import React from 'react';

// A small "?" hint that shows an explanatory sentence on hover/focus/tap,
// used next to any label that might not be self-explanatory at a glance
// (e.g. abbreviations, combined/group totals, business-specific terms).
// Native title tooltip keeps this accessible and needs no extra libraries —
// it works the same in Electron and the browser/mobile PWA.
export default function InfoTip({ text }) {
  if (!text) return null;
  return (
    <span className="info-tip" tabIndex={0} title={text} aria-label={text}>
      ?
    </span>
  );
}
