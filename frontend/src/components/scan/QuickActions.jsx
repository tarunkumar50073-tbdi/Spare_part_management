import React from "react";
import { ChevronRight, Eye } from "lucide-react";
import { ACTIONS } from "../../lib/scanStatus.js";
import { scanIcon } from "./scanIcons.js";

// (e) What can be done with the part NOW (spec 27 / 28). The server decides
// which actions are valid for the part's current state; only those are drawn —
// a part with the supplier shows RGP Return, never Issue. The next step the
// flow expects (primary_action) is the big red button; the rest sit below it.
// Actions this user may not perform are left out too (the server would refuse
// them anyway), and the ones not open right now are listed with the reason
// under "Why not…", so nobody has to guess why Issue is missing.

export const actionLabel = (a) => ACTIONS[a.key]?.label || a.key;

// Actions whose `count` is the number of open documents they would act on
// ("Return 3" = three issues still out). For print / history the server's
// count means something else (prints made, events), so no badge there.
const DOC_ACTIONS = new Set([
  "RGP_GRN", "RGP_RETURN", "QUALITY_CLEARANCE", "RECORD_GRN", "INSPECT", "RETURN", "UPDATE_INSTALLATION", "RGP_OUT",
]);

function ActionButton({ action, primary, onClick }) {
  const meta = ACTIONS[action.key] || {};
  const Icon = scanIcon(meta.icon);
  const count = DOC_ACTIONS.has(action.key) && Number(action.count) > 1 ? action.count : null;
  if (primary) {
    return (
      <button type="button" onClick={onClick}
        className="btn-primary w-full justify-center py-3.5 text-base font-semibold">
        <Icon size={20} aria-hidden="true" />
        {actionLabel(action)}
        {count && <span className="rounded-full bg-white/20 px-2 text-xs tabular">{count}</span>}
        <ChevronRight size={18} className="ml-auto" aria-hidden="true" />
      </button>
    );
  }
  return (
    <button type="button" onClick={onClick} className="btn-secondary justify-center py-2.5">
      <Icon size={16} aria-hidden="true" />
      <span className="truncate">{actionLabel(action)}</span>
      {count && <span className="rounded-full bg-slate-200 px-1.5 text-[11px] tabular text-slate-600 dark:bg-navy-700 dark:text-slate-300">{count}</span>}
    </button>
  );
}

/**
 * actions      scan.actions — every key, in display order, with enabled + reason
 * primaryKey   scan.primary_action
 * allowed(key) the user holds the right for this action
 * onAction(key)
 */
export default function QuickActions({ actions = [], primaryKey, allowed, onAction }) {
  const open = actions.filter((a) => a.enabled && allowed(a.key));
  const primary = open.find((a) => a.key === primaryKey) || null;
  const rest = open.filter((a) => a !== primary);
  // Grouped by reason — an inactive part closes everything for ONE reason,
  // which is said once, not twelve times.
  const closed = [];
  for (const a of actions) {
    if (a.enabled || !a.reason) continue;
    const g = closed.find((c) => c.reason === a.reason);
    if (g) g.labels.push(actionLabel(a));
    else closed.push({ reason: a.reason, labels: [actionLabel(a)] });
  }
  const closedCount = closed.reduce((n, c) => n + c.labels.length, 0);
  const viewOnly = actions.some((a) => a.enabled && !allowed(a.key));

  return (
    <section className="card p-4" aria-label="Quick actions">
      <h2 className="kpi-label mb-2.5">Quick actions</h2>
      {primary && (
        <div className="mb-2.5">
          <p className="mb-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400">Next step</p>
          <ActionButton action={primary} primary onClick={() => onAction(primary.key)} />
        </div>
      )}
      {rest.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {rest.map((a) => <ActionButton key={a.key} action={a} onClick={() => onAction(a.key)} />)}
        </div>
      )}
      {open.length === 0 && (
        <p className="text-sm text-slate-500 dark:text-slate-400">No action is open for this part right now.</p>
      )}
      {viewOnly && (
        <p className="mt-2.5 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <Eye size={13} aria-hidden="true" />View only — you can look parts up, but recording a movement needs edit rights on Scan Part.
        </p>
      )}
      {closed.length > 0 && (
        <details className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          <summary className="cursor-pointer select-none font-semibold hover:text-slate-700 dark:hover:text-slate-200">
            Why not… ({closedCount} not available now)
          </summary>
          <ul className="mt-1.5 space-y-0.5 pl-1">
            {closed.map((c) => (
              <li key={c.reason}><b className="font-semibold text-slate-600 dark:text-slate-300">{c.labels.join(", ")}</b> — {c.reason}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
