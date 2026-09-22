import React from "react";
import { NavLink } from "react-router-dom";
import { LogOut, Moon, Sun } from "lucide-react";
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
      { to: "/gate-entry", label: "Gate Entry", emoji: "🚚", mod: "gate_entry" },
      // The ERP-fed gate arrivals / vehicle in-out live here so they stay
      // reachable even when the Child store nav is off (Spare-only mode).
      { to: "/vehicle-in-out", label: "Vehicle In / Out", emoji: "🚦", mod: "vehicle_in_out" },
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
        { to: "/gate-entry", label: "Gate Entry", emoji: "🚚" },
        { to: "/supplier-vehicles", label: "Supplier Vehicle Management", emoji: "🚛" },
        { to: "/window-time", label: "Window Time", emoji: "🕒" },
        { to: "/srvs", label: "SRV Workflow", emoji: "📋" },
        { to: "/put-away", label: "Pending Rack Allocation", emoji: "📦" },
        { to: "/holding-area", label: "Holding Area", emoji: "🗄️" },
        { to: "/part-history", label: "Part History", emoji: "🔎" },
        { to: "/vehicle-in-out", label: "Vehicle In / Out", emoji: "🚦" },
      ],
    },
    {
      label: "Inventory",
      items: [
        { to: "/inventory-overview", label: "Inventory Overview", emoji: "🧮" },
        { to: "/live-stock", label: "Live Stock", emoji: "⚡" },
        { to: "/short-parts", label: "Short Parts", emoji: "🚨" },
        { to: "/excess-parts", label: "Excess Parts", emoji: "📈" },
        { to: "/store-stock", label: "Store Stock", emoji: "🏬" },
        { to: "/quarterly-inventory", label: "Quarterly Inventory", emoji: "🗓️" },
        { to: "/erp-gap", label: "ERP vs Physical Gap", emoji: "⚖️" },
        { to: "/erp-ledger-import", label: "ERP Ledger Import", emoji: "📚" },
        { to: "/current-stock", label: "Current Stock (ERP)", emoji: "📦" },
        { to: "/stock-count", label: "Daily Stock Count", emoji: "📝" },
      ],
    },
    {
      label: "Masters",
      items: [
        { to: "/parts", label: "Part Master", emoji: "🔩" },
        { to: "/suppliers", label: "Supplier Master", emoji: "🏭" },
        { to: "/rack-bins", label: "Rack/Bin Master", emoji: "🗃️" },
        { to: "/report-recipients", label: "Report Recipients", emoji: "📧" },
      ],
    },
    {
      label: "Reports & System",
      items: [
        { to: "/reports", label: "Reports", emoji: "📑" },
        { to: "/audit-trail", label: "Audit Trail", emoji: "🕘" },
      ],
    },
  ],
  // Its own Masters group rather than falling through to SHARED_GROUPS: the
  // store's dashboard reports "298 parts without a maximum" and "127 carry no
  // rate" while Part Master lived only under Child Parts, so there was no
  // screen anywhere to fill those in from. Gate Entry is reused from
  // SHARED_GROUPS rather than repeated — one gate, both stores.
  MAINTENANCE: [
    {
      // Store Stock sits above the masters on purpose: it is the screen that
      // turns this store's Min and Max into something that can be judged.
      // Without a counted quantity, every health figure on the dashboard has
      // nothing to compare against.
      label: "Inventory",
      items: [
        { to: "/scan-part", label: "Scan Part", emoji: "📷", mod: "scan_part" },
        { to: "/store-stock-spare", label: "Store Stock", emoji: "📦", mod: "store_stock" },
        { to: "/spare-part-history", label: "Part Ledger", emoji: "📜", mod: "part_ledger" },
        { to: "/spare-erp-gap", label: "ERP vs Physical Gap", emoji: "⚖️", mod: "erp_gap" },
      ],
    },
    {
      label: "Masters",
      items: [
        { to: "/parts", label: "Part Master", emoji: "🔩", mod: "part_master" },
        { to: "/supplier-barcodes", label: "Supplier Barcodes", emoji: "🏷️", mod: "supplier_barcodes" },
        { to: "/scan-audit", label: "Scan Audit", emoji: "🧾", mod: "scan_audit" },
        { to: "/departments", label: "Department Emails", emoji: "✉️", mod: "departments" },
      ],
    },
    ...SHARED_GROUPS,
  ],
};

