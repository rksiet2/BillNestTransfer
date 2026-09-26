import React, { useEffect, useState, useCallback } from 'react';
import CategoryTabs from '../Menu/CategoryTabs';
import MenuGrid from '../Menu/MenuGrid';
import FoodCard from '../Menu/FoodCard';
import SearchBar from '../Search/SearchBar';
import Cart from '../Cart/Cart';
import { useCart } from '../../context/CartContext';
import { formatCurrency } from '../../utils/format';

export default function BillingPage({ onBillGenerated }) {
  const [categories, setCategories] = useState([]);
  const [activeCategory, setActiveCategory] = useState(null);
  const [search, setSearch] = useState('');
  const [foods, setFoods] = useState([]);
  const [popularFoods, setPopularFoods] = useState([]);
  const [popularError, setPopularError] = useState('');
  const [loading, setLoading] = useState(true);
  const [lastBillInfo, setLastBillInfo] = useState(null);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const { items, subtotal } = useCart();
  const itemCount = items.reduce((count, item) => count + item.quantity, 0);

  const loadFoods = useCallback(async () => {
    const data = await window.api.listFood({
      categoryId: activeCategory || undefined,
      search: search || undefined,
    });
    setFoods(data);
  }, [activeCategory, search]);

  useEffect(() => {
    window.api.listCategories().then(setCategories);
  }, []);

  useEffect(() => {
    window.api.getPopularFood(8)
      .then(setPopularFoods)
      .catch((error) => {
        console.error('Could not load best-selling menu items:', error);
        setPopularError('Best sellers could not load right now.');
      });
  }, []);

  useEffect(() => {
    setLoading(true);
    loadFoods().finally(() => setLoading(false));
  }, [loadFoods]);

  function handleBillGenerated(bill) {
    setLastBillInfo(bill);
    onBillGenerated?.(bill);
    setTimeout(() => setLastBillInfo(null), 6000);
  }

  return (
    <div className="billing-page">
      <div className="menu-section">
        <SearchBar value={search} onChange={setSearch} />
        {!search && (
          <CategoryTabs categories={categories} activeId={activeCategory} onSelect={setActiveCategory} />
        )}
        {!search && !activeCategory && popularFoods.length > 0 && (
          <section className="popular-items" aria-label="Best-selling menu items">
            <div className="popular-items-heading">
              <h2>Quick picks</h2>
              <span>Best sellers · last 30 days</span>
            </div>
            <div className="popular-items-row">
              {popularFoods.map((food) => (
                <FoodCard key={food.id} food={food} className="quick-pick-card" />
              ))}
            </div>
          </section>
        )}
        {popularError && !search && !activeCategory && (
          <p className="popular-items-error" role="status">{popularError}</p>
        )}
        {loading ? (
          <div className="empty-state">Loading menu…</div>
        ) : (
          <MenuGrid foods={foods} />
        )}
      </div>
      <Cart onBillGenerated={handleBillGenerated} mobileOpen={mobileCartOpen} onMobileClose={() => setMobileCartOpen(false)} />

      {items.length > 0 && !mobileCartOpen && (
        <button className="mobile-order-bar" onClick={() => setMobileCartOpen(true)}>
          <span><span className="mob-count">{itemCount}</span>{itemCount === 1 ? 'item' : 'items'} · Subtotal {formatCurrency(subtotal)} · View order</span>
          <span className="mob-arrow">→</span>
        </button>
      )}

      {lastBillInfo && (
        <div className="toast-success">
          ✅ Bill {lastBillInfo.billNumber} (Token {lastBillInfo.token}) generated &amp; saved to Bill Records.
          <br />
          🧑‍🍳 KOT {lastBillInfo.kotNumber} sent to kitchen &amp; saved to KOT Records.
          <div className="toast-actions">
            <button className="btn-link toast-action" onClick={() => window.api.printBill(lastBillInfo.id)}>
              🖨️ Print Bill
            </button>
            <button className="btn-link toast-action" onClick={() => window.api.printKot(lastBillInfo.id)}>
              🖨️ Print KOT
            </button>
            <button className="btn-link toast-action" onClick={() => window.api.openKotWindow(lastBillInfo.id)}>
              Reopen KOT
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
