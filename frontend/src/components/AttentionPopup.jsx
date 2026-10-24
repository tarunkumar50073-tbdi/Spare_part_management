import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { can } from "../utils/permissions.js";
import { managementService } from "../services/managementService.js";

// The pop-up that greets whoever opens the app: "What needs your attention" —
// the open lines of the Spare Store's action tracker, worst first, each with its
// count and one tap from its list. It opens once per browser tab (so a page
// reload does not repeat it) and again after every sign-in
// (AuthContext.freshLogin), and only when something is actually open.
const STORE = "MAINTENANCE";
const SHOWN_KEY = "dx_attention_shown";
const shownThisTab = () => { try { return sessionStorage.getItem(SHOWN_KEY) === "1"; } catch { return false; } };
const markShown = () => { try { sessionStorage.setItem(SHOWN_KEY, "1"); } catch { /* private mode — it may show again */ } };
const num = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN"));

const ICON = {
  critical: "🚨", reorder: "🛒", excess: "📦", srv_pending: "🧪", erp_gap: "⚖️", confirm_pending: "✅",
  returns_pending: "↩️", rgp_overdue: "🔧", no_rate: "💰", erp_pending: "🔄",
};

// Three bands, the way a to-do reads: what is late or critical, what is pending,
// and what is only worth knowing.
const BANDS = [
  { key: "now", title: "Critical — act now", icon: "🔴", head: "text-rose-700 dark:text-rose-300", badge: "bg-rose-600",
    has: (it) => it.overdue || it.severity === "critical" },
  { key: "todo", title: "Pending — your to-do", icon: "📋", head: "text-orange-700 dark:text-orange-300", badge: "bg-orange-500",
    has: (it) => it.severity === "warning" },
  { key: "info", title: "For information", icon: "ℹ️", head: "text-blue-700 dark:text-blue-300", badge: "bg-blue-500",
    has: () => true },
];

export default function AttentionPopup() {
  const { user, freshLogin, ackFreshLogin } = useAuth();
  const navigate = useNavigate();
  const [tracker, setTracker] = useState(null);
  const closeRef = useRef(null);

  useEffect(() => {
    if (!user || (!freshLogin && shownThisTab())) return undefined;
    // The tracker is the Spare Store's; an account that cannot read it is not greeted.
    if (!(can(user, "spare_store") || can(user, "live_dashboard"))) { markShown(); ackFreshLogin(); return undefined; }
    let alive = true;
    // Silent: a failed call (an older backend, a refused store) simply shows no
    // pop-up — and is not marked as shown, so the next page load tries again.
    managementService.get(STORE, undefined, undefined, { silent: true })
      .then((r) => {
        if (!alive) return;
        markShown();
        const t = r.data?.data?.tracker;
        if (t && (t.items || []).some((it) => it.status === "OPEN")) setTracker(t);
      })
      .catch(() => {})
      .finally(() => { if (alive) ackFreshLogin(); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freshLogin, user]);

  const close = () => setTracker(null);
  useEffect(() => {
    if (!tracker) return undefined;
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tracker]);

  if (!tracker) return null;

  // Each open line lands in the first band that claims it.
  const open = (tracker.items || []).filter((it) => it.status === "OPEN");
  const taken = new Set();
  const bands = BANDS.map((band) => {
    const rows = open.filter((it) => !taken.has(it.key) && band.has(it));
    rows.forEach((it) => taken.add(it.key));
    return { ...band, rows, total: rows.reduce((s, it) => s + (Number(it.count) || 0), 0) };
  }).filter((band) => band.rows.length);
  const pending = open.reduce((s, it) => s + (Number(it.count) || 0), 0);
  const overdue = tracker.summary?.overdue || 0;

  const go = (to) => { close(); navigate(to); };
  const openLine = (it) => {
    if (!it.link?.to) return;
    go(it.link.status ? `${it.link.to}?status=${encodeURIComponent(it.link.status)}` : it.link.to);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-navy-950/55" onClick={close} />
      <div role="dialog" aria-modal="true" aria-labelledby="attention-title"
        className="relative w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl animate-[fadeIn_0.15s_ease-out] dark:bg-navy-900">
        <div className="px-5 py-4 text-white" style={{ background: "linear-gradient(120deg,#0f1f38 0%,#1d4368 100%)" }}>
          <h3 id="attention-title" className="flex items-center gap-2 text-[17px] font-extrabold">
            <span aria-hidden="true">⚠️</span> What needs your attention
          </h3>
          <p className="mt-0.5 text-[12.5px] text-white/80">
            <span className={overdue ? "font-bold text-amber-300" : ""}>{num(overdue)} overdue</span> · {num(pending)} pending in total
          </p>
        </div>

        <div className="max-h-[58vh] space-y-3 overflow-y-auto px-4 py-3">
          {bands.map((band) => (
            <section key={band.key} aria-label={band.title}>
              <p className={`flex items-center gap-1.5 px-1 text-[11px] font-extrabold uppercase tracking-wider ${band.head}`}>
                <span aria-hidden="true">{band.icon}</span> {band.title} · {num(band.total)}
              </p>
              <ul className="mt-1 divide-y divide-slate-100 dark:divide-navy-800">
                {band.rows.map((it) => (
                  <li key={it.key}>
                    <button type="button" onClick={() => openLine(it)} disabled={!it.link?.to}
                      className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/40 disabled:cursor-default dark:hover:bg-navy-800/60">
                      <span className="w-6 shrink-0 text-center text-[17px] leading-none" aria-hidden="true">{ICON[it.key] || "•"}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-slate-800 dark:text-white">{it.label}</span>
                        <span className="block truncate text-[11.5px] text-slate-400">
                          {[it.overdue ? "Past its target date" : null, it.detail || it.action, it.owner ? `Action by ${it.owner}` : null].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <span className={`grid h-7 min-w-[1.75rem] shrink-0 place-items-center rounded-full px-2 text-[12px] font-extrabold tabular-nums text-white ${it.overdue ? "bg-rose-600" : band.badge}`}>
                        {num(it.count)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 dark:border-navy-800">
          {can(user, "action_tracker") ? (
            <button type="button" onClick={() => go("/action-tracker")}
              className="text-sm font-semibold text-toyotared hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/40">
              Open Action Tracker →
            </button>
          ) : <span />}
          <button ref={closeRef} type="button" className="btn-secondary" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
