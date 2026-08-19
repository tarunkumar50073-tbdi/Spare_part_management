import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import MainLayout from "./layouts/MainLayout.jsx";
import StoreDashboard from "./pages/StoreDashboard.jsx";
import GateEntry from "./pages/GateEntry.jsx";
import SRVWorkflow from "./pages/SRVWorkflow.jsx";
import StoreStock from "./pages/StoreStock.jsx";
import PutAway from "./pages/PutAway.jsx";
import HoldingArea from "./pages/HoldingArea.jsx";
import AuditTrail from "./pages/AuditTrail.jsx";
import Reports from "./pages/Reports.jsx";
import PartMaster from "./pages/PartMaster.jsx";
import SpareStock from "./pages/SpareStock.jsx";
import SupplierMaster from "./pages/SupplierMaster.jsx";
import StockCount from "./pages/StockCount.jsx";
import RackBinMaster from "./pages/RackBinMaster.jsx";
import LiveStock from "./pages/LiveStock.jsx";
import ShortParts from "./pages/ShortParts.jsx";
import ExcessParts from "./pages/ExcessParts.jsx";
import QuarterlyInventory from "./pages/QuarterlyInventory.jsx";
import ERPGap from "./pages/ERPGap.jsx";
import SpareErpGap from "./pages/SpareErpGap.jsx";
import ERPLedgerImport from "./pages/ERPLedgerImport.jsx";
import InventoryOverview from "./pages/InventoryOverview.jsx";
import SupplierVehicleManagement from "./pages/SupplierVehicleManagement.jsx";
import Login from "./pages/Login.jsx";
import MaintenanceStore from "./pages/MaintenanceStore.jsx";
import DepartmentMaster from "./pages/DepartmentMaster.jsx";
import ReportRecipientMaster from "./pages/ReportRecipientMaster.jsx";
import TvDashboard from "./pages/TvDashboard.jsx";
import { ThemeProvider } from "./context/ThemeContext.jsx";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { StoreProvider, storeHome, useStores } from "./context/StoreContext.jsx";

// Nothing behind the login is even mounted until we know who is asking — so
// no screen can fire its data calls, and hit a wall of 401s, before then.
function AuthenticatedApp() {
  const { user, checking } = useAuth();

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-navy-950">
        <div className="skeleton h-10 w-40 rounded-xl2" />
      </div>
    );
  }

  if (!user) return <Login />;

  return (
    <StoreProvider>
      <Routes>
        {/* The 53" LED "Live Dashboard": behind login, but deliberately OUTSIDE
            MainLayout — no sidebar, no top bar, it owns the whole screen. */}
        <Route path="/live-dashboard" element={<TvDashboard />} />
        <Route element={<MainLayout />}>
          {/* Stores are navigated from the sidebar, so / opens whichever one is
              in scope rather than putting a chooser in the way. */}
          <Route path="/" element={<StoreHome />} />
          <Route path="/dashboard" element={<StoreDashboard />} />
          <Route path="/store/MAINTENANCE" element={<MaintenanceStore />} />
          {/* A section is its own address, so the sidebar can link straight to
              it and the browser's back button behaves. */}
          <Route path="/store/MAINTENANCE/:sectionId" element={<MaintenanceStore />} />
          <Route path="/gate-entry" element={<GateEntry />} />
          <Route path="/srvs" element={<SRVWorkflow />} />
          <Route path="/store-stock" element={<StoreStock />} />
          <Route path="/put-away" element={<PutAway />} />
          <Route path="/holding-area" element={<HoldingArea />} />
          <Route path="/audit-trail" element={<AuditTrail />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/parts" element={<PartMaster />} />
          <Route path="/departments" element={<DepartmentMaster />} />
          <Route path="/report-recipients" element={<ReportRecipientMaster />} />
          {/* Distinct from Child Parts' /store-stock — this is the Spare
              Parts Store's own on-hand screen. */}
          <Route path="/store-stock-spare" element={<SpareStock />} />
          <Route path="/spare-erp-gap" element={<SpareErpGap />} />
          <Route path="/suppliers" element={<SupplierMaster />} />
          <Route path="/stock-count" element={<StockCount />} />
          <Route path="/rack-bins" element={<RackBinMaster />} />
          <Route path="/live-stock" element={<LiveStock />} />
          <Route path="/short-parts" element={<ShortParts />} />
          <Route path="/excess-parts" element={<ExcessParts />} />
          <Route path="/quarterly-inventory" element={<QuarterlyInventory />} />
          <Route path="/erp-gap" element={<ERPGap />} />
          <Route path="/erp-ledger-import" element={<ERPLedgerImport />} />
          <Route path="/inventory-overview" element={<InventoryOverview />} />
          <Route path="/supplier-vehicles" element={<SupplierVehicleManagement />} />
          {/* Window Schedule was merged into Supplier Vehicle Management —
              redirect so existing links/bookmarks keep working. */}
          <Route path="/supplier-window-schedule" element={<Navigate to="/supplier-vehicles" replace />} />
        </Route>
      </Routes>
    </StoreProvider>
  );
}

// The landing route. Deliberately not a hardcoded /dashboard: that path is the
// Child Parts dashboard specifically, so logging in always opened that store
// even when it was not the one in scope — and would still have opened it after
// the store was hidden. Waits for the store list rather than guessing, because
// the active store is only known once it has loaded.
function StoreHome() {
  const { activeCode, loading } = useStores();
  if (loading) return null;
  if (!activeCode) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        No store is available for this account.
      </p>
    );
  }
  return <Navigate to={storeHome(activeCode)} replace />;
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Toaster position="top-right" toastOptions={{ duration: 3500 }} />
        <AuthenticatedApp />
      </AuthProvider>
    </ThemeProvider>
  );
}
