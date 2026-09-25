import React from "react";
import { Link } from "react-router-dom";
import { Store } from "lucide-react";
import { useStores } from "../context/StoreContext.jsx";

// Route gate for a store's own screens. The Child Parts Store is switched off
// (Spare-only mode, Settings → Stores) but its screens are still in the bundle;
// without this, typing /short-parts or /srvs opened a Child screen with Child
// data for a spare user. Turning the store back on restores them unchanged.
export default function StoreRoute({ store, children }) {
  const { stores, loading } = useStores();

  if (loading) {
    return <div className="skeleton h-40 w-full max-w-3xl mx-auto mt-10 rounded-xl" />;
  }
  if (stores.some((s) => s.code === store)) return children;

  return (
    <div className="max-w-md mx-auto mt-16 text-center">
      <div className="card p-8">
        <Store className="mx-auto mb-4 text-slate-400" size={40} aria-hidden="true" />
        <h2 className="text-lg font-bold text-slate-800 dark:text-white">Screen not in use</h2>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          This screen belongs to the Child Parts Store, which is switched off. The app is running
          as the Spare Parts Store only.
        </p>
        <Link to="/" className="btn-primary mt-5">Go to the Spare Parts Store</Link>
      </div>
    </div>
  );
}
