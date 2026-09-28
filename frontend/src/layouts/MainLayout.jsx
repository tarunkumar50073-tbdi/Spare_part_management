import React, { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "../components/Sidebar.jsx";
import { useStores } from "../context/StoreContext.jsx";
import Topbar from "../components/Topbar.jsx";
import BackToTop from "../components/BackToTop.jsx";
import AssistantWidget from "../components/AssistantWidget.jsx";
import ErrorBoundary from "../components/ErrorBoundary.jsx";
import CommandPalette from "../components/CommandPalette.jsx";
import useRealtime from "../hooks/useRealtime.js";
import { PartDrawerProvider } from "../context/PartDrawerContext.jsx";

const TITLES = {
  "/dashboard": "Child Parts Store",
  "/store/MAINTENANCE": "Spare Parts Store",
  "/gate-entry": "Gate Entry",
  "/srvs": "SRV Workflow",
  "/put-away": "Pending Rack Allocation",
  "/holding-area": "Holding Area",
  "/store-stock": "Store Stock",
  "/scan-part": "Scan Part",
  "/scan-audit": "Scan Audit",
  "/spare-part-history": "Part Ledger",
  "/reports": "Reports",
  "/audit-trail": "Audit Trail",
  "/parts": "Part Master",
  "/suppliers": "Supplier Master",
  "/stock-count": "Daily Stock Count",
  "/rack-bins": "Rack/Bin Master",
  "/inventory-overview": "Inventory Overview",
  "/supplier-vehicles": "Supplier Vehicle Management",
  "/vehicle-in-out": "Vehicle In / Out",
  "/admin": "User Management",
  "/settings": "Settings",
  "/store-stock-spare": "Store Stock",
  "/spare-erp-gap": "ERP vs Physical Gap",
  "/departments": "Department Emails",
  "/services": "All Services",
  "/inventory-control": "Critical · Reorder · Excess",
  "/consumption": "Consumption Analytics",
  "/receiving": "Receiving & GRN",
  "/erp-control": "ERP Control Center",
  "/data-quality": "Data Quality",
  "/notifications": "Notifications",
  "/work-queue": "Work Queue",
  "/employees": "Employee Master",
  "/equipment": "Line / Machine / Die Master",
};

// Below this width the full rail (w-64) would leave a phone or small tablet a
// sliver of page, so the rail starts squeezed there whatever was saved.
const NARROW = "(max-width: 767px)";
function useNarrow() {
  const [narrow, setNarrow] = useState(() => {
    try { return window.matchMedia(NARROW).matches; } catch { return false; }
  });
  useEffect(() => {
    let mq;
    try { mq = window.matchMedia(NARROW); } catch { return undefined; }
    const on = (e) => setNarrow(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

export default function MainLayout() {
  // A persistent rail that squeezes to an icon-only strip and expands back; the
  // Topbar's panel icon toggles it, and the choice is remembered across reloads.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("dx_sidebar_collapsed") === "1"; } catch { return false; }
  });
  // On a narrow screen the rail is squeezed by default and the toggle opens it
  // for that visit only — the saved desktop preference is left alone.
  const narrow = useNarrow();
  const [narrowOpen, setNarrowOpen] = useState(false);
  const toggleSidebar = () => {
    if (narrow) { setNarrowOpen((o) => !o); return; }
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem("dx_sidebar_collapsed", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };
  const railCollapsed = narrow ? !narrowOpen : collapsed;

  const location = useLocation();
  useRealtime();   // one SSE connection for the whole shell
  const { activeStore } = useStores();
  // On a section page the heading is that section's own name (Press Shop …),
  // read from the store master by the id in the path.
  const sectionMatch = location.pathname.match(/^\/store\/[^/]+\/(\d+)$/);
  const section = sectionMatch && (activeStore?.sections || []).find((s) => String(s.id) === sectionMatch[1]);
  // The dashboard is one route shared by every store, so its heading comes
  // from whichever store is in scope rather than from the path.
  const title = section
    ? section.name
    : location.pathname === "/dashboard"
      ? activeStore?.name || "Store Dashboard"
      : TITLES[location.pathname] || "TBDI Digital Store";

  return (
    // One part drawer for every screen in the shell (and Ctrl+K) — see
    // context/PartDrawerContext.
    <PartDrawerProvider>
    <div className="min-h-screen flex">
      <Sidebar collapsed={railCollapsed} onToggle={toggleSidebar} />
      <div className="flex-1 flex flex-col min-w-0">
        {/* The global part search is in the header on every screen — including
            sections — so the top bar reads the same everywhere. */}
        <Topbar title={title} />
        {/* Now the rail is an overlay, the content spans the full width — cap and
            centre it so the cards keep their intended density (a huge gap opened
            in the KPI tiles once they stretched edge to edge). */}
        <main className="flex-1 overflow-x-hidden">
          <div className="max-w-[1600px] mx-auto p-4 lg:p-8">
            <ErrorBoundary resetKey={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <BackToTop />
      <AssistantWidget />
      <CommandPalette />
    </div>
    </PartDrawerProvider>
  );
}
