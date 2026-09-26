import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation } from "react-router-dom";
import {
  Activity, Archive, Barcode, BookOpen, Bolt, Boxes, Calculator, CalendarRange, Circle, ClipboardCheck,
  ClipboardList, Clock3, Container, Database, Factory, FileChartColumn, Grid3x3, History, Layers,
  LayoutGrid, LogOut, Mail, Mails, MonitorPlay, Moon, Package, PanelLeftClose, PanelLeftOpen, Scale,
  Bell, PackageCheck, ScanBarcode, ScanSearch, ScrollText, Search, ServerCog, Settings, ShieldCheck, Siren,
  Store, Sun, TrafficCone, TrendingUp, Truck, UserCog, Warehouse,
} from "lucide-react";
import Glyph, { sectionIcon } from "./Glyph.jsx";
import { storeHome, useStores } from "../context/StoreContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { can } from "../utils/permissions.js";

// Toyota Boshoku brand logo — the real company image (mark + wordmark,
// cropped from the company-supplied file, served from frontend/public).
function ToyotaBoshokuLogo({ size = 56 }) {
  return (
    <img
      src="/toyota-boshoku-logo.png"
      alt="Toyota Boshoku"
      style={{ width: size, height: "auto" }}
      draggable={false}
    />
  );
}

// Screens every store gets. Gate Entry is here because material arrives at one
// gate whichever store it is bound for — it is genuinely shared, not
// duplicated.
const SHARED_GROUPS = [
  {
    label: "Receiving",
    items: [
      { to: "/gate-entry", label: "Gate Entry", icon: Truck, mod: "gate_entry" },
      // The ERP-fed gate arrivals / vehicle in-out live here so they stay
      // reachable even when the Child store nav is off (Spare-only mode).
      { to: "/vehicle-in-out", label: "Vehicle In / Out", icon: TrafficCone, mod: "vehicle_in_out" },
    ],
  },
];

