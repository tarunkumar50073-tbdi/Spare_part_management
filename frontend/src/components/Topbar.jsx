import React, { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { FileDown, Home, LogOut, Maximize2, Minimize2, Settings as SettingsIcon } from "lucide-react";
import Badge from "./Badge.jsx";
import { notificationService } from "../services/notificationService.js";
import { liveStockService } from "../services/liveStockService.js";
import { partService } from "../services/partService.js";
import { storeDashboardService } from "../services/storeDashboardService.js";
import { useStores } from "../context/StoreContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";

// The coming multi-plant switch. Today the app serves one plant, so Plant 1 is
// the live data and Plant 2 is a disabled placeholder. When the second site's
// data and per-plant permissions land, a user will see only the plant(s) they
// may access and admins / plant-heads will toggle between both here.
function PlantToggle() {
  return (
    <div className="hidden md:inline-flex items-center rounded-lg border border-slate-200 dark:border-navy-700 bg-slate-50 dark:bg-navy-800 p-0.5">
      <button
        type="button"
        className="rounded-md bg-toyotared px-2.5 py-1 text-xs font-semibold text-white shadow-sm"
        title="Plant 1 — current"
      >
        Plant&nbsp;1
      </button>
      <button
        type="button"
        disabled
        title="Plant 2 — coming soon (its data isn't connected yet)"
        className="rounded-md px-2.5 py-1 text-xs font-semibold text-slate-400 cursor-not-allowed"
      >
        Plant&nbsp;2
      </button>
    </div>
  );
}

// "Last ERP data: 01 Aug 2026" — or, honestly, that none has arrived. Every
// receiving figure in this app waits on ERP calling the gate-entry and
// stock APIs, so whether that feed is alive belongs at the top of the screen
// rather than buried in one card on one page.
function ErpStatusPill() {
  // Cached + auto-refetched via React Query — no more hand-rolled setInterval,
  // and the result is shared/deduped if anything else asks for ERP status.
  const { data: syncedAt, isPending } = useQuery({
    queryKey: ["erp-status"],
    queryFn: () => storeDashboardService.erpStatus().then((res) => res.data.data.last_erp_sync),
    refetchInterval: 120000,
  });

  if (isPending) return null;

  const live = Boolean(syncedAt);
  const label = live
    ? `Last ERP data: ${new Date(syncedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`
    : "No ERP data yet";

  return (
    <span
      className={`hidden xl:inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium
        ${live
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
          : "bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-slate-400"}`}
      title={live ? undefined : "ERP has not pushed a gate entry or stock figure yet"}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-500" : "bg-slate-400"}`} />
      {label}
    </span>
  );
}

// Does this row itself carry the typed text, or did the server return it as
// another supplier's number for the same part? Same three fields the server
// matches on, so the two answers cannot drift apart.
const matchesQuery = (row, query) => {
  const kw = query.trim().toLowerCase();
  if (!kw) return true;
  return (
    (row.part_no || "").toLowerCase().includes(kw) ||
    (row.part_name || "").toLowerCase().includes(kw) ||
    (row.old_part_no || "").toLowerCase().includes(kw)
  );
};

// The two stores answer this box from different places, so results are brought
// to one shape here rather than the dropdown growing two versions of itself.
//
// Child Parts searches live stock — that store's parts are stocked, covered and
// have SOB variants. The Spare Parts Store has none of that: no coverage days
// by design, no supplier variants, and most of its list has never been counted.
// So a spare is shown by where it sits and what it costs, which is what someone
// searching a spares store is actually looking for.
const asChildPartResult = (row, query) => ({
  key: `cp-${row.part_id}`,
  partNo: row.part_no,
  name: row.part_name,
  secondary: row.old_part_no,
  status: row.status,
  sob: !matchesQuery(row, query),
  right: row.live_stock == null
    ? "—"
    : `${Number(row.live_stock).toLocaleString()}${row.cov_days == null ? "" : ` · ${row.cov_days}d`}`,
});

const asSpareResult = (row) => ({
  key: `sp-${row.id}`,
  partNo: row.part_no,
  name: row.part_name,
  secondary: row.location,
  status: null,
  sob: false,
  right: Number(row.unit_price || 0) > 0
    ? `₹${Number(row.unit_price).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
    : "—",
});

// Top bar: page title left, global part search in the middle, notification
// bell (real active notifications from the Rack Alert Engine) on the right.
// This is the app's only search box — the dashboard used to carry a second one
// of its own. Account controls (user, sign out, theme) sit at the foot of the
// sidebar instead, since they belong to the session rather than to the page.
export default function Topbar({ title, showSearch = true }) {
  const navigate = useNavigate();
  // The box searches the store you are standing in. It used to always search
  // Child Parts live stock, so from the Spare Parts Store it answered every
  // query with "No part found" — the 481 spares were never being looked at.
  // Child Parts is the only store with live stock, so it is the only one that
  // can be searched through it; any other store searches its own part list. An
  // unresolved code (stores still loading) keeps the historical behaviour
  // rather than searching every store at once.
  const { activeCode, activeStore } = useStores();
  const { user, logout } = useAuth();
  const childParts = !activeCode || activeCode === "CHILD_PART";
  // Tracked rather than assumed: the user can leave fullscreen with Esc or F11
  // without touching the button, and a button showing the wrong state is worse
  // than no button.
  const [full, setFull] = useState(false);
  useEffect(() => {
    const sync = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState([]);
  const [searching, setSearching] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef(null);
  const searchRef = useRef(null);

  // Live active notifications — cached + polled via React Query (was a manual
  // setInterval). data defaults to [] before the first fetch lands.
  const { data: notifications = [] } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => notificationService.list().then((res) => res.data.data),
    refetchInterval: 60000,
  });

  // Close the bell and the search results on any outside click.
  useEffect(() => {
    const handler = (e) => {
      if (bellRef.current && !bellRef.current.contains(e.target)) setBellOpen(false);
      if (searchRef.current && !searchRef.current.contains(e.target)) setResultsOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Search as you type, so a fragment of an old part number ("-10150") lists
  // every part carrying it and you pick the one you meant — rather than having
  // to press Enter and read a filtered table to find out what matched.
  // Server-side, so it stays a substring match over part no, old part no and
  // name, and so the part's other supplier variants (SOB) come back with it.
  useEffect(() => {
    const kw = query.trim();
    if (kw.length < 2) {
      setMatches([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    // Debounced: typing a 13-character part number should cost one request at
    // the end, not thirteen on the way there.
    const id = setTimeout(() => {
      const request = childParts
        ? liveStockService.list({ keyword: kw, per_page: 12 })
          .then((res) => res.data.data.map((r) => asChildPartResult(r, kw)))
        : partService.list({ store_code: activeCode, keyword: kw, is_active: true, per_page: 12 })
          .then((res) => res.data.data.map(asSpareResult));

      request
        .then((rows) => { if (!cancelled) setMatches(rows); })
        .catch(() => { if (!cancelled) setMatches([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    // Cancelling the timer alone left an in-flight request able to land after
    // the store changed, putting one store's parts under the other's search.
    return () => { cancelled = true; clearTimeout(id); };
  }, [query, childParts, activeCode]);

  // Where a result lands: Child Parts has a live-stock screen to open a part
  // in, the other stores have their own Part Master.
  const resultsPath = (kw) => (childParts
    ? `/live-stock?keyword=${encodeURIComponent(kw)}`
    : `/parts?keyword=${encodeURIComponent(kw)}`);

  const openPart = (row) => {
    navigate(resultsPath(row.partNo));
    setQuery("");
    setResultsOpen(false);
  };

  const handleSearch = (e) => {
    e.preventDefault();
    const kw = query.trim();
    if (!kw) return;
    navigate(resultsPath(kw));
    setQuery("");
    setResultsOpen(false);
  };

  return (
    <header className="bg-gradient-to-b from-white/95 to-white/85 dark:from-navy-900/95 dark:to-navy-900/75 backdrop-blur-sm border-b border-slate-200/80 dark:border-navy-800 shadow-[0_6px_18px_rgba(15,31,56,0.05)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.35)] sticky top-0 z-20">
      {/* Left | centre | right, with equal side columns so the title sits dead
          centre whatever the two action groups' widths are. */}
      <div className="flex items-center gap-3 px-4 lg:px-6 py-2">
        {/* Left group — a Home button and the global search. Fixed to its
            content (shrink-0) so the flexible centre title never overlaps it. */}
        <div className="shrink-0 flex items-center gap-2">
          <Link
            to="/"
            title="Home"
            aria-label="Home"
            className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg border border-slate-200 dark:border-navy-700
              text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-navy-800 hover:text-toyotared transition-colors"
          >
            <Home size={16} />
          </Link>
          {showSearch && (
            <div ref={searchRef} className="relative hidden lg:block w-48 xl:w-64">
              <form onSubmit={handleSearch}>
                <div className="relative">
                  <span className="absolute left-3 top-1.5 text-sm pointer-events-none">🔍</span>
                  <input
                    className="w-full rounded-full border border-slate-200 dark:border-navy-700 bg-slate-50 dark:bg-navy-800 pl-9 pr-4 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-toyotared/40 focus:border-toyotared transition"
                    placeholder={childParts
                      ? "Search Part No, Old Part No or Part Name..."
                      : "Search Part No or Part Name..."}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setResultsOpen(true);
                    }}
                    onFocus={() => setResultsOpen(true)}
                  />
                </div>
              </form>

              {resultsOpen && query.trim().length >= 2 && (
                <div className="absolute left-0 right-0 top-full mt-1 z-30 rounded-xl border border-slate-200 dark:border-navy-700 bg-white dark:bg-navy-900 shadow-lg overflow-hidden">
                  {searching && matches.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-slate-400">Searching…</p>
                  ) : matches.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-slate-400">
                      No part found for “{query.trim()}”{activeStore ? ` in ${activeStore.name}` : ""}.
                    </p>
                  ) : (
                    <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 dark:divide-navy-800">
                      {matches.map((r) => (
                        <button
                          key={r.key}
                          type="button"
                          onClick={() => openPart(r)}
                          className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-navy-800 transition-colors"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-sm text-slate-800 dark:text-white truncate">{r.partNo}</span>
                            <span className="flex items-center gap-1.5 shrink-0">
                              {r.sob && (
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300">
                                  SOB
                                </span>
                              )}
                              {r.status && <Badge status={r.status} />}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2 mt-0.5">
                            <span className="text-[11px] text-slate-400 truncate">
                              {r.secondary ? `${r.secondary} · ` : ""}{r.name}
                            </span>
                            <span className="text-[11px] text-slate-500 dark:text-slate-400 shrink-0 tabular">
                              {r.right}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* The page title — the flexible centre column: it grows to fill the
            space between the two fixed groups and truncates rather than
            overlapping them. */}
        <h1
          className="flex-1 min-w-0 text-center text-xl lg:text-2xl font-extrabold tracking-tight leading-none truncate px-2"
          style={{
            backgroundImage: "linear-gradient(92deg,#ff7a18 0%,#eb0a1e 48%,#c81d77 100%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            WebkitTextFillColor: "transparent",
            color: "transparent",
            filter: "drop-shadow(0 2px 8px rgba(235,10,30,0.25))",
          }}
        >
          {title}
        </h1>

        {/* Right group — the plant switch and the session / utility controls.
            Fixed to its content (shrink-0) so it never rides over the title. */}
        <div className="shrink-0 flex items-center justify-end gap-3">
          <div className="flex items-center gap-1.5 shrink-0">
          <PlantToggle />
          <ErpStatusPill />
          <button
            onClick={toggleFullscreen}
            className="hidden lg:inline-flex items-center justify-center h-8 w-8 rounded-lg border border-slate-200 dark:border-navy-700
              text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-navy-800 transition-colors"
            title={full ? "Leave fullscreen" : "Fill the screen"}
          >
            {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>

          <div className="relative" ref={bellRef}>
            <button
              onClick={() => setBellOpen((o) => !o)}
              className="relative h-8 w-8 flex items-center justify-center text-base hover:opacity-70 transition-opacity"
              title="Notifications"
            >
              🔔
              {notifications.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 bg-toyotared text-white text-[10px] font-bold rounded-full min-w-[15px] h-[15px] px-0.5 flex items-center justify-center">
                  {notifications.length}
                </span>
              )}
            </button>

            {bellOpen && (
              <div className="absolute right-0 mt-2 w-80 bg-white dark:bg-navy-900 rounded-xl shadow-lg border border-slate-200 dark:border-navy-800 overflow-hidden z-30">
                <p className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-400 border-b border-slate-100 dark:border-navy-800">
                  Notifications
                </p>
                {notifications.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-slate-400 text-center">No active notifications</p>
                ) : (
                  <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-navy-800">
                    {notifications.map((n) => (
                      <div key={n.id} className="px-4 py-2.5 text-sm">
                        <p className="text-slate-700 dark:text-slate-200">{n.message}</p>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          {n.created_at ? new Date(n.created_at).toLocaleString() : ""}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <Link
            to="/reports"
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-[#ff2a3c] to-toyotared px-2.5 py-1.5 text-xs font-semibold
              text-white shadow-[0_6px_16px_rgba(235,10,30,0.35)] hover:brightness-110 transition shrink-0"
            title="Reports"
          >
            <FileDown size={14} /> <span className="hidden lg:inline">Report</span>
          </Link>

          {/* Settings — admins only (the page is admin-gated anyway). */}
          {user?.is_admin && (
            <Link
              to="/settings"
              title="Settings"
              aria-label="Settings"
              className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-slate-200 dark:border-navy-700
                text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-navy-800 hover:text-toyotared transition-colors"
            >
              <SettingsIcon size={15} />
            </Link>
          )}

          {/* Sign out — the session control, also at the foot of the sidebar. */}
          <button
            onClick={logout}
            title={user ? `Sign out ${user.username}` : "Sign out"}
            aria-label="Sign out"
            className="inline-flex items-center justify-center h-8 w-8 rounded-lg border border-slate-200 dark:border-navy-700
              text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-navy-800 hover:text-toyotared transition-colors"
          >
            <LogOut size={15} />
          </button>
          </div>
        </div>
      </div>
    </header>
  );
}
