import React from 'react';

export default function CategoryTabs({ categories, activeId, onSelect }) {
  return (
    <div className="category-tabs-row">
      <div className="category-tabs">
        <button className={`cat-tab ${activeId === null ? 'active' : ''}`} onClick={() => onSelect(null)}>
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat.id}
            className={`cat-tab ${activeId === cat.id ? 'active' : ''}`}
            onClick={() => onSelect(cat.id)}
          >
            {cat.name}
          </button>
        ))}
      </div>
      {activeId !== null && (
        <button
          className="cat-clear-btn"
          title="Clear category filter"
          onClick={() => onSelect(null)}
        >
          ✕ Clear
        </button>
      )}
    </div>
  );
}