// Navigation per store. One flat list of nineteen items served fine while
// there was one store; with a second (and Consumables coming) it becomes a
// list you have to read rather than scan, most of it irrelevant to whichever
// store you are actually working in.
const NAV_BY_STORE = {
  CHILD_PART: [
    {
      label: "Receiving & Management",
      items: [
        { to: "/gate-entry", label: "Gate Entry", icon: Truck },
        { to: "/supplier-vehicles", label: "Supplier Vehicle Management", icon: Container },
        { to: "/window-time", label: "Window Time", icon: Clock3 },
        { to: "/srvs", label: "SRV Workflow", icon: ClipboardList },
        { to: "/put-away", label: "Pending Rack Allocation", icon: Grid3x3 },
        { to: "/holding-area", label: "Holding Area", icon: Archive },
        { to: "/part-history", label: "Part History", icon: Search },
        { to: "/vehicle-in-out", label: "Vehicle In / Out", icon: TrafficCone },
      ],
    },
    {
      label: "Inventory",
      items: [
        { to: "/inventory-overview", label: "Inventory Overview", icon: Calculator },
        { to: "/live-stock", label: "Live Stock", icon: Activity },
        { to: "/short-parts", label: "Short Parts", icon: Siren },
        { to: "/excess-parts", label: "Excess Parts", icon: TrendingUp },
        { to: "/store-stock", label: "Store Stock", icon: Store },
        { to: "/quarterly-inventory", label: "Quarterly Inventory", icon: CalendarRange },
        { to: "/erp-gap", label: "ERP vs Physical Gap", icon: Scale },
        { to: "/erp-ledger-import", label: "ERP Ledger Import", icon: BookOpen },
        { to: "/current-stock", label: "Current Stock (ERP)", icon: Warehouse },
        { to: "/stock-count", label: "Daily Stock Count", icon: ClipboardCheck },
      ],
    },
    {
      label: "Masters",
      items: [
        { to: "/parts", label: "Part Master", icon: Bolt },
        { to: "/suppliers", label: "Supplier Master", icon: Factory },
        { to: "/rack-bins", label: "Rack/Bin Master", icon: Boxes },
        { to: "/report-recipients", label: "Report Recipients", icon: Mails },
      ],
    },
    {
      label: "Reports & System",
      items: [
        { to: "/reports", label: "Reports", icon: FileChartColumn },
        { to: "/audit-trail", label: "Audit Trail", icon: History },
      ],
    },
  ],
  // Its own Masters group rather than falling through to SHARED_GROUPS: the
  // store's dashboard reports "298 parts without a maximum" and "127 carry no
  // rate" while Part Master lived only under Child Parts, so there was no
  // screen anywhere to fill those in from. Gate Entry is reused from
  // SHARED_GROUPS rather than repeated — one gate, both stores.
  // The Spare Parts Store's menu, grouped the way the store works: do
  // (operations), watch (inventory), receive, reconcile with ERP, keep the
  // master clean, and review (reports / alerts). Each item is rights-gated.
  MAINTENANCE: [
    {
      label: "Operations",
      items: [
        { to: "/scan-part", label: "Scan Part", icon: ScanBarcode, mod: "scan_part" },
        { to: "/work-queue", label: "Work Queue", icon: ClipboardList, mod: "scan_part" },
        { to: "/store-stock-spare", label: "Store Stock", icon: Package, mod: "store_stock" },
      ],
    },
    {
      label: "Inventory",
      items: [
        { to: "/inventory-control", label: "Critical · Reorder · Excess", icon: Siren, mod: "store_stock" },
        { to: "/consumption", label: "Consumption", icon: TrendingUp, mod: "spare_store" },
        { to: "/spare-part-history", label: "Part Ledger", icon: ScrollText, mod: "part_ledger" },
      ],
    },
    {
      label: "Receiving",
      items: [
        { to: "/receiving", label: "Receiving & GRN", icon: PackageCheck, mod: "spare_store" },
        { to: "/gate-entry", label: "Gate Entry", icon: Truck, mod: "gate_entry" },
        { to: "/vehicle-in-out", label: "Vehicle In / Out", icon: TrafficCone, mod: "vehicle_in_out" },
      ],
    },
    {
      label: "ERP",
      items: [
        { to: "/erp-control", label: "ERP Control Center", icon: ServerCog, mod: "erp_gap" },
        { to: "/spare-erp-gap", label: "ERP vs Physical", icon: Scale, mod: "erp_gap" },
      ],
    },
    {
      label: "Master Data",
      items: [
        { to: "/parts", label: "Part Master", icon: Bolt, mod: "part_master" },
        { to: "/data-quality", label: "Data Quality", icon: ShieldCheck, mod: "part_master" },
        { to: "/supplier-barcodes", label: "Supplier Barcodes", icon: Barcode, mod: "supplier_barcodes" },
        { to: "/scan-audit", label: "Scan Audit", icon: ScanSearch, mod: "scan_audit" },
        { to: "/departments", label: "Department Emails", icon: Mail, mod: "departments" },
      ],
    },
    {
      label: "Reports & Alerts",
      items: [
        { to: "/notifications", label: "Notifications", icon: Bell },
        { to: "/reports", label: "Reports", icon: FileChartColumn, mod: "reports" },
        { to: "/audit-trail", label: "Audit Trail", icon: History, mod: "audit_trail" },
      ],
    },
  ],
};

// A store added later — Consumables — is navigable from the day its master row
// exists, with the shared screens, before anyone writes a menu for it.
const navFor = (code) => NAV_BY_STORE[code] || SHARED_GROUPS;

// A store's sections become nav items of their own — Press Shop today, Tool
// Room and Seat Slider whenever their rows are added. Nothing here is
// hardcoded: the list comes from the store master, so a new section appears in
// the rail the moment it exists.
const sectionGroup = (store) => {
  const sections = store?.sections || [];
  if (!sections.length) return null;
  return {
    label: "Sections",
    items: sections.map((s) => ({
      to: `${storeHome(store.code)}/${s.id}`,
      label: s.name,
      // Same glyph rule as the section's own card (Glyph.sectionIcon).
      icon: sectionIcon(s.name),
      mod: "spare_store",
    })),
  };
};

// A hover flyout for the squeezed rail — the label shown to the right of an
// icon so a collapsed menu still says what each thing is.
function Flyout({ children }) {
  return (
    <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 hidden group-hover:flex items-center
      whitespace-nowrap rounded-md bg-navy-900 text-white text-xs font-medium px-2.5 py-1.5 shadow-xl">
      {children}
    </span>
  );
}

