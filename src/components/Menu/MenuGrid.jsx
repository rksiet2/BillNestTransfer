import React from 'react';
import FoodCard from './FoodCard';

export default function MenuGrid({ foods, emptyText = 'No items found.' }) {
  if (!foods || foods.length === 0) {
    return <div className="empty-state">{emptyText}</div>;
  }
  return (
    <div className="menu-grid">
      {foods.map((food) => (
        <FoodCard key={food.id} food={food} />
      ))}
    </div>
  );
}
