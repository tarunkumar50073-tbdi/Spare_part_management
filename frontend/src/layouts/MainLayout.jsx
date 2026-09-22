import React, { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "../components/Sidebar.jsx";
import { useStores } from "../context/StoreContext.jsx";
import Topbar from "../components/Topbar.jsx";
import BackToTop from "../components/BackToTop.jsx";

const TITLES = {
  "/dashboard": "Child Parts Store",
  "/store/MAINTENANCE": "Spare Parts Store",
  "/gate-entry": "Gate Entry",
  "/srvs": "SRV Workflow",
  "/put-away": "Pending Rack Allocation",
  "/holding-area": "Holding Area",
  "/store-stock": "Store Stock",
  "/scan-part": "Scan Part",
  "/supplier-barcodes": "Supplier Barcode Mapping",
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
};

export default function MainLayout() {
  // A persistent rail that squeezes to an icon-only strip and expands back; the
  // Topbar's panel icon toggles it, and the choice is remembered across reloads.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("dx_sidebar_collapsed") === "1"; } catch { return false; }
  });
  const toggleSidebar = () => setCollapsed((c) => {
    const next = !c;
    try { localStorage.setItem("dx_sidebar_collapsed", next ? "1" : "0"); } catch { /* ignore */ }
    return next;
  });

  const location = useLocation();
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
      : TITLES[location.pathname] || "Spare Part Store Management";

  return (
    <div className="min-h-screen flex">
      <Sidebar collapsed={collapsed} />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Search sits in the header (in the gap between the title and the
            actions) on the main screens — not repeated inside every section. */}
        <Topbar title={title} onMenuClick={toggleSidebar} collapsed={collapsed} showSearch={!section} />
        {/* Now the rail is an overlay, the content spans the full width — cap and
            centre it so the cards keep their intended density (a huge gap opened
            in the KPI tiles once they stretched edge to edge). */}
        <main className="flex-1 overflow-x-hidden">
          <div className="max-w-[1600px] mx-auto p-4 lg:p-8">
            <Outlet />
          </div>
        </main>
      </div>
      <BackToTop />
    </div>
  );
}