// One glyph that stands for a whole nav group on the squeezed rail; falls back
// to the group's first item so a new group still gets an icon.
const GROUP_ICONS = {
  "Sections": Layers, "Operations": ScanBarcode, "Inventory": Package, "Masters": Database,
  "Master Data": Database, "Receiving": Truck, "Receiving & Management": Truck, "ERP": ServerCog,
  "Reports & System": FileChartColumn, "Reports & Alerts": Bell,
};
const groupIcon = (label, items) => GROUP_ICONS[label] || items[0]?.icon || Circle;

// A squeezed nav group: one icon, and on hover a submenu panel (heading + every
// item) that opens to the right. The panel is portalled to <body> and
// fixed-positioned so the sidebar's own scroll (overflow) can't clip it — the
// bug the old inline flyout hit. A short close delay lets the mouse cross the
// gap from the icon to the panel without it vanishing.
function CollapsedGroupIcon({ group, items }) {
  const { pathname } = useLocation();
  const [rect, setRect] = useState(null);
  const timer = useRef(null);
  const active = items.some((it) => pathname === it.to || pathname.startsWith(it.to + "/"));

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const open = (e) => { if (timer.current) clearTimeout(timer.current); setRect(e.currentTarget.getBoundingClientRect()); };
  const keep = () => { if (timer.current) clearTimeout(timer.current); };
  const close = () => { timer.current = setTimeout(() => setRect(null), 140); };

  return (
    <div className="flex justify-center" onMouseEnter={open} onMouseLeave={close}>
      <NavLink
        to={items[0].to}
        title={group.label}
        className={`flex items-center justify-center h-10 w-10 rounded-lg transition-colors ${
          active
            ? "bg-gradient-to-b from-[#ff2a3c] to-toyotared text-white shadow-[0_4px_12px_rgba(235,10,30,0.35)]"
            : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-navy-800 hover:text-slate-900 dark:hover:text-white"}`}
      >
        <Glyph icon={groupIcon(group.label, items)} size={18} />
      </NavLink>

      {rect && createPortal(
        <div
          style={{ position: "fixed", top: Math.max(8, rect.top), left: rect.right + 8, zIndex: 60 }}
          onMouseEnter={keep}
          onMouseLeave={close}
          className="w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-navy-800 dark:bg-navy-900"
        >
          <p className="border-b border-slate-100 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:border-navy-800">
            {group.label}
          </p>
          <div className="py-1">
            {items.map((it) => (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.end}
                onClick={() => setRect(null)}
                className={({ isActive }) => `flex items-center gap-2.5 px-3 py-2 text-[13px] transition-colors ${
                  isActive
                    ? "bg-toyotared/10 font-semibold text-toyotared"
                    : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-navy-800"}`}
              >
                <Glyph icon={it.icon} size={16} className="shrink-0" />
                <span className="truncate">{it.label}</span>
              </NavLink>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// The store picker: every store, always visible, pinned above the menu — so it
// is one click to switch, never hidden behind a dropdown. Squeezed, it centres
// its icon and reveals the store name on hover.
function StoreTab({ store, active, collapsed, onSelect }) {
  return (
    <NavLink
      to={storeHome(store.code)}
      onClick={onSelect}
      title={collapsed ? store.name : undefined}
      className={`group relative w-full flex items-center rounded-lg text-left transition-colors ${
        collapsed ? "justify-center px-0 py-2.5" : "gap-2.5 px-3 py-2.5"} ${
        active
          ? "bg-toyotared/[0.08] dark:bg-toyotared/15 text-slate-900 dark:text-white ring-1 ring-inset ring-toyotared/30"
          : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-navy-900"}`}
    >
      {/* stores.icon is still an emoji in the master; Glyph maps it to a line icon. */}
      <Glyph icon={store.icon || Store} size={18} className="shrink-0" />
      {!collapsed && <span className="flex-1 min-w-0 text-[13px] font-semibold truncate">{store.name}</span>}
      {!collapsed && active && <span className="h-1.5 w-1.5 rounded-full bg-toyotared shrink-0" />}
      {collapsed && <Flyout>{store.name}</Flyout>}
    </NavLink>
  );
}

// A persistent rail that squeezes to an icon-only strip (w-16) and expands back
// (w-64). The Topbar's panel icon toggles it; squeezed, every row reveals its
// label on hover so nothing is lost.
export default function Sidebar({ collapsed = false, onToggle }) {
  const { stores, activeCode, activeStore, setActiveStore } = useStores();
  const { dark, toggleDark } = useTheme();
  const { user, logout } = useAuth();

  // One nav row. Active is a solid Toyota-red pill; the rest stays quiet grey so
  // exactly one thing on the rail is loud. Squeezed, the row centres its icon.
  const navItemClass = ({ isActive }) =>
    `group relative flex items-center rounded-lg text-sm font-medium transition-colors duration-150 ${
      collapsed ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2.5"} ${
      isActive
        ? "bg-gradient-to-b from-[#ff2a3c] to-toyotared text-white shadow-[0_4px_12px_rgba(235,10,30,0.35)]"
        : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-navy-800 hover:text-slate-900 dark:hover:text-white"}`;

  const liveClass = ({ isActive }) =>
    `group relative w-full flex items-center rounded-lg text-left transition-colors ${
      collapsed ? "justify-center px-0 py-2.5" : "gap-2.5 px-3 py-2.5"} ${
      isActive
        ? "bg-toyotared/[0.08] dark:bg-toyotared/15 text-slate-900 dark:text-white ring-1 ring-inset ring-toyotared/30"
        : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-navy-900"}`;

  return (
    <aside
      className={`sticky top-0 z-40 h-screen shrink-0 flex flex-col
        bg-gradient-to-b from-white to-slate-50/70 dark:from-navy-950 dark:to-navy-900/60
        border-r border-slate-200/80 dark:border-navy-800 shadow-[2px_0_24px_rgba(15,31,56,0.05)]
        transition-[width] duration-200 ${collapsed ? "w-16" : "w-64"}`}
    >
      {/* Header: the brand (a Home link) and, at its top-right, the button that
          hides / shows this menu — the control lives on the menu bar itself. */}
      <div className={`border-b border-slate-200 dark:border-navy-800 ${collapsed ? "px-2 py-3" : "px-4 py-4"}`}>
        <div className={`flex gap-2 ${collapsed ? "flex-col items-center" : "items-center justify-between"}`}>
          <NavLink
            to={storeHome(activeCode)}
            title="Home"
            className={`flex items-center rounded-lg hover:bg-slate-50 dark:hover:bg-navy-900 transition-colors ${
              collapsed ? "p-1 justify-center order-2" : "gap-3 -m-1 p-1 min-w-0"}`}
          >
            <ToyotaBoshokuLogo size={collapsed ? 28 : 40} />
            {!collapsed && (
              <div className="min-w-0">
                <p className="font-extrabold text-[15px] leading-tight tracking-tight text-slate-800 dark:text-white">TBDI Digital Store</p>
                <p className="text-[10px] leading-tight text-slate-400">Toyota Boshoku Device India</p>
              </div>
            )}
          </NavLink>
          <button
            onClick={onToggle}
            title={collapsed ? "Show the menu" : "Hide the menu"}
            aria-label={collapsed ? "Show the menu" : "Hide the menu"}
            className={`shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg border border-slate-200 dark:border-navy-700
              text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-navy-800 hover:text-toyotared transition-colors ${
              collapsed ? "order-1" : ""}`}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>
      </div>

      {/* Stores + the combined Live Dashboard, pinned above the menu — each shown
          only if the user's rights allow it. */}
      {(can(user, "spare_store") || can(user, "live_dashboard")) && (
        <div className={`space-y-1 border-b border-slate-200 dark:border-navy-800 ${collapsed ? "px-2 py-3" : "px-3 pt-3 pb-3"}`}>
          {!collapsed && (
            <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Stores</p>
          )}
          {can(user, "spare_store") && stores.map((store) => (
            <StoreTab key={store.code} store={store} active={store.code === activeCode} collapsed={collapsed}
              onSelect={() => setActiveStore(store.code)} />
          ))}
          {can(user, "live_dashboard") && (
            <NavLink to="/live-dashboard" title={collapsed ? "Live Dashboard" : undefined} className={liveClass}>
              <MonitorPlay size={18} className="shrink-0" aria-hidden="true" />
              {!collapsed && <span className="flex-1 min-w-0 text-[13px] font-semibold truncate">Live Dashboard</span>}
              {collapsed && <Flyout>Live Dashboard</Flyout>}
            </NavLink>
          )}
        </div>
      )}

      <nav className={`flex-1 overflow-y-auto overflow-x-hidden ${collapsed ? "px-2 py-3 space-y-2" : "px-3 py-3 space-y-3"}`}>
        {/* One launcher for every screen — pinned at the top of the menu. */}
        <NavLink to="/services" className={navItemClass} title={collapsed ? "All Services" : undefined}>
          <LayoutGrid size={18} className="shrink-0" aria-hidden="true" />
          {!collapsed && <span className="truncate">All Services</span>}
          {collapsed && <Flyout>All Services</Flyout>}
        </NavLink>

        {[sectionGroup(activeStore), ...navFor(activeCode)].filter(Boolean).map((group) => {
          // Only the items this user may view; a group with nothing left is
          // hidden entirely (admin's `can` returns true for everything).
          const items = group.items.filter((it) => can(user, it.mod));
          if (!items.length) return null;
          // Squeezed: one group icon whose hover panel lists the whole group.
          if (collapsed) return <CollapsedGroupIcon key={group.label} group={group} items={items} />;
          return (
            <div key={group.label}>
              <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">{group.label}</p>
              <div className="space-y-1">
                {items.map(({ to, label, icon, end }) => (
                  <NavLink key={to} to={to} end={end} className={navItemClass}>
                    <Glyph icon={icon} size={18} className="shrink-0" />
                    <span className="truncate">{label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}

        {navFor(activeCode) === SHARED_GROUPS && !sectionGroup(activeStore) && !collapsed && (
          <p className="px-3 text-[11px] text-slate-400 leading-relaxed">
            No screens of its own yet — only the shared ones above.
          </p>
        )}

        {/* Admin lives at the foot of the menu and only for admins — user
            management, per-module rights and passwords. */}
        {user?.is_admin && (
          <div>
            {collapsed
              ? <div className="mx-1.5 mb-1 border-t border-slate-200/70 dark:border-navy-800" />
              : <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">System</p>}
            <NavLink to="/admin" className={navItemClass} title={collapsed ? "User Management" : undefined}>
              <UserCog size={18} className="shrink-0" aria-hidden="true" />
              {!collapsed && <span className="truncate">User Management</span>}
              {collapsed && <Flyout>User Management</Flyout>}
            </NavLink>
            <NavLink to="/settings" className={navItemClass} title={collapsed ? "Settings" : undefined}>
              <Settings size={18} className="shrink-0" aria-hidden="true" />
              {!collapsed && <span className="truncate">Settings</span>}
              {collapsed && <Flyout>Settings</Flyout>}
            </NavLink>
          </div>
        )}
      </nav>

      {/* Who you are and how to leave, pinned to the foot of the rail. */}
      <div className={`border-t border-slate-200 dark:border-navy-800 ${collapsed ? "px-2 py-3" : "px-3 py-3"}`}>
        {user && !collapsed && (
          <div className="px-2 pb-2">
            <p className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 truncate">{user.full_name || user.username}</p>
            <p className="text-[10px] uppercase tracking-wide text-slate-400">{user.role}</p>
          </div>
        )}
        <div className={`flex items-center gap-2 ${collapsed ? "flex-col" : ""}`}>
          <button
            onClick={logout}
            title={user ? `Sign out ${user.username}` : "Sign out"}
            className={`group relative flex items-center rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300
              hover:bg-slate-100 dark:hover:bg-navy-800 hover:text-toyotared transition-colors ${
              collapsed ? "justify-center h-10 w-10" : "flex-1 gap-2.5 px-3 py-2.5"}`}
          >
            <LogOut size={17} className="shrink-0" />
            {!collapsed && "Log out"}
            {collapsed && <Flyout>Log out</Flyout>}
          </button>
          <button
            onClick={toggleDark}
            className="h-10 w-10 shrink-0 flex items-center justify-center rounded-lg border
              border-slate-200 dark:border-navy-800 text-slate-500 dark:text-slate-300
              hover:bg-slate-100 dark:hover:bg-navy-800 transition-colors"
            title={dark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </div>
    </aside>
  );
}
