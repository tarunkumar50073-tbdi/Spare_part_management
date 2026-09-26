import React, { Suspense, useEffect } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient.js";
import MainLayout from "./layouts/MainLayout.jsx";
import Login from "./pages/Login.jsx";
import { ThemeProvider } from "./context/ThemeContext.jsx";
import { AuthProvider, useAuth } from "./context/AuthContext.jsx";
import { StoreProvider, storeHome, useStores } from "./context/StoreContext.jsx";
import RequirePermission from "./components/RequirePermission.jsx";
import StoreRoute from "./components/StoreRoute.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { ConfirmProvider } from "./components/ConfirmDialog.jsx";

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
const NotFound = React.lazy(() => import("./pages/NotFound.jsx"));
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
const Settings = React.lazy(() => import("./pages/Settings.jsx"));
const AllServices = React.lazy(() => import("./pages/AllServices.jsx"));
const ErpControlCenter = React.lazy(() => import("./pages/spare/ErpControlCenter.jsx"));
const ReceivingMonitor = React.lazy(() => import("./pages/spare/ReceivingMonitor.jsx"));
const InventoryControl = React.lazy(() => import("./pages/spare/InventoryControl.jsx"));
const ConsumptionAnalytics = React.lazy(() => import("./pages/spare/ConsumptionAnalytics.jsx"));
const DataQuality = React.lazy(() => import("./pages/spare/DataQuality.jsx"));
const NotificationCenter = React.lazy(() => import("./pages/spare/NotificationCenter.jsx"));
const WorkQueue = React.lazy(() => import("./pages/spare/WorkQueue.jsx"));
const EmployeeMaster = React.lazy(() => import("./pages/EmployeeMaster.jsx"));

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
      <ErrorBoundary full>
      <Suspense fallback={<PageFallback />}>
      <Routes>
        {/* The 53" LED "Live Dashboard": behind login, but deliberately OUTSIDE
            MainLayout — no sidebar, no top bar, it owns the whole screen. */}
        <Route path="/live-dashboard" element={<RequirePermission mod="live_dashboard"><TvDashboard /></RequirePermission>} />
        <Route element={<MainLayout />}>
          {/* Stores are navigated from the sidebar, so / opens whichever one is
              in scope rather than putting a chooser in the way. */}
          <Route path="/" element={<StoreHome />} />
          <Route path="/dashboard" element={<StoreRoute store="CHILD_PART"><StoreDashboard /></StoreRoute>} />
          <Route path="/store/MAINTENANCE" element={<RequirePermission mod="spare_store"><MaintenanceStore /></RequirePermission>} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/services" element={<AllServices />} />
          {/* A section is its own address, so the sidebar can link straight to
              it and the browser's back button behaves. */}
          <Route path="/store/MAINTENANCE/:sectionId" element={<RequirePermission mod="spare_store"><MaintenanceStore /></RequirePermission>} />
          <Route path="/gate-entry" element={<RequirePermission mod="gate_entry"><GateEntry /></RequirePermission>} />
          <Route path="/srvs" element={<StoreRoute store="CHILD_PART"><SRVWorkflow /></StoreRoute>} />
          <Route path="/store-stock" element={<StoreRoute store="CHILD_PART"><StoreStock /></StoreRoute>} />
          <Route path="/put-away" element={<StoreRoute store="CHILD_PART"><PutAway /></StoreRoute>} />
          <Route path="/holding-area" element={<StoreRoute store="CHILD_PART"><HoldingArea /></StoreRoute>} />
          <Route path="/audit-trail" element={<RequirePermission mod="audit_trail"><AuditTrail /></RequirePermission>} />
          <Route path="/reports" element={<RequirePermission mod="reports"><Reports /></RequirePermission>} />
          <Route path="/parts" element={<RequirePermission mod="part_master"><PartMaster /></RequirePermission>} />
          <Route path="/departments" element={<RequirePermission mod="departments"><DepartmentMaster /></RequirePermission>} />
          <Route path="/employees" element={<RequirePermission mod="employees"><EmployeeMaster /></RequirePermission>} />
          <Route path="/report-recipients" element={<ReportRecipientMaster />} />
          <Route path="/part-history" element={<StoreRoute store="CHILD_PART"><PartHistory /></StoreRoute>} />
          <Route path="/vehicle-in-out" element={<RequirePermission mod="vehicle_in_out"><VehicleInOut /></RequirePermission>} />
          <Route path="/window-time" element={<WindowTimeBoard />} />
          <Route path="/current-stock" element={<StoreRoute store="CHILD_PART"><CurrentStock /></StoreRoute>} />
          {/* Distinct from Child Parts' /store-stock — this is the Spare
              Parts Store's own on-hand screen. */}
          <Route path="/store-stock-spare" element={<RequirePermission mod="store_stock"><SpareStock /></RequirePermission>} />
          <Route path="/scan-part" element={<RequirePermission mod="scan_part"><ScanPart /></RequirePermission>} />
          <Route path="/supplier-barcodes" element={<RequirePermission mod="supplier_barcodes"><SupplierBarcodeMapping /></RequirePermission>} />
          <Route path="/scan-audit" element={<RequirePermission mod="scan_audit"><ScanAudit /></RequirePermission>} />
          <Route path="/spare-part-history" element={<RequirePermission mod="part_ledger"><SparePartHistory /></RequirePermission>} />
          <Route path="/spare-erp-gap" element={<RequirePermission mod="erp_gap"><SpareErpGap /></RequirePermission>} />
          <Route path="/suppliers" element={<SupplierMaster />} />
          <Route path="/stock-count" element={<StoreRoute store="CHILD_PART"><StockCount /></StoreRoute>} />
          <Route path="/rack-bins" element={<StoreRoute store="CHILD_PART"><RackBinMaster /></StoreRoute>} />
          <Route path="/live-stock" element={<StoreRoute store="CHILD_PART"><LiveStock /></StoreRoute>} />
          <Route path="/short-parts" element={<StoreRoute store="CHILD_PART"><ShortParts /></StoreRoute>} />
          <Route path="/excess-parts" element={<StoreRoute store="CHILD_PART"><ExcessParts /></StoreRoute>} />
          <Route path="/quarterly-inventory" element={<StoreRoute store="CHILD_PART"><QuarterlyInventory /></StoreRoute>} />
          <Route path="/erp-gap" element={<StoreRoute store="CHILD_PART"><ERPGap /></StoreRoute>} />
          <Route path="/erp-ledger-import" element={<StoreRoute store="CHILD_PART"><ERPLedgerImport /></StoreRoute>} />
          <Route path="/inventory-overview" element={<StoreRoute store="CHILD_PART"><InventoryOverview /></StoreRoute>} />
          <Route path="/supplier-vehicles" element={<SupplierVehicleManagement />} />
          {/* Window Schedule was merged into Supplier Vehicle Management —
              redirect so existing links/bookmarks keep working. */}
          <Route path="/supplier-window-schedule" element={<Navigate to="/supplier-vehicles" replace />} />
          {/* Spare Parts Store control screens (enterprise spec, phases 7-12). */}
          <Route path="/erp-control" element={<RequirePermission mod="erp_gap"><ErpControlCenter /></RequirePermission>} />
          <Route path="/receiving" element={<RequirePermission mod="spare_store"><ReceivingMonitor /></RequirePermission>} />
          <Route path="/inventory-control" element={<RequirePermission mod="store_stock"><InventoryControl /></RequirePermission>} />
          <Route path="/consumption" element={<RequirePermission mod="spare_store"><ConsumptionAnalytics /></RequirePermission>} />
          <Route path="/data-quality" element={<RequirePermission mod="part_master"><DataQuality /></RequirePermission>} />
          <Route path="/notifications" element={<NotificationCenter />} />
          {/* QR traceability: every open receipt / return / RGP / issue awaiting a step. */}
          <Route path="/work-queue" element={<RequirePermission mod="scan_part"><WorkQueue /></RequirePermission>} />
          {/* Anything else: say so, instead of an empty page inside the layout. */}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      </Suspense>
      </ErrorBoundary>
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
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <ConfirmProvider>
            <Toaster position="top-right" toastOptions={{ duration: 3500 }} />
            <AuthenticatedApp />
          </ConfirmProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
