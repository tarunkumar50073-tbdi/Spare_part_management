import React from "react";
import { NavLink } from "react-router-dom";
import { LogOut, Moon, Sun, X } from "lucide-react";
import { storeHome, useStores } from "../context/StoreContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";

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
    items: [{ to: "/gate-entry", label: "Gate Entry", emoji: "🚚" }],
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
        { to: "/srvs", label: "SRV Workflow", emoji: "📋" },
        { to: "/put-away", label: "Pending Rack Allocation", emoji: "📦" },
        { to: "/holding-area", label: "Holding Area", emoji: "🗄️" },
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
        { to: "/store-stock-spare", label: "Store Stock", emoji: "📦" },
        { to: "/spare-erp-gap", label: "ERP vs Physical Gap", emoji: "⚖️" },
      ],
    },
    {
      label: "Masters",
      items: [
        { to: "/parts", label: "Part Master", emoji: "🔩" },
        { to: "/departments", label: "Department Emails", emoji: "✉️" },
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
  [/press/i, "🔨"],
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
    })),
  };
};

// One nav row, active or not. The active state is a solid Toyota-red pill;
// everything else stays quiet grey so exactly one thing on the rail is loud.
const navClass = ({ isActive }) =>
  `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150 ${
    isActive
      ? "bg-toyotared text-white shadow-sm"
      : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-navy-800 hover:text-slate-900 dark:hover:text-white"
  }`;

