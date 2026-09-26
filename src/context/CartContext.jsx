import React, { createContext, useContext, useMemo, useState, useCallback, useRef, useEffect } from 'react';

const CartContext = createContext(null);

export function CartProvider({ children }) {
  const [items, setItems] = useState([]); // { id, name, price, quantity }
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  // Table/Area Management (opt-in feature): the table the current cart is
  // attached to, or null for a plain counter/takeaway order. Each table can
  // have its own in-progress order running at the same time — switching
  // between tables must not lose whichever one you switched away from, so
  // in-progress carts for tables NOT currently active are held here, keyed
  // by table id, and swapped in/out of the single `items` state above.
  const [activeTable, setActiveTable] = useState(null);
  const [tableDrafts, setTableDrafts] = useState({}); // { [tableId]: { items, customerName, paymentMethod } }
  const [tableSyncStatus, setTableSyncStatus] = useState('idle');

  // Tracks whichever table id we most recently asked to switch to, so an
  // in-flight `getTableOrder` response from a PREVIOUS table selection can't
  // clobber the cart after the user has already moved on to another table
  // (or back to counter mode) before that older request resolved.
  const activeTableIdRef = useRef(null);

  const addItem = useCallback((food) => {
    setItems((prev) => {
      const existing = prev.find((it) => it.id === food.id);
      if (existing) {
        return prev.map((it) => (it.id === food.id ? { ...it, quantity: it.quantity + 1 } : it));
      }
      return [...prev, { id: food.id, name: food.name, price: food.price, quantity: 1 }];
    });
  }, []);

  const updateQuantity = useCallback((id, delta) => {
    setItems((prev) =>
      prev
        .map((it) => (it.id === id ? { ...it, quantity: it.quantity + delta } : it))
        .filter((it) => it.quantity > 0)
    );
  }, []);

  const removeItem = useCallback((id) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const clearCart = useCallback(() => {
    setItems([]);
    setCustomerName('');
    setCustomerPhone('');
  }, []);

  // Drops a table's saved draft both locally and on the server — call this
  // right BEFORE `selectTable(null, { discardOutgoing: true })` once a
  // table has just been billed or its order cancelled, so the (now stale)
  // pre-clear cart values don't get re-stashed by selectTable's own
  // outgoing-draft-preservation logic, and so another device polling the
  // same table doesn't see the old, already-billed items again.
  const clearTableDraft = useCallback((tableId) => {
    if (tableId == null) return;
    setTableDrafts((prev) => {
      if (!(tableId in prev)) return prev;
      const next = { ...prev };
      delete next[tableId];
      return next;
    });
    if (window.api?.clearTableOrder) {
      window.api.clearTableOrder(tableId).catch(() => {});
    }
  }, []);

  // Switches the working cart to `table` (or back to counter mode if null),
  // stashing whatever was in progress for the table being switched away from
  // so it's there untouched next time that table is reopened. If nothing was
  // ever added to the outgoing table (still an empty draft), there's nothing
  // to preserve — release it back to EMPTY instead of leaving it stuck
  // "Occupied" forever with nothing in it (this covers accidentally tapping
  // a table, or switching to Counter mode right away).
  //
  // `opts.discardOutgoing` skips re-stashing the outgoing table's draft
  // entirely — used right after billing/cancelling, where the caller has
  // just cleared the cart and already knows there's nothing worth keeping
  // (and re-stashing here would otherwise resurrect the stale pre-clear
  // items due to React state not being updated synchronously yet).
  const selectTable = useCallback((table, opts = {}) => {
    const { discardOutgoing = false } = opts;
    const outgoing = activeTable;
    const outgoingIsEmpty = items.length === 0 && !customerName && !customerPhone;
    setTableDrafts((prevDrafts) => {
      const next = { ...prevDrafts };
      if (outgoing && !discardOutgoing) {
        if (outgoingIsEmpty) delete next[outgoing.id];
        else next[outgoing.id] = { items, customerName, customerPhone };
      }
      return next;
    });
    if (outgoing && (outgoingIsEmpty || discardOutgoing) && window.api?.updateTableStatus) {
      window.api.updateTableStatus(outgoing.id, 'EMPTY').then(() => {
        window.dispatchEvent(new CustomEvent('billnest:tables-updated'));
      });
    }
    const incoming = table ? tableDrafts[table.id] : null;
    setTableSyncStatus(table ? 'saving' : 'idle');
    setItems(incoming ? incoming.items : []);
    setCustomerName(incoming ? incoming.customerName : '');
    setCustomerPhone(incoming ? incoming.customerPhone || '' : '');
    setActiveTable(table || null);
    activeTableIdRef.current = table ? table.id : null;

    // Server is the source of truth once more than one device may touch a
    // table's cart — reconcile asynchronously after the optimistic local
    // draft above is already showing (so switching tables still feels
    // instant, with no flicker/blank flash while this resolves).
    if (table && window.api?.getTableOrder) {
      window.api.getTableOrder(table.id).then((order) => {
        // A newer selectTable() call may have already moved on to a
        // different table (or back to counter mode) — ignore this stale response.
        if (activeTableIdRef.current !== table.id) return;
        if (!order) {
          // Server has no saved order for this table — it's genuinely
          // empty (e.g. another device already billed/cleared it since our
          // local `tableDrafts` cache was last written). The optimistic
          // local draft shown above is now stale and must NOT be left on
          // screen, or the previous guest's already-billed items would
          // silently resurface for whoever opens this table next.
          setItems([]);
          setCustomerName('');
          setCustomerPhone('');
          setTableSyncStatus('saved');
          setTableDrafts((prevDrafts) => {
            if (!(table.id in prevDrafts)) return prevDrafts;
            const next = { ...prevDrafts };
            delete next[table.id];
            return next;
          });
          return;
        }
        setItems(order.items || []);
        setCustomerName(order.customerName || '');
        setCustomerPhone(order.customerPhone || '');
        setTableSyncStatus('saved');
        setTableDrafts((prevDrafts) => ({
          ...prevDrafts,
          [table.id]: {
            items: order.items || [],
            customerName: order.customerName || '',
            customerPhone: order.customerPhone || '',
          },
        }));
      }).catch(() => {
        if (activeTableIdRef.current === table.id) setTableSyncStatus('error');
      });
    }
  }, [items, customerName, customerPhone, activeTable, tableDrafts]);

  // Debounced autosave: while a table is active, push local cart changes to
  // the server shortly after they settle so another device opening the same
  // table (even later, after this device has moved away) picks up the
  // latest items instead of an empty/stale order.
  useEffect(() => {
    if (!activeTable || !window.api?.saveTableOrder) return undefined;
    const tableId = activeTable.id;
    setTableSyncStatus('saving');
    const timer = setTimeout(() => {
      window.api.saveTableOrder(tableId, { items, customerName, customerPhone })
        .then(() => setTableSyncStatus('saved'))
        .catch(() => setTableSyncStatus('error'));
    }, 700);
    return () => clearTimeout(timer);
  }, [activeTable, items, customerName, customerPhone]);

  const getQuantity = useCallback((id) => {
    const it = items.find((i) => i.id === id);
    return it ? it.quantity : 0;
  }, [items]);

  const subtotal = useMemo(() => items.reduce((s, it) => s + it.price * it.quantity, 0), [items]);

  const value = {
    items,
    addItem,
    updateQuantity,
    removeItem,
    clearCart,
    getQuantity,
    subtotal,
    paymentMethod,
    setPaymentMethod,
    customerName,
    setCustomerName,
    customerPhone,
    setCustomerPhone,
    activeTable,
    selectTable,
    clearTableDraft,
    tableSyncStatus,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
}
