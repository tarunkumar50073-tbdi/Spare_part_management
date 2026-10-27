import React, { Suspense, useEffect, useRef } from "react";
import { Routes, Route, Navigate, useLocation, useNavigationType } from "react-router-dom";
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
const PartPhotos = React.lazy(() => import("./pages/spare/PartPhotos.jsx"));
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
const PartKiosk = React.lazy(() => import("./pages/spare/PartKiosk.jsx"));
const Admin = React.lazy(() => import("./pages/Admin.jsx"));
const RightsMatrix = React.lazy(() => import("./pages/RightsMatrix.jsx"));
const Settings = React.lazy(() => import("./pages/Settings.jsx"));
const AllServices = React.lazy(() => import("./pages/AllServices.jsx"));
const ErpControlCenter = React.lazy(() => import("./pages/spare/ErpControlCenter.jsx"));
const ReceivingMonitor = React.lazy(() => import("./pages/spare/ReceivingMonitor.jsx"));
const ShortRejection = React.lazy(() => import("./pages/spare/ShortRejection.jsx"));
const ChallanRegister = React.lazy(() => import("./pages/spare/ChallanRegister.jsx"));
const RejectionRequests = React.lazy(() => import("./pages/spare/RejectionRequests.jsx"));
const PacketManagement = React.lazy(() => import("./pages/spare/PacketManagement.jsx"));
const JobWork = React.lazy(() => import("./pages/spare/JobWork.jsx"));
const DataBrowser = React.lazy(() => import("./pages/DataBrowser.jsx"));
const InventoryControl = React.lazy(() => import("./pages/spare/InventoryControl.jsx"));
const ConsumptionAnalytics = React.lazy(() => import("./pages/spare/ConsumptionAnalytics.jsx"));
const DataQuality = React.lazy(() => import("./pages/spare/DataQuality.jsx"));
const NotificationCenter = React.lazy(() => import("./pages/spare/NotificationCenter.jsx"));
const WorkQueue = React.lazy(() => import("./pages/spare/WorkQueue.jsx"));
const ConfirmInstallation = React.lazy(() => import("./pages/spare/ConfirmInstallation.jsx"));
const PutAwayCheck = React.lazy(() => import("./pages/spare/PutAwayCheck.jsx"));
const EmployeeMaster = React.lazy(() => import("./pages/EmployeeMaster.jsx"));
const EquipmentMaster = React.lazy(() => import("./pages/EquipmentMaster.jsx"));
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
//
// Except going BACK (22 Oct 2026: "jab click karke kholte h ... back karne par
// wahi aaye jahan khola tha upar na jaaye"): each page's scroll position is
// remembered while it is on screen, and Back / Forward return to it. The page
// fills in as its data arrives, so the position is retried for a moment until
// the page is tall enough — and given up the moment the user scrolls himself.
export function ScrollToTop() {
  const location = useLocation();
  const navType = useNavigationType();
  const positions = useRef({});          // location.key -> scrollY when last seen
  const lastPath = useRef(location.pathname);
  useEffect(() => {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
  }, []);
  // Remember where this page is scrolled to, as the user scrolls it.
  useEffect(() => {
    const key = location.key;
    let frame = 0;
    const note = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { positions.current[key] = window.scrollY; });
    };
    window.addEventListener("scroll", note, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", note);
    };
  }, [location.key]);
  useEffect(() => {
    const pathChanged = lastPath.current !== location.pathname;
    lastPath.current = location.pathname;
    if (navType !== "POP") {
      // A new page starts at the top; a filter change on the same page stays put.
      if (pathChanged) window.scrollTo(0, 0);
      return undefined;
    }
    const target = positions.current[location.key];
    if (!target) {
      window.scrollTo(0, 0);
      return undefined;
    }
    let tries = 0;
    let timer = 0;
    let stopped = false;
    const stop = () => { stopped = true; clearTimeout(timer); };
    const attempt = () => {
      if (stopped) return;
      window.scrollTo(0, target);
      if (Math.abs(window.scrollY - target) > 2 && tries++ < 40) timer = setTimeout(attempt, 60);
    };
    attempt();
    // The user taking over ends the restore.
    const events = ["wheel", "touchstart", "keydown", "mousedown"];
    events.forEach((e) => window.addEventListener(e, stop, { passive: true, once: true }));
    return () => {
      stop();
      events.forEach((e) => window.removeEventListener(e, stop));
    };
  }, [location.key, location.pathname, navType]);
  return null;
}

// Put-away Check is the third mode of Scan Part's header now. Its own address
// still works: it lands there for whoever can open Scan Part, and stays a page
// of its own for a user who holds Store Stock but not Scan Part.
function PutAwayCheckRoute() {
  const { user } = useAuth();
  return can(user, "scan_part") ? <Navigate to="/scan-part?mode=putaway" replace /> : <PutAwayCheck />;
}