// A store added later — Consumables — is navigable from the day its master row
// exists, with the shared screens, before anyone writes a menu for it.
const navFor = (code) => NAV_BY_STORE[code] || SHARED_GROUPS;

// Same glyph rule the Spare Parts Store page uses, so a section reads the same
// in the rail as it does on its own card.
const SECTION_EMOJI = [
  [/press|stamp/i, "🔨"],
  [/nut|bolt/i, "🔩"],
  [/thin|recliner/i, "💺"],
  [/bin|wash/i, "🚿"],
  [/maint/i, "🔧"],
  [/tool/i, "🛠️"],
  [/seat|slider/i, "💺"],
  [/weld/i, "🔥"],
  [/paint|coat/i, "🎨"],
  [/electric|electr/i, "⚡"],
];
const sectionEmoji = (name) => (SECTION_EMOJI.find(([re]) => re.test(name || "")) || [null, "🧰"])[1];

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
      emoji: sectionEmoji(s.name),
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
      <span className="text-lg leading-none shrink-0">{store.icon || "🏬"}</span>
      {!collapsed && <span className="flex-1 min-w-0 text-[13px] font-semibold truncate">{store.name}</span>}
      {!collapsed && active && <span className="h-1.5 w-1.5 rounded-full bg-toyotared shrink-0" />}
      {collapsed && <Flyout>{store.name}</Flyout>}
    </NavLink>
  );
}

// A persistent rail that squeezes to an icon-only strip (w-16) and expands back
// (w-64). The Topbar's panel icon toggles it; squeezed, every row reveals its
// label on hover so nothing is lost.
export default function Sidebar({ collapsed = false }) {
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
      {/* Header: the logo is a Home link now — the old logo-as-hide-control is
          gone; the Topbar's panel icon squeezes the rail. */}
      <div className={`border-b border-slate-200 dark:border-navy-800 ${collapsed ? "px-2 py-3 flex justify-center" : "px-4 py-4"}`}>
        <NavLink
          to={storeHome(activeCode)}
          title="Home"
          className={`flex items-center rounded-lg hover:bg-slate-50 dark:hover:bg-navy-900 transition-colors ${
            collapsed ? "p-1 justify-center" : "gap-3 -m-1 p-1"}`}
        >
          <ToyotaBoshokuLogo size={collapsed ? 30 : 40} />
          {!collapsed && (
            <div className="min-w-0">
              <p className="font-bold text-[14px] leading-snug text-slate-800 dark:text-white">Spare Part Store Management</p>
            </div>
          )}
        </NavLink>
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
              <span className="text-lg leading-none shrink-0">🖥️</span>
              {!collapsed && <span className="flex-1 min-w-0 text-[13px] font-semibold truncate">Live Dashboard</span>}
              {collapsed && <Flyout>Live Dashboard</Flyout>}
            </NavLink>
          )}
        </div>
      )}

      <nav className={`flex-1 overflow-y-auto overflow-x-hidden ${collapsed ? "px-2 py-3 space-y-2" : "px-3 py-3 space-y-3"}`}>
        {[sectionGroup(activeStore), ...navFor(activeCode)].filter(Boolean).map((group) => {
          // Only the items this user may view; a group with nothing left is
          // hidden entirely (admin's `can` returns true for everything).
          const items = group.items.filter((it) => can(user, it.mod));
          if (!items.length) return null;
          return (
            <div key={group.label}>
              {collapsed
                ? <div className="mx-1.5 mb-1 border-t border-slate-200/70 dark:border-navy-800" />
                : <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">{group.label}</p>}
              <div className="space-y-1">
                {items.map(({ to, label, emoji, end }) => (
                  <NavLink key={to} to={to} end={end} className={navItemClass} title={collapsed ? label : undefined}>
                    <span className="text-base leading-none w-[18px] text-center shrink-0">{emoji}</span>
                    {!collapsed && <span className="truncate">{label}</span>}
                    {collapsed && <Flyout>{label}</Flyout>}
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
              <span className="text-base leading-none w-[18px] text-center shrink-0">🛡️</span>
              {!collapsed && <span className="truncate">User Management</span>}
              {collapsed && <Flyout>User Management</Flyout>}
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
