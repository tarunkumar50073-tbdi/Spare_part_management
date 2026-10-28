import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation } from "react-router-dom";
import {
  Activity, AlarmClock, Archive, Database, Hammer, BellRing, BookOpen, Bolt, Boxes, Calculator, CalendarRange, ClipboardCheck,
  ClipboardList, Clock3, Container, Factory, FileChartColumn, FileText, Grid3x3, History, LayoutDashboard,
  Mail, Mails, Send, Settings2, Workflow, Package, PanelLeftClose, PanelLeftOpen, Scale,
  Bell, Inbox, PackageCheck, PackageX, ScanBarcode, ScanSearch, ScrollText, Search, ServerCog, Settings, ShieldCheck, Siren,
  Store, TrafficCone, TrendingUp, Truck, UserCog, Users, Warehouse, Wrench, FileClock, QrCode,
} from "lucide-react";
import Glyph, { sectionIcon } from "./Glyph.jsx";
import IconTile from "./IconTile.jsx";
import { storeHome, useStores } from "../context/StoreContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { can } from "../utils/permissions.js";
import { APP_OWNER, APP_VERSION, roleLabel } from "../lib/appInfo.js";
import SupportDialog from "./SupportDialog.jsx";

// Toyota Boshoku brand logo — the real company image (mark + wordmark,
// cropped from the company-supplied file, served from frontend/public). The
// rail is navy in both themes, so the logo sits on its own white chip.
function ToyotaBoshokuLogo({ size = 56 }) {
  return (
    <span className="inline-flex shrink-0 rounded-lg bg-white p-1 shadow-[0_2px_8px_rgba(0,0,0,0.25)]">
      <img
        src="/toyota-boshoku-logo.png"
        alt="Toyota Boshoku"
        style={{ width: size, height: "auto" }}
        draggable={false}
      />
    </span>
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
// `short` is the word an item contributes to its module's one-line summary
// ("Scan · Work Queue · Install …"); without it the full label is used.
const NAV_BY_STORE = {
  CHILD_PART: [
    {
      label: "Receiving & Management",
      items: [
        { to: "/gate-entry", label: "Gate Entry", icon: Truck },
        { to: "/supplier-vehicles", label: "Supplier Vehicle Management", short: "Vehicles", icon: Container },
        { to: "/window-time", label: "Window Time", icon: Clock3 },
        { to: "/srvs", label: "SRV Workflow", short: "SRV", icon: ClipboardList },
        { to: "/put-away", label: "Pending Rack Allocation", short: "Rack Allocation", icon: Grid3x3 },
        { to: "/holding-area", label: "Holding Area", icon: Archive },
        { to: "/part-history", label: "Part History", icon: Search },
        { to: "/vehicle-in-out", label: "Vehicle In / Out", icon: TrafficCone },
      ],
    },
    {
      label: "Inventory",
      items: [
        { to: "/inventory-overview", label: "Inventory Overview", short: "Overview", icon: Calculator },
        { to: "/live-stock", label: "Live Stock", icon: Activity },
        { to: "/short-parts", label: "Short Parts", short: "Short", icon: Siren },
        { to: "/excess-parts", label: "Excess Parts", short: "Excess", icon: TrendingUp },
        { to: "/store-stock", label: "Store Stock", icon: Store },
        { to: "/quarterly-inventory", label: "Quarterly Inventory", icon: CalendarRange },
        { to: "/erp-gap", label: "ERP vs Physical Gap", short: "ERP Gap", icon: Scale },
        { to: "/erp-ledger-import", label: "ERP Ledger Import", icon: BookOpen },
        { to: "/current-stock", label: "Current Stock (ERP)", icon: Warehouse },
        { to: "/stock-count", label: "Daily Stock Count", icon: ClipboardCheck },
      ],
    },
    {
      label: "Masters",
      items: [
        { to: "/parts", label: "Part Master", short: "Parts", icon: Bolt },
        { to: "/suppliers", label: "Supplier Master", short: "Suppliers", icon: Factory },
        { to: "/rack-bins", label: "Rack/Bin Master", short: "Racks", icon: Boxes },
        { to: "/report-recipients", label: "Report Recipients", short: "Recipients", icon: Mails },
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
        // Issuing is Scan Part -> Issue. The kiosk request and the Part
        // Requisition queue that fulfilled it were taken out on 17 Oct 2026:
        // "management k according manual detail fill karke issuance karna time
        // waste h" (the store).
        { to: "/scan-part", label: "Scan Part", short: "Scan", icon: ScanBarcode, mod: "scan_part" },
        { to: "/work-queue", label: "Work Queue", icon: ClipboardList, mod: "work_queue" },
        // Job work returns waiting for their ERP RGP, and the link (27 Oct 2026).
        { to: "/job-work", label: "Job Work & RGP", short: "Job Work", icon: Hammer, mod: "scan_part" },
        { to: "/store-stock-spare", label: "Store Stock", short: "Stock", icon: Package, mod: "store_stock" },
      ],
    },
    {
      label: "Inventory",
      items: [
        { to: "/inventory-control", label: "Critical · Reorder · Excess", icon: Siren, mod: "inventory_control" },
        // One report again since 18 Oct 2026 ("issuance and consumption report
        // same dikh rhi h ... ye kaam merge me bhi ho sakta h" — the store): what
        // left the store, what came back and what was really used.
        { to: "/consumption", label: "Issuance & Consumption", short: "Issue & Consumption", icon: TrendingUp, mod: "consumption" },
        { to: "/spare-part-history", label: "Part Ledger", short: "Ledger", icon: ScrollText, mod: "part_ledger" },
      ],
    },
    {
      label: "Receiving",
      items: [
        { to: "/receiving", label: "Receiving & GRN", short: "GRN", icon: PackageCheck, mod: "receiving" },
        { to: "/spare-packets", label: "Packets & QR Labels", short: "Packets & QR", icon: QrCode, mod: "spare_packets" },
        // Which supplier sent short / had a rejection, since how many days (17 Oct 2026).
        { to: "/short-rejection", label: "Short & Rejection", short: "Short / Reject", icon: PackageX, mod: "short_rejection" },
        // Urgent spares in on a supplier challan before the PO / invoice (21 Oct 2026).
        { to: "/challans", label: "Urgent Challan Register", short: "Urgent Challan", icon: FileClock, mod: "challan_register" },
        // The one mail to RQC to punch an SRV / line rejection (22 Oct 2026).
        { to: "/gate-entry", label: "Gate Entry", icon: Truck, mod: "gate_entry" },
        { to: "/vehicle-in-out", label: "Vehicle In / Out", icon: TrafficCone, mod: "vehicle_in_out" },
      ],
    },
    {
      label: "ERP",
      items: [
        { to: "/erp-control", label: "ERP Control Center", icon: ServerCog, mod: "erp_control" },
        { to: "/spare-erp-gap", label: "ERP vs Physical", icon: Scale, mod: "erp_gap" },
      ],
    },
    {
      label: "Master Data",
      items: [
        { to: "/parts", label: "Part Master", short: "Parts", icon: Bolt, mod: "part_master" },
        // Just "Kiosk" (the store, 28 Oct 2026: "part search kiosk okward sa lag rha h only kiosk rhne de").
        { to: "/part-search", label: "Kiosk", short: "Kiosk", icon: Search, mod: "part_kiosk" },
        // Part photos rack by rack on a tablet (21 Oct 2026).
        { to: "/data-quality", label: "Data Quality", icon: ShieldCheck, mod: "data_quality" },
        // Supplier barcodes: no screen of their own — Scan Part's Barcodes panel.
        { to: "/scan-audit", label: "Scan Audit", icon: ScanSearch, mod: "scan_audit" },
        { to: "/employees", label: "Employee Master", short: "Employees", icon: Users, mod: "employees" },
      ],
    },
    {
      label: "Reports & Audit",
      items: [
        { to: "/reports", label: "Reports", icon: FileChartColumn, mod: "reports" },
        { to: "/audit-trail", label: "Audit Trail", icon: History, mod: "audit_trail" },
      ],
    },
  ],
};

// Admin lives at the foot of the menu and only for admins — user management,
// per-module rights and settings.
const SYSTEM_GROUP = {
  label: "System",
  items: [
    { to: "/admin", label: "User Management", short: "Users", icon: UserCog },
    { to: "/rights-matrix", label: "Rights Matrix", short: "Rights", icon: Grid3x3 },
    { to: "/settings", label: "Settings", icon: Settings },
    // Every table of the database, read only (27 Oct 2026).
    { to: "/data-browser", label: "Data Browser", short: "Data", icon: Database },
  ],
};

// Everything about alerts and mail in ONE module, so nothing about e-mail or
// notifications sits in a second place on the rail: the in-app alert list, the
// mail engine (its queue, its log, who gets which mail and when) and the
// address book the mails go to. "admin" marks the engine's own screens
// (administrators only); "store" keeps the two Spare Store screens off another
// store's rail. "summary" replaces the usual "first few screens" line under the
// module title.
const EMAIL_GROUP = {
  label: "Email & Notifications",
  summary: "Notification Engine",
  items: [
    { to: "/notifications", label: "Notification Center", icon: Bell, store: "MAINTENANCE", mod: "notifications" },
    { to: "/email/control-center", label: "Control Center", icon: LayoutDashboard, admin: true },
    { to: "/email/workflows", label: "Workflow Center", icon: Workflow, admin: true },
    { to: "/email/configuration", label: "Email Configuration", icon: Settings2, admin: true },
    { to: "/departments", label: "Department Emails", icon: Mail, mod: "departments", store: "MAINTENANCE" },
    { to: "/email/templates", label: "Email Templates", icon: FileText, admin: true },
    { to: "/email/send", label: "Send Email Alert", icon: Send, admin: true },
    { to: "/email/queue", label: "Email Queue", icon: Inbox, admin: true },
    { to: "/email/logs", label: "Email Logs", icon: ScrollText, admin: true },
    { to: "/email/rules", label: "Notification Rules", icon: BellRing, admin: true },
    { to: "/email/reminders", label: "Reminder & Escalation", icon: AlarmClock, admin: true },
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
  // Sections sharing a group_name (Press Tool Room + General Tool Room ->
  // "Tool Room") collapse into ONE nav item opening the group's filterable
  // page; a section with no group keeps its own item. Order follows the first
  // time each group / section is seen, so the rail stays in the store's order.
  const items = [];
  const seenGroups = new Set();
  sections.forEach((s) => {
    const group = (s.group_name || "").trim();
    if (group) {
      if (seenGroups.has(group)) return;
      seenGroups.add(group);
      items.push({
        to: `${storeHome(store.code)}/group/${encodeURIComponent(group)}`,
        label: group,
        icon: sectionIcon(group),
        mod: "spare_store",
      });
    } else {
      items.push({
        to: `${storeHome(store.code)}/${s.id}`,
        label: s.name,
        // Same glyph rule as the section's own card (Glyph.sectionIcon).
        icon: sectionIcon(s.name),
        mod: "spare_store",
      });
    }
  });
  return { label: "Sections", items };
};

// How each nav group shows as a MODULE on the rail: an app-style icon — an
// emoji in a rounded tile ringed in the module's own colour — beside a bold
// title and a line saying what is inside. A group with no entry (a store added
// later) still gets a neutral tile.
const MODULES = {
  "Sections": { emoji: "🏭", color: "#818cf8" },
  "Operations": { emoji: "🛠️", color: "#2dd4bf" },
  "Inventory": { emoji: "📦", color: "#60a5fa" },
  "Receiving": { emoji: "🚚", color: "#34d399" },
  "Receiving & Management": { emoji: "🚚", color: "#34d399" },
  "ERP": { emoji: "🖥️", color: "#a78bfa" },
  "Master Data": { emoji: "🗄️", color: "#fbbf24" },
  "Masters": { emoji: "🗄️", color: "#fbbf24" },
  "Reports & Audit": { emoji: "📊", color: "#fb7185" },
  "Reports & System": { emoji: "📊", color: "#fb7185" },
  "Email & Notifications": { emoji: "📧", color: "#38bdf8" },
  "System": { emoji: "⚙️", color: "#94a3b8" },
};
const moduleOf = (label) => MODULES[label] || { emoji: "📁", color: "#94a3b8" };

const inGroup = (pathname, items) => items.some((it) => pathname === it.to || pathname.startsWith(it.to + "/"));

// Which modules are open is remembered between visits, so the rail comes back
// the way it was left.
const NAV_OPEN_KEY = "dx_nav_open";
const readOpen = () => {
  try {
    const v = JSON.parse(localStorage.getItem(NAV_OPEN_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
};

// A hover flyout for the squeezed rail — the label shown to the right of an
// icon so a collapsed menu still says what each thing is.
function Flyout({ children }) {
  return (
    <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 hidden group-hover:flex items-center
      whitespace-nowrap rounded-md border border-white/10 bg-navy-900 text-white text-xs font-medium px-2.5 py-1.5 shadow-xl">
      {children}
    </span>
  );
}

// One screen inside an open module. Active is a solid Toyota-red pill; the rest
// stays quiet so exactly one thing on the rail is loud.
const itemClass = ({ isActive }) =>
  `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium transition-colors duration-150 ${
    isActive
      ? "bg-gradient-to-b from-[#ff2a3c] to-toyotared text-white shadow-[0_4px_12px_rgba(235,10,30,0.35)]"
      : "text-slate-200/85 hover:bg-white/10 hover:text-white"}`;

// A module on the open rail: tap the row to show / hide its screens.
function NavModule({ group, items, open, lit, onToggle }) {
  const m = moduleOf(group.label);
  const summary = group.summary || items.map((it) => it.short || it.label).join(" · ");
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`relative w-full flex items-center gap-3 rounded-xl pl-2.5 pr-2 py-2 text-left transition-colors ${
          lit ? "bg-white/[0.08]" : "hover:bg-white/[0.06]"}`}
      >
        {lit && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-toyotared" aria-hidden="true" />}
        <IconTile emoji={m.emoji} color={m.color} lit={lit} />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] leading-tight font-extrabold uppercase tracking-[0.05em] text-white line-clamp-2">{group.label}</span>
          <span className="mt-0.5 block text-[12px] leading-snug text-sky-100/60 line-clamp-2">{summary}</span>
        </span>
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"
          className={`shrink-0 text-sky-300/80 transition-transform duration-150 ${open ? "rotate-90" : ""}`}>
          <path d="M2 1l6.5 4L2 9z" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="mt-1 mb-1.5 ml-[1.85rem] space-y-0.5 border-l border-white/10 pl-2.5">
          {items.map(({ to, label, icon, end }) => (
            <NavLink key={to} to={to} end={end} className={itemClass}>
              <Glyph icon={icon} size={17} className="shrink-0" />
              <span className="truncate">{label}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

// A module that is ONE screen rather than a group (the Action Tracker): the
// same tile, title and summary line, but the row itself is the link. Squeezed,
// it is just the tile with the name on hover.
function NavModuleLink({ to, label, summary, emoji, color, collapsed }) {
  return (
    <NavLink
      to={to}
      title={collapsed ? label : undefined}
      className={({ isActive }) => `group relative flex items-center rounded-xl transition-colors ${
        collapsed ? "justify-center p-0.5" : "w-full gap-3 pl-2.5 pr-2 py-2 text-left"} ${
        isActive ? "bg-white/[0.10]" : "hover:bg-white/[0.06]"}`}
    >
      {({ isActive }) => (
        <>
          {isActive && !collapsed && <ActiveBar />}
          <IconTile emoji={emoji} color={color} size={collapsed ? 36 : 40} lit={isActive} />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-extrabold uppercase tracking-[0.05em] text-white">{label}</span>
                <span className="mt-0.5 block text-[12px] leading-snug text-sky-100/60 line-clamp-2">{summary}</span>
              </span>
              <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" className="shrink-0 text-sky-300/80">
                <path d="M2 1l6.5 4L2 9z" fill="currentColor" />
              </svg>
            </>
          )}
          {collapsed && <Flyout>{label}</Flyout>}
        </>
      )}
    </NavLink>
  );
}

// A module on the squeezed rail: its tile, and on hover a submenu panel
// (heading + every screen) that opens to the right. The panel is portalled to
// <body> and fixed-positioned so the sidebar's own scroll (overflow) can't clip
// it. A short close delay lets the mouse cross the gap from the tile to the
// panel without it vanishing.
function CollapsedModule({ group, items }) {
  const { pathname } = useLocation();
  const [rect, setRect] = useState(null);
  const timer = useRef(null);
  const lit = inGroup(pathname, items);
  const m = moduleOf(group.label);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const open = (e) => { if (timer.current) clearTimeout(timer.current); setRect(e.currentTarget.getBoundingClientRect()); };
  const keep = () => { if (timer.current) clearTimeout(timer.current); };
  const close = () => { timer.current = setTimeout(() => setRect(null), 140); };

  return (
    <div className="flex justify-center" onMouseEnter={open} onMouseLeave={close}>
      <NavLink
        to={items[0].to}
        title={group.label}
        className={`relative flex items-center justify-center rounded-xl p-0.5 transition ${lit ? "bg-white/10" : "hover:bg-white/10"}`}
      >
        <IconTile emoji={m.emoji} color={m.color} size={36} lit={lit} />
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

// A plain top-level row (a store's dashboard, All Services): the icon sits in a
// slot as wide as a module tile, so its label lines up with the module titles.
// Active carries the red bar on the left.
const plainRowClass = (collapsed) => ({ isActive }) =>
  `group relative w-full flex items-center rounded-xl text-left text-[14.5px] font-semibold transition-colors ${
    collapsed ? "justify-center px-0 py-2" : "gap-3 pl-2.5 pr-2 py-2"} ${
    isActive ? "bg-white/[0.10] text-white" : "text-slate-200/90 hover:bg-white/[0.06] hover:text-white"}`;

function ActiveBar() {
  return <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-toyotared" aria-hidden="true" />;
}

// The store picker: every store, always visible, pinned above the menu — so it
// is one click to switch, never hidden behind a dropdown. Squeezed, it centres
// its icon and reveals the store name on hover.
// `here` = its dashboard is the page on screen (the red bar); `active` = it is
// the store whose menu is showing, which a small dot marks on any other page.
function StoreTab({ store, active, here, collapsed, onSelect }) {
  return (
    <NavLink
      to={storeHome(store.code)}
      onClick={onSelect}
      title={collapsed ? store.name : undefined}
      className={() => plainRowClass(collapsed)({ isActive: here })}
    >
      {here && <ActiveBar />}
      {/* stores.icon is still an emoji in the master; Glyph maps it to a line icon. */}
      <span className="grid h-8 w-10 shrink-0 place-items-center"><Glyph icon={store.icon || Store} size={20} /></span>
      {!collapsed && <span className="flex-1 min-w-0 truncate">{store.name}</span>}
      {!collapsed && active && !here && <span className="h-1.5 w-1.5 rounded-full bg-toyotared shrink-0" aria-hidden="true" />}
      {collapsed && <Flyout>{store.name}</Flyout>}
    </NavLink>
  );
}

// A persistent rail that squeezes to an icon-only strip (w-16) and expands back.
// The Topbar's panel icon toggles it; squeezed, every row reveals its label on
// hover so nothing is lost. The rail is navy blue in BOTH themes (a royal blue
// and a reddish white were tried on 13 Oct 2026 and the store went back to the
// navy), so the coloured module tiles read the same by day and by night.
export default function Sidebar({ collapsed = false, onToggle }) {
  const { stores, activeCode, activeStore, setActiveStore } = useStores();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [supportOpen, setSupportOpen] = useState(false);

  // The modules this user may open — a module with nothing left is hidden
  // entirely (admin's `can` returns true for everything). An item can also be
  // tied to administrators (`admin`) or to one store (`store`), or left out for
  // a user who reaches the same screen inside another one (`unless`).
  const mayOpen = (it) => (!it.admin || user?.is_admin) && (!it.store || it.store === activeCode) && can(user, it.mod)
    && !(it.unless && can(user, it.unless));
  const modules = [sectionGroup(activeStore), ...navFor(activeCode), EMAIL_GROUP, user?.is_admin ? SYSTEM_GROUP : null]
    .filter(Boolean)
    .map((group) => ({ group, items: group.items.filter(mayOpen) }))
    .filter((m) => m.items.length);

  // Open / closed per module. Landing on a screen opens the module it lives in
  // (so the red pill is never hidden inside a closed module); every other
  // module stays as the user left it.
  const [openMap, setOpenMap] = useState(readOpen);
  const litLabel = modules.find((m) => inGroup(pathname, m.items))?.group.label || null;
  useEffect(() => {
    if (litLabel) setOpenMap((cur) => (cur[litLabel] ? cur : { ...cur, [litLabel]: true }));
  }, [litLabel, pathname]);
  useEffect(() => {
    try { localStorage.setItem(NAV_OPEN_KEY, JSON.stringify(openMap)); } catch { /* storage unavailable — in-memory only */ }
  }, [openMap]);
  const toggle = (label) => setOpenMap((cur) => ({ ...cur, [label]: !cur[label] }));

  return (
    <aside
      className={`sticky top-0 z-40 h-screen shrink-0 flex flex-col text-slate-200
        border-r border-white/10 shadow-[2px_0_24px_rgba(15,31,56,0.18)]
        transition-[width] duration-200 ${collapsed ? "w-16" : "w-[18.5rem]"}`}
      style={{ background: "radial-gradient(520px 260px at 0% 0%, rgba(235,10,30,0.12), transparent 62%), linear-gradient(180deg,#0f1f38 0%,#13305a 44%,#0b1626 100%)" }}
    >
      {/* Header: the brand (a Home link) and, at its top-right, the button that
          hides / shows this menu — the control lives on the menu bar itself. */}
      <div className={`border-b border-white/10 ${collapsed ? "px-2 py-3" : "px-4 py-4"}`}>
        <div className={`flex gap-2 ${collapsed ? "flex-col items-center" : "items-center justify-between"}`}>
          {/* A login that may not open the store dashboard (Live Board and
              Part Search Kiosk templates) goes Home to "/", which lands it
              on its own first screen (App.jsx StoreHome), not "Access restricted". */}
          <NavLink
            to={activeCode === "MAINTENANCE" && !can(user, "spare_store") ? "/" : storeHome(activeCode)}
            title="Home"
            className={`flex items-center rounded-lg hover:bg-white/[0.06] transition-colors ${
              collapsed ? "p-1 justify-center order-2" : "gap-3 -m-1 p-1 min-w-0"}`}
          >
            <ToyotaBoshokuLogo size={collapsed ? 26 : 38} />
            {!collapsed && (
              <div className="min-w-0">
                <p className="font-extrabold text-[17px] leading-tight tracking-tight text-white">TBDI Digital SMP</p>
              </div>
            )}
          </NavLink>
          <button
            onClick={onToggle}
            title={collapsed ? "Show the menu" : "Hide the menu"}
            aria-label={collapsed ? "Show the menu" : "Hide the menu"}
            className={`shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg border border-white/15
              text-slate-300 hover:bg-white/10 hover:text-white transition-colors ${collapsed ? "order-1" : ""}`}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>
      </div>

      <nav className={`flex-1 overflow-y-auto overflow-x-hidden [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.28)_transparent] ${
        collapsed ? "px-2 py-3 space-y-2" : "px-3 py-3 space-y-1"}`}>
        {/* Each store's dashboard, then the one launcher for every screen. */}
        {can(user, "spare_store") && stores.map((store) => (
          <StoreTab key={store.code} store={store} active={store.code === activeCode} here={pathname === storeHome(store.code)}
            collapsed={collapsed} onSelect={() => setActiveStore(store.code)} />
        ))}
        <NavLink to="/services" className={plainRowClass(collapsed)} title={collapsed ? "All Services" : undefined}>
          {({ isActive }) => (
            <>
              {isActive && <ActiveBar />}
              <span className="grid h-8 w-10 shrink-0 place-items-center text-[19px] leading-none" aria-hidden="true">🧩</span>
              {!collapsed && <span className="truncate">All Services</span>}
              {collapsed && <Flyout>All Services</Flyout>}
            </>
          )}
        </NavLink>

        {!collapsed && modules.length > 0 && <div className="!my-2 border-t border-white/10" />}

        {/* The Spare Store's action tracker leads the modules: what is wrong,
            who must act and by when. */}
        {activeCode === "MAINTENANCE" && can(user, "action_tracker") && (
          <NavModuleLink to="/action-tracker" label="Action Tracker" summary="Summary issues · owner · target"
            emoji="📋" color="#fb923c" collapsed={collapsed} />
        )}

        {modules.map(({ group, items }) => (collapsed
          ? <CollapsedModule key={group.label} group={group} items={items} />
          : <NavModule key={group.label} group={group} items={items}
              open={Boolean(openMap[group.label])} lit={group.label === litLabel}
              onToggle={() => toggle(group.label)} />))}

        {navFor(activeCode) === SHARED_GROUPS && !sectionGroup(activeStore) && !collapsed && (
          <p className="px-3 text-[11px] text-slate-400 leading-relaxed">
            No screens of its own yet — only the shared ones above.
          </p>
        )}
      </nav>

      {/* The wall board, one tap away from anywhere — shown only if the user's
          rights allow it. */}
      {can(user, "live_dashboard") && (
        <div className={collapsed ? "px-2 pb-2" : "px-3 pb-3"}>
          {/* The Toyota look, kept light (the store, 14 Oct 2026: "thoda halka,
              toyota look"): a white tile with the Toyota red bar and title. */}
          <NavLink
            to="/live-dashboard"
            title={collapsed ? "Live Board" : undefined}
            className={`group relative flex items-center overflow-hidden rounded-xl bg-white transition hover:-translate-y-px hover:shadow-[0_8px_18px_rgba(235,10,30,0.25)] ${
              collapsed ? "justify-center h-10 w-10 mx-auto" : "gap-3 py-2.5 pl-4 pr-3"}`}
            style={{ boxShadow: "0 4px 12px rgba(0,0,0,0.18)" }}
          >
            {!collapsed && <span className="absolute inset-y-0 left-0 w-1 bg-toyotared" aria-hidden="true" />}
            <span className={`grid shrink-0 place-items-center rounded-lg bg-rose-50 leading-none ${
              collapsed ? "h-8 w-8 text-[17px]" : "h-9 w-9 text-[20px]"}`} aria-hidden="true">🏆</span>
            {!collapsed && (
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-[15px] font-extrabold text-toyotared">Store Excellence</span>
                <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-slate-600">
                  Live Board
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_#34d399] animate-pulse" />
                </span>
              </span>
            )}
            {collapsed && <Flyout>Live Board</Flyout>}
          </NavLink>
        </div>
      )}

      {/* The foot of the rail: help, then what this is — the signed-in role, the
          app version and whose app it is. Signing out and the day / night switch
          live in the top bar. */}
      <div className={`border-t border-white/10 ${collapsed ? "px-2 py-3" : "px-4 py-3"}`}>
        <button
          type="button"
          onClick={() => setSupportOpen(true)}
          title="Support / Help"
          className={`group relative inline-flex items-center rounded-xl border border-white/15 bg-white/[0.06] text-white
            hover:bg-white/[0.12] transition-colors ${collapsed ? "justify-center h-10 w-10" : "gap-2 px-3 py-2 text-[14px] font-bold"}`}
        >
          <span className="text-[17px] leading-none" aria-hidden="true">🛟</span>
          {!collapsed && "Support / Help"}
          {collapsed && <Flyout>Support / Help</Flyout>}
        </button>
        {user && !collapsed && (
          <div className="mt-2.5 px-1 leading-snug">
            <p className="text-[13px] text-sky-100/75">{roleLabel(user)} · v{APP_VERSION}</p>
            <p className="text-[13px] text-sky-100/75">{APP_OWNER}</p>
          </div>
        )}
      </div>
      <SupportDialog open={supportOpen} onClose={() => setSupportOpen(false)} />
    </aside>
  );
}
