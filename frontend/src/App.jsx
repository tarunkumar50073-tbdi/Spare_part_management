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
import { can } from "./utils/permissions.js";
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
const RightsMatrix = React.lazy(() => import("./pages/RightsMatrix.jsx"));
const Settings = React.lazy(() => import("./pages/Settings.jsx"));
const AllServices = React.lazy(() => import("./pages/AllServices.jsx"));
const ErpControlCenter = React.lazy(() => import("./pages/spare/ErpControlCenter.jsx"));
const ReceivingMonitor = React.lazy(() => import("./pages/spare/ReceivingMonitor.jsx"));
const ShortRejection = React.lazy(() => import("./pages/spare/ShortRejection.jsx"));
const InventoryControl = React.lazy(() => import("./pages/spare/InventoryControl.jsx"));
const ConsumptionAnalytics = React.lazy(() => import("./pages/spare/ConsumptionAnalytics.jsx"));
const IssuanceReport = React.lazy(() => import("./pages/spare/IssuanceReport.jsx"));
const DataQuality = React.lazy(() => import("./pages/spare/DataQuality.jsx"));
const NotificationCenter = React.lazy(() => import("./pages/spare/NotificationCenter.jsx"));
const WorkQueue = React.lazy(() => import("./pages/spare/WorkQueue.jsx"));
const ConfirmInstallation = React.lazy(() => import("./pages/spare/ConfirmInstallation.jsx"));
const PutAwayCheck = React.lazy(() => import("./pages/spare/PutAwayCheck.jsx"));
const EmployeeMaster = React.lazy(() => import("./pages/EmployeeMaster.jsx"));
const EquipmentMaster = React.lazy(() => import("./pages/EquipmentMaster.jsx"));
const KioskRequest = React.lazy(() => import("./pages/spare/KioskRequest.jsx"));
const PartRequests = React.lazy(() => import("./pages/spare/PartRequests.jsx"));
const ActionTracker = React.lazy(() => import("./pages/spare/ActionTracker.jsx"));
const EmailControlCenter = React.lazy(() => import("./pages/email/ControlCenter.jsx"));
const EmailWorkflowCenter = React.lazy(() => import("./pages/email/WorkflowCenter.jsx"));
const EmailConfiguration = React.lazy(() => import("./pages/email/EmailConfiguration.jsx"));
const EmailTemplates = React.lazy(() => import("./pages/email/EmailTemplates.jsx"));
const SendEmailAlert = React.lazy(() => import("./pages/email/SendEmailAlert.jsx"));
const EmailQueue = React.lazy(() => import("./pages/email/EmailQueue.jsx"));
const EmailLogs = React.lazy(() => import("./pages/email/EmailLogs.jsx"));
const NotificationRules = React.lazy(() => import("./pages/email/NotificationRules.jsx"));
const ReminderEscalation = React.lazy(() => import("./pages/email/ReminderEscalation.jsx"));

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