// The Issuance Report was its own screen for a day (17 Oct 2026); it is one
// report with Consumption again since 18 Oct 2026 ("issuance and consumption
// report same dikh rhi h dono me differance nhi to ye kaam merge me bhi ho
// sakta h" — the store). An old /issuance link or bookmark lands there with
// its period, view and filters — all but its Department, which there meant who
// TOOK the parts (often "Store"); here it is who used them, so it is dropped.
function IssuanceRedirect() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.delete("dept");
  const search = params.toString();
  return <Navigate to={`/consumption${search ? `?${search}` : ""}`} replace />;
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
        {/* The Part Search kiosk outside the spare store (25 Oct 2026) — read
            only, and like the Live Board it owns the whole screen. */}
        <Route path="/part-search" element={<RequirePermission mod="part_kiosk"><PartKiosk /></RequirePermission>} />
        {/* No /kiosk and no /part-requests any more: the store dropped the kiosk
            request and its Part Requisition queue on 17 Oct 2026 ("management k
            according manual detail fill karke issuance karna time waste h") —
            parts are issued on Scan Part -> Issue. An old bookmark of either
            falls through to "page not found" below. */}
        <Route element={<MainLayout />}>
          {/* Stores are navigated from the sidebar, so / opens whichever one is
              in scope rather than putting a chooser in the way. */}
          <Route path="/" element={<StoreHome />} />
          <Route path="/dashboard" element={<StoreRoute store="CHILD_PART"><StoreDashboard /></StoreRoute>} />
          <Route path="/store/MAINTENANCE" element={<RequirePermission mod="spare_store"><MaintenanceStore /></RequirePermission>} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/data-browser" element={<DataBrowser />} />
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
          {/* Photo Mode: part photos rack by rack on a tablet (21 Oct 2026),
              opened from the Part Master's button — it has no menu item or
              right of its own (23 Oct 2026). */}
          <Route path="/part-photos" element={<RequirePermission mod="part_master"><PartPhotos /></RequirePermission>} />
          <Route path="/departments" element={<RequirePermission mod="departments"><DepartmentMaster /></RequirePermission>} />
          <Route path="/employees" element={<RequirePermission mod="employees"><EmployeeMaster /></RequirePermission>} />
          <Route path="/equipment" element={<RequirePermission mod="part_master"><EquipmentMaster /></RequirePermission>} />
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
              part's Barcodes panel, which Issue mode shows) — redirect so
              existing links/bookmarks keep working. (It went to the Receive &
              Lot Tag mode, removed on 17 Oct 2026 with the lot tags.) Issue is
              named, so a terminal last left in Put-away Check — which has no
              Barcodes panel — still lands where the barcodes are. */}
          <Route path="/supplier-barcodes" element={<Navigate to="/scan-part?mode=issue" replace />} />
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
          <Route path="/erp-control" element={<RequirePermission mod="erp_control"><ErpControlCenter /></RequirePermission>} />
          <Route path="/receiving" element={<RequirePermission mod="receiving"><ReceivingMonitor /></RequirePermission>} />
          {/* What suppliers sent short and quality rejected — the Receiving & GRN right (17 Oct 2026). */}
          <Route path="/short-rejection" element={<RequirePermission mod="short_rejection"><ShortRejection /></RequirePermission>} />
          {/* Urgent spares in on a supplier challan before the PO / invoice — a register only, never stock (21 Oct 2026). */}
          <Route path="/challans" element={<RequirePermission mod="challan_register"><ChallanRegister /></RequirePermission>} />
          {/* The one mail to RQC to punch an SRV / line rejection (22 Oct 2026). */}
          <Route path="/rejection-requests" element={<RequirePermission mod="rejection_request"><RejectionRequests /></RequirePermission>} />
          <Route path="/spare-packets" element={<RequirePermission mod="spare_packets"><PacketManagement /></RequirePermission>} />
          <Route path="/job-work" element={<RequirePermission mod="scan_part"><JobWork /></RequirePermission>} />
          <Route path="/inventory-control" element={<RequirePermission mod="inventory_control"><InventoryControl /></RequirePermission>} />
          {/* The Issuance & Consumption Report — one report again since 18 Oct 2026
              ("ye kaam merge me bhi ho sakta h"), behind the spare_store right;
              /issuance, its own screen for a day, lands on it. */}
          <Route path="/consumption" element={<RequirePermission mod="consumption"><ConsumptionAnalytics /></RequirePermission>} />
          <Route path="/issuance" element={<IssuanceRedirect />} />
          <Route path="/data-quality" element={<RequirePermission mod="data_quality"><DataQuality /></RequirePermission>} />
          <Route path="/notifications" element={<RequirePermission mod="notifications"><NotificationCenter /></RequirePermission>} />
          {/* QR traceability: every open receipt / return / RGP / issue awaiting a step. */}
          <Route path="/work-queue" element={<RequirePermission mod="work_queue"><WorkQueue /></RequirePermission>} />
          <Route path="/confirm-installation" element={<RequirePermission mod="install_confirm"><ConfirmInstallation /></RequirePermission>} />
          <Route path="/put-away-check" element={<RequirePermission mod="put_away_check"><PutAwayCheckRoute /></RequirePermission>} />
          {/* Summary of issues · owner · target — the management view of the store. */}
          <Route path="/action-tracker" element={<RequirePermission mod="action_tracker"><ActionTracker /></RequirePermission>} />
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
// A login without the Spare Parts Store dashboard right — the Line User and
// Live Board templates (store's role templates, 17 Oct 2026) — would land on
// "Access restricted" there. It goes to the first screen it may open instead,
// in this order, and to All Services when it may open none of them. That is
// also where an old Kiosk device login (the kiosk was taken out on 17 Oct 2026)
// now lands: its only right opens no screen any more.
const FIRST_SCREENS = [
  { to: "/scan-part", mod: "scan_part" },
  { to: "/confirm-installation", mod: "install_confirm" },
  { to: "/live-dashboard", mod: "live_dashboard" },
  { to: "/part-search", mod: "part_kiosk" },
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