// The store picker: every store, always visible, pinned above the menu. Both
// are listed because a dropdown hid the other one entirely — there was no way
// to see at a glance that the plant runs two stores. And they sit together at
// the top rather than as expandable branches, because Child Parts alone is
// twenty items: nesting Spare Parts under it pushed the second store off the
// bottom of the rail, so switching meant scrolling past a menu you were not
// using.
function StoreTab({ store, active, onSelect }) {
  return (
    <NavLink
      to={storeHome(store.code)}
      onClick={onSelect}
      className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-colors ${
        active
          ? "bg-toyotared/[0.08] dark:bg-toyotared/15 text-slate-900 dark:text-white ring-1 ring-inset ring-toyotared/30"
          : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-navy-900"
      }`}
    >
      <span className="text-lg leading-none shrink-0">{store.icon || "🏬"}</span>
      <span className="flex-1 min-w-0 text-[13px] font-semibold truncate">{store.name}</span>
      {active && <span className="h-1.5 w-1.5 rounded-full bg-toyotared shrink-0" />}
    </NavLink>
  );
}

export default function Sidebar({ open, onClose, collapsed = false, onToggleCollapse }) {
  const { stores, activeCode, activeStore, setActiveStore } = useStores();
  const { dark, toggleDark } = useTheme();
  const { user, logout } = useAuth();

  return (
    <>
      {open && (
        <div className="fixed inset-0 bg-black/40 z-30 lg:hidden" onClick={onClose} />
      )}
      {/* Light rail on a light canvas, separated by a hairline rather than by
          a block of navy. The red is then the only strong colour on screen, so
          it can mean "you are here" instead of competing with the chrome. */}
      {/* Sticky and exactly one viewport tall on desktop. As a plain static
          block it grew to its own content height — 1320px in a 900px window —
          so the menu never scrolled inside itself and Log out sat below the
          fold, reachable only by scrolling the whole page. */}
      <aside
        className={`fixed lg:sticky z-40 top-0 left-0 h-full lg:h-screen w-64 shrink-0 flex flex-col
        bg-white dark:bg-navy-950 border-r border-slate-200 dark:border-navy-800
        transform transition-transform duration-200 ${open ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0
        ${collapsed ? "lg:hidden" : ""}`}
      >
        <div className="relative px-4 py-4 border-b border-slate-200 dark:border-navy-800">
          <button className="lg:hidden absolute top-3 right-3 text-slate-400" onClick={onClose}>
            <X size={20} />
          </button>
          {/* The logo doubles as the rail's own hide control. On a wall monitor
              the menu is dead weight once the screen is set — this gives the
              charts the extra 256px without touching the browser's chrome. */}
          <button
            type="button"
            onClick={() => {
              // Same intent either way — put the menu away. On a phone the rail
              // is a drawer, so that means closing it; on desktop it means
              // collapsing it. Deciding here keeps the logo from being a
              // control that does nothing on one of the two.
              if (window.matchMedia("(min-width: 1024px)").matches) onToggleCollapse?.();
              else onClose?.();
            }}
            title="Hide the menu"
            className="flex items-center gap-3 text-left w-full rounded-lg -m-1 p-1
              hover:bg-slate-50 dark:hover:bg-navy-900 transition-colors"
          >
            <ToyotaBoshokuLogo size={40} />
            <div className="min-w-0">
              <p className="font-bold text-[15px] leading-tight text-slate-800 dark:text-white truncate">Part Store</p>
              <p className="text-[10px] text-slate-400 leading-tight mt-0.5 truncate">Toyota Boshoku Device India</p>
            </div>
          </button>
        </div>

        {/* Pinned, never scrolled: whichever store you are in, the other one
            is one click away without hunting for it. */}
        <div className="px-3 pt-3 pb-3 space-y-1 border-b border-slate-200 dark:border-navy-800">
          <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Stores
          </p>
          {stores.map((store) => (
            <StoreTab
              key={store.code}
              store={store}
              active={store.code === activeCode}
              onSelect={() => {
                setActiveStore(store.code);
                onClose?.();
              }}
            />
          ))}
          {/* The combined wallboard spans BOTH stores, so it is pinned here with
              the store picker rather than tucked inside one store's menu. */}
          <NavLink
            to="/live-dashboard"
            onClick={onClose}
            className={({ isActive }) =>
              `w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-colors ${
                isActive
                  ? "bg-toyotared/[0.08] dark:bg-toyotared/15 text-slate-900 dark:text-white ring-1 ring-inset ring-toyotared/30"
                  : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-navy-900"
              }`
            }
          >
            <span className="text-lg leading-none shrink-0">🖥️</span>
            <span className="flex-1 min-w-0 text-[13px] font-semibold truncate">Live Dashboard</span>
          </NavLink>
        </div>

        <nav className="flex-1 px-3 py-3 space-y-3 overflow-y-auto">
          <NavLink to={storeHome(activeCode)} end className={navClass} onClick={onClose}>
            <span className="text-base leading-none w-[18px] text-center shrink-0">📊</span>
            Dashboard
          </NavLink>

          {[sectionGroup(activeStore), ...navFor(activeCode)].filter(Boolean).map((group) => (
            <div key={group.label}>
              <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map(({ to, label, emoji, end }) => (
                  <NavLink key={to} to={to} end={end} className={navClass} onClick={onClose}>
                    <span className="text-base leading-none w-[18px] text-center shrink-0">{emoji}</span>
                    <span className="truncate">{label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}

          {navFor(activeCode) === SHARED_GROUPS && !sectionGroup(activeStore) && (
            <p className="px-3 text-[11px] text-slate-400 leading-relaxed">
              No screens of its own yet — only the shared ones above.
            </p>
          )}
        </nav>

        {/* Who you are and how to leave, pinned to the foot of the rail rather
            than tucked in the top bar — it is account state, not page state,
            so it belongs with the navigation it applies to. */}
        <div className="border-t border-slate-200 dark:border-navy-800 px-3 py-3">
          {user && (
            <div className="px-2 pb-2">
              <p className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 truncate">
                {user.full_name || user.username}
              </p>
              <p className="text-[10px] uppercase tracking-wide text-slate-400">{user.role}</p>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={logout}
              className="flex-1 flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium
                text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-navy-800
                hover:text-toyotared transition-colors"
              title={user ? `Sign out ${user.username}` : "Sign out"}
            >
              <LogOut size={17} className="shrink-0" />
              Log out
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
    </>
  );
}
