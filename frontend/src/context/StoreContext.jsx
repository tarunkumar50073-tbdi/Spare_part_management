import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { storeService } from "../services/storeService.js";

const StoreContext = createContext(null);
const ACTIVE_STORE_KEY = "dx_active_store";

/**
 * Which store the sidebar is currently scoped to.
 *
 * Deliberately app state rather than part of the URL: the screens themselves
 * (/short-parts, /live-stock) are unchanged and shared, so putting the store
 * in the path would have meant rewriting every route and every link for a
 * value that only decides which menu is on screen. The choice is remembered
 * between visits so the plant monitor comes back to the same store after a
 * reboot.
 */
export function StoreProvider({ children }) {
  const [stores, setStores] = useState([]);
  const [activeCode, setActiveCode] = useState(() => localStorage.getItem(ACTIVE_STORE_KEY) || "");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    storeService.list(false)
      .then((res) => {
        const list = res.data.data || [];
        setStores(list);
        // Fall back to the first store this user may open — a remembered
        // store they have since lost rights to must not strand them.
        setActiveCode((current) => {
          const stillAllowed = list.some((s) => s.code === current);
          return stillAllowed ? current : (list[0]?.code || "");
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (activeCode) localStorage.setItem(ACTIVE_STORE_KEY, activeCode);
  }, [activeCode]);

  const value = useMemo(() => ({
    stores,
    loading,
    activeCode,
    activeStore: stores.find((s) => s.code === activeCode) || null,
    setActiveStore: (code) => setActiveCode(code),
  }), [stores, loading, activeCode]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStores() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStores must be used inside StoreProvider");
  return ctx;
}

// Kept as a hook-free export so the sidebar can build links without importing
// the whole context where it only needs the destination.
export const storeHome = (code) => (code === "CHILD_PART" ? "/dashboard" : `/store/${code}`);
