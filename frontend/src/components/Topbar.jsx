import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Info, Search, Siren, TriangleAlert } from "lucide-react";
import Badge from "./Badge.jsx";
import IconTile, { tileStyle } from "./IconTile.jsx";
import { liveStockService } from "../services/liveStockService.js";
import {
  ALERTS_REFRESH_MS, alertsKey, alertsStoreFor, canOpenAction, fetchAlerts,
} from "../services/spareAlertsService.js";
import { partService } from "../services/partService.js";
import { storeDashboardService } from "../services/storeDashboardService.js";
import { useStores } from "../context/StoreContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { can, seesSpareStock } from "../utils/permissions.js";
import { parseServerTime } from "../lib/format.js";

// The coming multi-plant switch. Today the app serves one plant, so Plant 1 is
// the live data and Plant 2 is a disabled placeholder. When the second site's
// data and per-plant permissions land, a user will see only the plant(s) they
// may access and admins / plant-heads will toggle between both here.
// Below 1280 px it shows just "P1" (Plant 2 is only a placeholder), so the page
// title keeps room to show in full on a small laptop / tablet window.
// Each plant wears the app-icon tile, like the bar's other controls: the
// current one lit in Toyota red, the coming one dimmed.
function PlantToggle() {
  const { dark } = useTheme();
  return (
    <div className="hidden md:inline-flex items-center gap-1.5">
      <button
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-[11px] px-2.5 text-xs font-bold text-toyotared dark:text-white"
        style={tileStyle("#f87171", true, !dark)}
        title="Plant 1 — current"
      >
        <span aria-hidden="true" className="text-[15px] leading-none">🏭</span>
        <span className="xl:hidden">P1</span>
        <span className="hidden xl:inline">Plant&nbsp;1</span>
      </button>
      <button
        type="button"
        disabled
        title="Plant 2 — coming soon (its data isn't connected yet)"
        className="hidden xl:inline-flex h-8 items-center gap-1.5 rounded-[11px] px-2.5 text-xs font-bold text-slate-400 dark:text-slate-300 opacity-60 cursor-not-allowed"
        style={tileStyle("#94a3b8", false, !dark)}
      >
        <span aria-hidden="true" className="text-[15px] leading-none grayscale">🏭</span>
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
  const at = live ? parseServerTime(syncedAt) : null;
  const label = live
    ? `Last ERP data: ${at?.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) ?? "—"}`
    : "No ERP data yet";
  // Below 1536 px the pill says only "ERP 10 Aug", so the page title in the
  // centre has room to show in full (the store, 17 Oct 2026: "katna nhi chahiye").
  const short = live
    ? `ERP ${at?.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) ?? "—"}`
    : "No ERP data";

  return (
    <span
      className={`hidden xl:inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium
        ${live
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
          : "bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-slate-400"}`}
      title={live ? label : "ERP has not pushed a gate entry or stock figure yet"}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-500" : "bg-slate-400"}`} />
      <span className="2xl:hidden">{short}</span>
      <span className="hidden 2xl:inline">{label}</span>
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

// Each severity by shape as well as colour, the way the Notification Center
// marks it, so the bell does not rely on colour alone.
const BELL_SEVERITY = {
  critical: { Icon: Siren, tone: "text-rose-600 dark:text-rose-400" },
  warning: { Icon: TriangleAlert, tone: "text-amber-500 dark:text-amber-400" },
  info: { Icon: Info, tone: "text-blue-500 dark:text-blue-400" },
};

const asSpareResult = (row) => ({
  key: `sp-${row.id}`,
  partNo: row.part_no,
  name: row.part_name,
  secondary: row.location,
  spec: row.specification,
  status: null,
  sob: false,
  right: Number(row.unit_price || 0) > 0
    ? `₹${Number(row.unit_price).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
    : "—",
});

// Top bar: page title left, global part search in the middle, notification
// bell (the Spare Parts Store's computed alerts) on the right.
// This is the app's only search box — the dashboard used to carry a second one
// of its own. Account controls (user, sign out, theme) sit at the foot of the
// sidebar instead, since they belong to the session rather than to the page.
// The smallest the page title may shrink to before it is cut ("…").
const TITLE_MIN_PX = 13;

// Every top-bar control is the sidebar's app-icon tile (emoji, own colour), so
// the bar and the rail read as one set — but in the bar's own colour: white by
// day, navy by night (`light={!dark}`). The tile brightens and lifts on hover;
// `lit` marks the page or panel that is open.
const TILE = 32;
const tileBtn = "group relative inline-flex shrink-0 items-center justify-center rounded-[11px] "
  + "focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/50";
const tileHover = "transition group-hover:brightness-125 group-hover:-translate-y-px";

export default function Topbar({ title, showSearch = true }) {
  const navigate = useNavigate();
  const location = useLocation();
  // A long page name is never cut on a laptop (the store, 17 Oct 2026: "katna
  // nhi chahiye" — "Issuance & Consumption" read "Issuance & Consum…" at 1536
  // px): the title steps its font down until the whole name fits its space,
  // and is cut only below TITLE_MIN_PX on a very narrow window.
  const titleRef = useRef(null);
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return undefined;
    const fit = () => {
      el.style.fontSize = "";                       // back to the class size first
      let size = parseFloat(getComputedStyle(el).fontSize) || 24;
      while (el.scrollWidth > el.clientWidth && size > TITLE_MIN_PX) {
        size -= 1;
        el.style.fontSize = `${size}px`;
      }
    };
    fit();
    // The title's box follows the window and the side rail, not its own font
    // size, so refitting on a resize never loops.
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [title]);
  // Back belongs on a page you drilled INTO — not on a landing dashboard (which
  // already has Home + the sidebar), and not on a fresh load where "back" would
  // leave the app. Full-screen drill sheets carry their own back arrow above
  // this bar, so this only governs the plain routed pages.
  const LANDING_PATHS = ["/", "/dashboard", "/store/MAINTENANCE"];
  let hasHistory = false;
  try { hasHistory = (window.history.state?.idx ?? 0) > 0; } catch { hasHistory = false; }
  const showBack = hasHistory && !LANDING_PATHS.includes(location.pathname);
  // The box searches the store you are standing in. It used to always search
  // Child Parts live stock, so from the Spare Parts Store it answered every
  // query with "No part found" — the 481 spares were never being looked at.
  // Child Parts is the only store with live stock, so it is the only one that
  // can be searched through it; any other store searches its own part list. An
  // unresolved code (stores still loading) keeps the historical behaviour
  // rather than searching every store at once.
  const { activeCode, activeStore } = useStores();
  const { user, logout } = useAuth();
  const { dark, toggleDark } = useTheme();
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

  // The active store's alerts — the same cache entry the Notification Center
  // reads. The badge counts the critical + warning alerts (headlines; the parts
  // and issues listed under one are not counted again); info waits on the
  // page. The old Child Parts rack feed is gone with that store.
  const alertsCode = alertsStoreFor(activeCode);
  const { data: alertData, isError: alertsFailed, refetch: refetchAlerts } = useQuery({
    queryKey: alertsKey(alertsCode),
    queryFn: () => fetchAlerts(alertsCode),
    // Only for a login that may see the spare stock: the server refuses the
    // rest, and a refusal every few minutes would only be a toast.
    enabled: Boolean(alertsCode) && seesSpareStock(user),
    refetchInterval: ALERTS_REFRESH_MS,
  });
  const alertList = alertData?.alerts || [];
  const urgent = (alertData?.summary?.critical || 0) + (alertData?.summary?.warning || 0);
  // Headlines first so the short list shows the breadth of what is wrong; the
  // per-part / per-issue lines under them are on the page.
  const bellAlerts = [...alertList.filter((a) => !a.parent), ...alertList.filter((a) => a.parent)].slice(0, 8);
  const urgentLabel = `${urgent} ${urgent === 1 ? "alert needs" : "alerts need"} attention`;
  // A screen this user has no right to would only say "Access restricted";
  // the Notification Center still shows them the whole alert.
  const openAlert = (a) => {
    // Notification Center has its own right (23 Oct 2026): without it, an
    // alert whose screen the login may not open stays in the list.
    if (canOpenAction(user, a.action)) navigate(a.action.to);
    else if (can(user, "notifications")) navigate("/notifications");
    else return;
    setBellOpen(false);
  };

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
          {/* Back — one step in history, but only on a drilled-in sub-page: not on
              a landing dashboard or a fresh load (nothing to go back to). Drill
              sheets are full-screen modals with their own back arrow above this. */}
          {showBack && (
          <button
            type="button"
            onClick={() => navigate(-1)}
            title="Back"
            aria-label="Go back"
            className={tileBtn}
          >
            <IconTile emoji="⬅️" color="#94a3b8" size={TILE} light={!dark} className={tileHover} />
          </button>
          )}
          <Link
            to="/"
            title="Home"
            aria-label="Home"
            className={tileBtn}
          >
            <IconTile emoji="🏠" color="#60a5fa" size={TILE} light={!dark} className={tileHover} lit={LANDING_PATHS.includes(location.pathname)} />
          </Link>
          {showSearch && (
            <div ref={searchRef} className="relative hidden lg:block w-40 xl:w-52 2xl:w-64">
              <form onSubmit={handleSearch}>
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" aria-hidden="true" />
                  <input
                    className="w-full rounded-full border border-slate-200 dark:border-navy-700 bg-slate-50 dark:bg-navy-800 pl-9 pr-4 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-toyotared/40 focus:border-toyotared transition"
                    placeholder={childParts
                      ? "Search Part No, Old Part No or Part Name..."
                      : "Search Part No, name, category, spec… e.g. bearing 6204"}
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
                          {r.spec && (
                            <div className="text-[11px] text-slate-400 dark:text-slate-500 truncate mt-0.5">Spec: {r.spec}</div>
                          )}
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
            space between the two fixed groups; its font shrinks to fit (see
            titleRef above) and it truncates only as a last resort, never
            overlapping them. */}
        <h1
          ref={titleRef}
          // Keeps its flex space on a phone (so the icons stay right-aligned)
          // but isn't drawn there: squeezed to ~16px it read as a stray red mark,
          // and every page carries its own heading anyway.
          className="invisible sm:visible flex-1 min-w-0 text-center text-xl lg:text-2xl font-extrabold tracking-tight leading-none truncate px-2"
          style={{
            backgroundImage: "linear-gradient(92deg,#ff7a18 0%,#eb0a1e 48%,#c81d77 100%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            WebkitTextFillColor: "transparent",
            color: "transparent",
            filter: "drop-shadow(0 2px 8px rgba(235,10,30,0.25))",
          }}
          // Should a window be too narrow even at the smallest size, the
          // whole name still reads on hover.
          title={title}
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
            className={`${tileBtn} hidden lg:inline-flex`}
            title={full ? "Leave fullscreen" : "Fill the screen"}
            aria-label={full ? "Leave fullscreen" : "Fill the screen"}
          >
            <IconTile emoji={full ? "🪟" : "📺"} color="#a78bfa" size={TILE} light={!dark} className={tileHover} lit={full} />
          </button>

          <div className="relative" ref={bellRef}>
            <button
              onClick={() => setBellOpen((o) => !o)}
              className={tileBtn}
              title={urgent ? `Notifications: ${urgentLabel}` : "Notifications"}
              aria-label={urgent ? `Notifications, ${urgentLabel}` : "Notifications"}
            >
              <IconTile emoji="🔔" color="#fbbf24" size={TILE} light={!dark} className={tileHover} lit={bellOpen} />
              {urgent > 0 && (
                <span className="absolute -top-1.5 -right-1.5 ring-2 ring-white dark:ring-navy-900 bg-toyotared text-white text-[10px] font-bold rounded-full min-w-[15px] h-[15px] px-0.5 flex items-center justify-center">
                  {urgent > 99 ? "99+" : urgent}
                </span>
              )}
            </button>

            {bellOpen && (
              <div className="absolute right-0 mt-2 w-80 bg-white dark:bg-navy-900 rounded-xl shadow-lg border border-slate-200 dark:border-navy-800 overflow-hidden z-30">
                <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-100 dark:border-navy-800">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Notifications</p>
                  {alertData && alertData.summary.total > 0 && (
                    <span className="text-[11px] text-slate-400 tabular" title="Alerts, not the parts or issues listed under them">
                      {alertData.summary.critical} critical · {alertData.summary.warning} warning
                    </span>
                  )}
                </div>
                {!alertsCode ? (
                  <p className="px-4 py-6 text-sm text-slate-400 text-center">Alerts cover the Spare Parts Store.</p>
                ) : !alertData && alertsFailed ? (
                  <div className="px-4 py-6 text-center">
                    <p className="text-sm text-slate-500 dark:text-slate-400">Could not load the alerts.</p>
                    <button type="button" onClick={() => refetchAlerts()} className="mt-1 text-xs font-semibold text-toyotared hover:underline">
                      Retry
                    </button>
                  </div>
                ) : !alertData ? (
                  <p className="px-4 py-6 text-sm text-slate-400 text-center">Checking…</p>
                ) : bellAlerts.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-slate-400 text-center">No alerts — nothing needs attention right now.</p>
                ) : (
                  <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-navy-800">
                    {bellAlerts.map((a) => {
                      const sev = BELL_SEVERITY[a.severity] || BELL_SEVERITY.info;
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => openAlert(a)}
                          className="w-full text-left px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-navy-800 transition-colors"
                        >
                          <span className="flex items-start gap-2">
                            <sev.Icon size={14} className={`mt-0.5 shrink-0 ${sev.tone}`} aria-hidden="true" />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                                <span className="sr-only">{a.severity}: </span>{a.title}
                              </span>
                              <span className="block text-[11px] text-slate-400 line-clamp-2">{a.message}</span>
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {can(user, "notifications") && (
                <Link
                  to="/notifications"
                  onClick={() => setBellOpen(false)}
                  className="block border-t border-slate-100 dark:border-navy-800 px-4 py-2 text-center text-xs font-semibold text-toyotared hover:bg-slate-50 dark:hover:bg-navy-800"
                >
                  View all{alertData?.summary.total ? ` (${alertData.summary.total})` : ""}
                </Link>
                )}
              </div>
            )}
          </div>
          {can(user, "reports") && (
          <Link
            to="/reports"
            className={tileBtn}
            title="Reports"
            aria-label="Reports"
          >
            <IconTile emoji="📊" color="#fb7185" size={TILE} light={!dark} className={tileHover} lit={location.pathname.startsWith("/reports")} />
          </Link>
          )}

          {/* Day / night — the theme switch, beside the other session controls. */}
          <button
            onClick={toggleDark}
            title={dark ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            className={tileBtn}
          >
            <IconTile emoji={dark ? "☀️" : "🌙"} color="#818cf8" size={TILE} light={!dark} className={tileHover} />
          </button>

          {/* Settings — admins only (the page is admin-gated anyway). */}
          {user?.is_admin && (
            <Link
              to="/settings"
              title="Settings"
              aria-label="Settings"
              className={tileBtn}
            >
              <IconTile emoji="⚙️" color="#94a3b8" size={TILE} light={!dark} className={tileHover} lit={location.pathname.startsWith("/settings")} />
            </Link>
          )}

          {/* Sign out — the session control. */}
          <button
            onClick={logout}
            title={user ? `Sign out ${user.username}` : "Sign out"}
            aria-label="Sign out"
            className={tileBtn}
          >
            <IconTile emoji="🚪" color="#f87171" size={TILE} light={!dark} className={tileHover} />
          </button>
          </div>
        </div>
      </div>
    </header>
  );
}
