import React from 'react';
import FoodImage from '../common/FoodImage';
import QuantityStepper from '../common/QuantityStepper';
import { formatCurrency } from '../../utils/format';
import { useCart } from '../../context/CartContext';

export default function FoodCard({ food, className = '' }) {
  const { addItem, updateQuantity, getQuantity } = useCart();
  const qty = getQuantity(food.id);

  return (
    <div className={`food-card ${className} ${!food.available ? 'unavailable' : ''}`.trim()}>
      <div className="food-image-wrap">
        <FoodImage src={food.image_path} alt={food.name} size={80} />
        <span className={`veg-badge ${food.is_veg ? 'veg' : 'nonveg'}`} title={food.is_veg ? 'Veg' : 'Non-Veg'}>
          <span className="veg-badge-dot" />
        </span>
      </div>
      <div className="food-card-info">
        <h4 title={food.name}>{food.name}</h4>
        <p className="food-price">{formatCurrency(food.price)}</p>
      </div>
      {qty === 0 ? (
        <button
          className="btn btn-add"
          disabled={!food.available}
          onClick={() => addItem(food)}
        >
          + Add
        </button>
      ) : (
        <QuantityStepper
          quantity={qty}
          onIncrement={() => updateQuantity(food.id, 1)}
          onDecrement={() => updateQuantity(food.id, -1)}
        />
      )}
    </div>
  );
}
