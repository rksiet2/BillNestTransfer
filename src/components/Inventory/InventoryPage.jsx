import React, { useState } from 'react';
import RawMaterialsTab from './RawMaterialsTab';
import PurchasesTab from './PurchasesTab';
import ExpensesTab from './ExpensesTab';
import ReportsTab from './ReportsTab';

const TABS = [
  { key: 'purchases', label: 'Purchases' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'items', label: 'Purchase Items' },
  { key: 'reports', label: 'Reports' },
];

export default function InventoryPage() {
  const [tab, setTab] = useState('purchases');

  return (
    <div className="inventory-page">
      <div className="report-period-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`cat-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'purchases' && <PurchasesTab />}
      {tab === 'expenses' && <ExpensesTab />}
      {tab === 'items' && <RawMaterialsTab />}
      {tab === 'reports' && <ReportsTab />}
    </div>
  );
}
