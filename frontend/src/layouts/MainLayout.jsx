import React, { useEffect, useState } from "react";
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
};

const COLLAPSED_KEY = "dx_sidebar_collapsed";

export default function MainLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Desktop-only, and remembered: a wall monitor set to full width should come
  // back that way after a reboot rather than needing someone to hide the rail
  // again every morning.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  const location = useLocation();
  const { activeStore } = useStores();
  // The dashboard is one route shared by every store, so its heading comes
  // from whichever store is in scope rather than from the path.
  const title =
    location.pathname === "/dashboard"
      ? activeStore?.name || "Store Dashboard"
      : TITLES[location.pathname] || "Part Store";

  return (
    <div className="min-h-screen flex">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
      />
      <div className="flex-1 flex flex-col min-w-0">
        {/* The top bar's menu button is the way back once the rail is hidden —
            the logo that collapsed it goes with it, so without this there
            would be no control left to bring it back. */}
        <Topbar
          title={title}
          showMenu={collapsed}
          onMenuClick={() => {
            setSidebarOpen(true);
            setCollapsed(false);
          }}
        />
        <main className="flex-1 p-4 lg:p-8 overflow-x-hidden">
          <Outlet />
        </main>
      </div>
      <BackToTop />
    </div>
  );
}
