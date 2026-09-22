import React, { Suspense, useEffect } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import MainLayout from "./layouts/MainLayout.jsx";
import Login from "./pages/Login.jsx";
import { ThemeProvider } from "./context/ThemeContext.jsx";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { StoreProvider, storeHome, useStores } from "./context/StoreContext.jsx";

// Route pages are code-split: each loads its own chunk on demand, so opening the
// app no longer downloads all ~35 screens (plus recharts / xlsx / zxing) up
// front. MainLayout and Login stay eager — the shell and the pre-auth screen.
const StoreDashboard = React.lazy(() => import("./pages/StoreDashboard.jsx"));
const GateEntry = React.lazy(() => import("./pages/GateEntry.jsx"));
const SRVWorkflow = React.lazy(() => import("./pages/SRVWorkflow.jsx"));
const StoreStock = React.lazy(() => import("./pages/StoreStock.jsx"));
const PutAway = React.lazy(() => import("./pages/PutAway.jsx"));
const HoldingArea = React.lazy(() => import("./pages/HoldingArea.jsx"));
const AuditTrail = React.lazy(() => import("./pages/AuditTrail.jsx"));
const Reports = React.lazy(() => import("./pages/Reports.jsx"));
const PartMaster = React.lazy(() => import("./pages/PartMaster.jsx"));
const SpareStock = React.lazy(() => import("./pages/SpareStock.jsx"));
const ScanPart = React.lazy(() => import("./pages/ScanPart.jsx"));
const SupplierBarcodeMapping = React.lazy(() => import("./pages/SupplierBarcodeMapping.jsx"));
const ScanAudit = React.lazy(() => import("./pages/ScanAudit.jsx"));
const SparePartHistory = React.lazy(() => import("./pages/SparePartHistory.jsx"));
const SupplierMaster = React.lazy(() => import("./pages/SupplierMaster.jsx"));
const StockCount = React.lazy(() => import("./pages/StockCount.jsx"));
const RackBinMaster = React.lazy(() => import("./pages/RackBinMaster.jsx"));
const LiveStock = React.lazy(() => import("./pages/LiveStock.jsx"));
const ShortParts = React.lazy(() => import("./pages/ShortParts.jsx"));
const ExcessParts = React.lazy(() => import("./pages/ExcessParts.jsx"));
const QuarterlyInventory = React.lazy(() => import("./pages/QuarterlyInventory.jsx"));
const ERPGap = React.lazy(() => import("./pages/ERPGap.jsx"));
const SpareErpGap = React.lazy(() => import("./pages/SpareErpGap.jsx"));
const ERPLedgerImport = React.lazy(() => import("./pages/ERPLedgerImport.jsx"));
const InventoryOverview = React.lazy(() => import("./pages/InventoryOverview.jsx"));
const SupplierVehicleManagement = React.lazy(() => import("./pages/SupplierVehicleManagement.jsx"));
const MaintenanceStore = React.lazy(() => import("./pages/MaintenanceStore.jsx"));
const DepartmentMaster = React.lazy(() => import("./pages/DepartmentMaster.jsx"));
const ReportRecipientMaster = React.lazy(() => import("./pages/ReportRecipientMaster.jsx"));
const PartHistory = React.lazy(() => import("./pages/PartHistory.jsx"));
const VehicleInOut = React.lazy(() => import("./pages/VehicleInOut.jsx"));
const CurrentStock = React.lazy(() => import("./pages/CurrentStock.jsx"));
const WindowTimeBoard = React.lazy(() => import("./pages/WindowTimeBoard.jsx"));
const TvDashboard = React.lazy(() => import("./pages/TvDashboard.jsx"));
const Admin = React.lazy(() => import("./pages/Admin.jsx"));

// SPA navigation (and browser reloads) don't reset scroll on their own, so
// coming back from the Live Dashboard — or reopening the app — used to land
// halfway down a long page (wherever it was last scrolled). Reset to the top on
// every route change, and turn off the browser's own scroll restoration so a
// reload starts at the top too.
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

// Shown while a route's chunk loads — brief, since chunks are small and cached.
function PageFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-navy-950">
      <div className="skeleton h-10 w-40 rounded-xl2" />
    </div>
  );
}

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
      <ScrollToTop />
      <Suspense fallback={<PageFallback />}>
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
          <Route path="/admin" element={<Admin />} />
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
          <Route path="/part-history" element={<PartHistory />} />
          <Route path="/vehicle-in-out" element={<VehicleInOut />} />
          <Route path="/window-time" element={<WindowTimeBoard />} />
          <Route path="/current-stock" element={<CurrentStock />} />
          {/* Distinct from Child Parts' /store-stock — this is the Spare
              Parts Store's own on-hand screen. */}
          <Route path="/store-stock-spare" element={<SpareStock />} />
          <Route path="/scan-part" element={<ScanPart />} />
          <Route path="/supplier-barcodes" element={<SupplierBarcodeMapping />} />
          <Route path="/scan-audit" element={<ScanAudit />} />
          <Route path="/spare-part-history" element={<SparePartHistory />} />
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
      </Suspense>
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
