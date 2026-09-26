import React from 'react';

export default function QuantityStepper({ quantity, onIncrement, onDecrement, size = 'md' }) {
  return (
    <div className={`qty-stepper qty-stepper-${size}`}>
      <button
        type="button"
        className="qty-btn"
        onClick={onDecrement}
        aria-label="Decrease quantity"
        disabled={quantity <= 0}
      >
        −
      </button>
      <span className="qty-value">{quantity}</span>
      <button type="button" className="qty-btn" onClick={onIncrement} aria-label="Increase quantity">
        +
      </button>
    </div>
  );
}
