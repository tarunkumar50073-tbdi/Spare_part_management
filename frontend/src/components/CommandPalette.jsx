import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, CornerDownLeft, Package, Search } from "lucide-react";
import Badge from "./Badge.jsx";
import { useStockList } from "../lib/stockQueries.js";
import { usePartDrawer } from "../context/PartDrawerContext.jsx";
import { useStores } from "../context/StoreContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { can } from "../utils/permissions.js";

// Quick-jump destinations. `mod`/`admin` gate an entry to who may open it.
const NAV = [
  { label: "Dashboard", to: "/", keywords: "home overview store status" },
  { label: "Scan Part", to: "/scan-part", mod: "scan_part", keywords: "barcode issue receive count" },
  { label: "Store Stock", to: "/store-stock-spare", mod: "store_stock", keywords: "inventory on hand count upload" },
  { label: "Part Ledger — Stock Ledger", to: "/spare-part-history", mod: "part_ledger", keywords: "valuation history opening closing movement" },
  { label: "ERP vs Physical Gap", to: "/spare-erp-gap", mod: "erp_gap", keywords: "gap variance difference" },
  { label: "Part Master", to: "/parts", mod: "part_master", keywords: "parts catalogue master data" },
  { label: "Critical · Reorder · Excess", to: "/inventory-control", mod: "store_stock", keywords: "short critical zero reorder excess aging order qty" },
  { label: "Consumption Analytics", to: "/consumption", mod: "spare_store", keywords: "consumption usage issued trend top parts department" },
  { label: "Receiving & GRN", to: "/receiving", mod: "spare_store", keywords: "grn srv receipt receiving inward aging" },
  { label: "ERP Control Center", to: "/erp-control", mod: "erp_gap", keywords: "erp sync status reconciliation error pending" },
  { label: "Data Quality", to: "/data-quality", mod: "part_master", keywords: "missing min max rate location barcode completeness" },
  { label: "Notifications", to: "/notifications", keywords: "alerts notification critical warning bell" },
  { label: "Suppliers", to: "/suppliers", keywords: "vendor supplier master" },
  { label: "Reports", to: "/reports", mod: "reports", keywords: "excel pdf export daily monthly consumption" },
  { label: "Live Dashboard (HMI)", to: "/live-dashboard", mod: "live_dashboard", keywords: "wallboard tv hmi big screen" },
  { label: "All Services", to: "/services", keywords: "menu launcher screens" },
  { label: "Audit Trail", to: "/audit-trail", mod: "audit_trail", keywords: "log who what when history" },
  { label: "User Management", to: "/admin", admin: true, keywords: "users roles permissions rbac" },
  { label: "Settings", to: "/settings", admin: true, keywords: "config barcode label store section" },
];

const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));