// Put-away Check is the third mode of Scan Part's header now. Its own address
// still works: it lands there for whoever can open Scan Part, and stays a page
// of its own for a user who holds Store Stock but not Scan Part.
function PutAwayCheckRoute() {
  const { user } = useAuth();
  return can(user, "scan_part") ? <Navigate to="/scan-part?mode=putaway" replace /> : <PutAwayCheck />;
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
        {/* Kiosk (outside the locked store): a touchscreen request screen — like
            the Live Dashboard it owns the whole screen, no sidebar/top bar. */}
        <Route path="/kiosk" element={<RequirePermission mod="kiosk"><KioskRequest /></RequirePermission>} />
        <Route element={<MainLayout />}>
          {/* Stores are navigated from the sidebar, so / opens whichever one is
              in scope rather than putting a chooser in the way. */}
          <Route path="/" element={<StoreHome />} />
          <Route path="/dashboard" element={<StoreRoute store="CHILD_PART"><StoreDashboard /></StoreRoute>} />
          <Route path="/store/MAINTENANCE" element={<RequirePermission mod="spare_store"><MaintenanceStore /></RequirePermission>} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/rights-matrix" element={<RightsMatrix />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/services" element={<AllServices />} />
          {/* A section is its own address, so the sidebar can link straight to
              it and the browser's back button behaves. */}
          {/* A section GROUP (e.g. Tool Room) is its own address too — one page
              with a dropdown over its sibling sections. Four segments, so it
              never collides with the three-segment section route below. */}
          <Route path="/store/MAINTENANCE/group/:groupName" element={<RequirePermission mod="spare_store"><MaintenanceStore /></RequirePermission>} />
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
          <Route path="/equipment" element={<RequirePermission mod="equipment"><EquipmentMaster /></RequirePermission>} />
          <Route path="/report-recipients" element={<ReportRecipientMaster />} />
          <Route path="/part-history" element={<StoreRoute store="CHILD_PART"><PartHistory /></StoreRoute>} />
          <Route path="/vehicle-in-out" element={<RequirePermission mod="vehicle_in_out"><VehicleInOut /></RequirePermission>} />
          <Route path="/window-time" element={<WindowTimeBoard />} />
          <Route path="/current-stock" element={<StoreRoute store="CHILD_PART"><CurrentStock /></StoreRoute>} />
          {/* Distinct from Child Parts' /store-stock — this is the Spare
              Parts Store's own on-hand screen. */}
          <Route path="/store-stock-spare" element={<RequirePermission mod="store_stock"><SpareStock /></RequirePermission>} />
          <Route path="/scan-part" element={<RequirePermission mod="scan_part"><ScanPart /></RequirePermission>} />
          {/* Supplier barcodes are seen and mapped on Scan Part now (each
              part's Barcodes panel, and Receive & Label for material just in) —
              redirect so existing links/bookmarks keep working. */}
          <Route path="/supplier-barcodes" element={<Navigate to="/scan-part?mode=label" replace />} />
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
          {/* What suppliers sent short and quality rejected — the Receiving & GRN right (17 Oct 2026). */}
          <Route path="/short-rejection" element={<RequirePermission mod="spare_store"><ShortRejection /></RequirePermission>} />
          <Route path="/inventory-control" element={<RequirePermission mod="store_stock"><InventoryControl /></RequirePermission>} />
          {/* Two reports since 17 Oct 2026 ("issuance and consumption ki report alag alag chahiye"),
              behind the spare_store right the one Issuance & Consumption screen had. */}
          <Route path="/issuance" element={<RequirePermission mod="spare_store"><IssuanceReport /></RequirePermission>} />
          <Route path="/consumption" element={<RequirePermission mod="spare_store"><ConsumptionAnalytics /></RequirePermission>} />
          <Route path="/data-quality" element={<RequirePermission mod="part_master"><DataQuality /></RequirePermission>} />
          <Route path="/notifications" element={<NotificationCenter />} />
          {/* QR traceability: every open receipt / return / RGP / issue awaiting a step. */}
          <Route path="/work-queue" element={<RequirePermission mod="scan_part"><WorkQueue /></RequirePermission>} />
          <Route path="/confirm-installation" element={<RequirePermission mod="install_confirm"><ConfirmInstallation /></RequirePermission>} />
          <Route path="/put-away-check" element={<RequirePermission mod="store_stock"><PutAwayCheckRoute /></RequirePermission>} />
          <Route path="/part-requests" element={<RequirePermission mod="scan_part"><PartRequests /></RequirePermission>} />
          {/* Summary of issues · owner · target — the management view of the store. */}
          <Route path="/action-tracker" element={<RequirePermission mod="spare_store"><ActionTracker /></RequirePermission>} />
          {/* Email & Notifications — administrators only; each page gates itself
              (AdminOnly), like Settings does. */}
          <Route path="/email/control-center" element={<EmailControlCenter />} />
          <Route path="/email/workflows" element={<EmailWorkflowCenter />} />
          <Route path="/email/configuration" element={<EmailConfiguration />} />
          <Route path="/email/templates" element={<EmailTemplates />} />
          <Route path="/email/send" element={<SendEmailAlert />} />
          <Route path="/email/queue" element={<EmailQueue />} />
          <Route path="/email/logs" element={<EmailLogs />} />
          <Route path="/email/rules" element={<NotificationRules />} />
          <Route path="/email/reminders" element={<ReminderEscalation />} />
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
//
// A login without the Spare Parts Store dashboard right — the Line User, Kiosk
// device and Live Board templates (store's role templates, 17 Oct 2026) — would
// land on "Access restricted" there. It goes to the first screen it may open
// instead, in this order, and to All Services when it may open none of them.
const FIRST_SCREENS = [
  { to: "/scan-part", mod: "scan_part" },
  { to: "/confirm-installation", mod: "install_confirm" },
  { to: "/kiosk", mod: "kiosk" },
  { to: "/live-dashboard", mod: "live_dashboard" },
  { to: "/store-stock-spare", mod: "store_stock" },
  { to: "/reports", mod: "reports" },
];

function StoreHome() {
  const { user } = useAuth();
  const { activeCode, loading } = useStores();
  if (loading) return null;
  if (!activeCode) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        No store is available for this account.
      </p>
    );
  }
  if (activeCode === "MAINTENANCE" && !can(user, "spare_store")) {
    const first = FIRST_SCREENS.find((s) => can(user, s.mod));
    return <Navigate to={first ? first.to : "/services"} replace />;
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
            {/* TEST instance marker — only on the dummy copy. Detected by the
                test frontend's own port (5174, set in start-test.bat) or the
                VITE_TEST_MODE flag. A fixed, click-through badge so it is always
                visible but never blocks the UI; production (5173) never shows it. */}
            {(import.meta.env.VITE_TEST_MODE === "1"
              || (typeof window !== "undefined" && window.location.port === "5174")) && (
              <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999, pointerEvents: "none" }}
                className="flex justify-center">
                <span className="rounded-b-lg bg-amber-500 px-4 py-1 text-xs font-bold text-white shadow-lg">
                  ⚠ TEST MODE — dummy data · real stock / history pe koi asar nahi
                </span>
              </div>
            )}
            <AuthenticatedApp />
          </ConfirmProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