export default function CommandPalette() {
  const navigate = useNavigate();
  const { activeCode } = useStores();
  const { user } = useAuth();
  const { openPart } = usePartDrawer();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // The active store's parts — the shared cached stock list (lib/stockQueries),
  // the same copy the dashboard, Store Stock and Part Ledger read. Fetched only
  // once the palette opens, and usually already there from the screen behind it.
  const { data: parts, isPending: loading } = useStockList(activeCode, null, { enabled: open });

  // Ctrl/Cmd+K toggles the palette from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset the box and focus the input each time the palette opens.
  useEffect(() => {
    if (!open) return undefined;
    setQuery(""); setActive(0);
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [open]);

  const navResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    return NAV
      .filter((n) => (n.admin ? user?.is_admin : true) && (!n.mod || can(user, n.mod)))
      .filter((n) => !q || `${n.label} ${n.keywords}`.toLowerCase().includes(q))
      .slice(0, q ? 6 : 8);
  }, [query, user]);

  const partResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !parts) return [];
    return parts
      .filter((p) => `${p.part_no || ""} ${p.part_name || ""} ${p.old_part_no || ""} ${p.location || ""}`.toLowerCase().includes(q))
      .slice(0, 20);
  }, [query, parts]);

  // One flat list so the arrow keys can walk nav + parts as a single column.
  const flat = useMemo(
    () => [...navResults.map((n) => ({ kind: "nav", n })), ...partResults.map((p) => ({ kind: "part", p }))],
    [navResults, partResults],
  );

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const close = useCallback(() => { setOpen(false); setQuery(""); }, []);

  const activate = useCallback((item) => {
    if (!item) return;
    if (item.kind === "nav") navigate(item.n.to);
    // A part opens the part drawer (stock, location, consumption, ERP, ledger).
    else openPart(item.p.part_id);
    close();
  }, [navigate, close]);

  const onKeyDown = (e) => {
    if (e.key === "Escape") { close(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, Math.max(flat.length - 1, 0))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); activate(flat[active]); }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="absolute inset-0 bg-black/40" onClick={close} />
      <div className="relative w-full max-w-xl overflow-hidden rounded-xl2 border border-slate-200 bg-white shadow-cardHover dark:border-navy-700 dark:bg-navy-900">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 dark:border-navy-800">
          <Search size={16} className="shrink-0 text-slate-400" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search parts (no / name / ref / location) or jump to a screen…"
            className="w-full bg-transparent py-3.5 text-sm outline-none placeholder:text-slate-400"
            aria-label="Search"
          />
          <kbd className="hidden shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400 sm:block dark:border-navy-700">ESC</kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
          {loading && !parts && <p className="px-4 py-6 text-center text-sm text-slate-400">Loading…</p>}

          {!loading && flat.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-slate-400">
              {query.trim() ? `Nothing matches “${query.trim()}”.` : "Type to search parts, or pick a screen."}
            </p>
          )}

          {navResults.length > 0 && (
            <Section title="Go to">
              {navResults.map((n, i) => (
                <Row key={n.to} idx={i} active={active === i} onMouseEnter={() => setActive(i)} onClick={() => activate({ kind: "nav", n })}>
                  <ArrowRight size={15} className="shrink-0 text-slate-400" aria-hidden="true" />
                  <span className="flex-1 truncate text-sm text-slate-700 dark:text-slate-200">{n.label}</span>
                </Row>
              ))}
            </Section>
          )}

          {partResults.length > 0 && (
            <Section title={`Parts${parts ? ` · ${partResults.length}${partResults.length === 20 ? "+" : ""}` : ""}`}>
              {partResults.map((p, j) => {
                const idx = navResults.length + j;
                return (
                  <Row key={p.part_id} idx={idx} active={active === idx} onMouseEnter={() => setActive(idx)} onClick={() => activate({ kind: "part", p })}>
                    <Package size={15} className="shrink-0 text-slate-400" aria-hidden="true" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-mono text-sm text-slate-800 dark:text-white">{p.part_no}</span>
                        {p.status && <Badge status={p.status} />}
                      </span>
                      <span className="truncate text-[11px] text-slate-400">
                        {p.part_name}{p.location ? ` · ${p.location}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-[11px] tabular text-slate-500 dark:text-slate-400">
                      <span className="font-semibold text-slate-700 dark:text-slate-200">{fmtInt(p.qty_on_hand)}</span> in stock
                      <span className="block text-slate-400">min {fmtInt(p.min_stock_level)} · max {fmtInt(p.max_stock_level)}</span>
                    </span>
                  </Row>
                );
              })}
            </Section>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400 dark:border-navy-800">
          <span className="flex items-center gap-1"><CornerDownLeft size={12} /> open</span>
          <span>↑ ↓ navigate</span>
          <span className="ml-auto">Ctrl / ⌘ + K</span>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="px-1 py-1">
      <p className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{title}</p>
      {children}
    </div>
  );
}

function Row({ idx, active, children, onClick, onMouseEnter }) {
  return (
    <button
      type="button"
      data-idx={idx}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${active ? "bg-slate-100 dark:bg-navy-800" : "hover:bg-slate-50 dark:hover:bg-navy-800/60"}`}
    >
      {children}
    </button>
  );
}
