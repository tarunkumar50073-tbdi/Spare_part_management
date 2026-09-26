import React, { useEffect, useState } from "react";
import { Ban, Circle, CircleCheck, CircleMinus, Clock, TriangleAlert, Undo2 } from "lucide-react";
import { fmtStamp, num, parseServerTime } from "../../lib/format.js";

// The two-stage spare issue, drawn for ONE ISSUE ledger row: the store hands the
// part over (Stage 1), then the fitter re-scans it and confirms the line +
// machine it went on (Stage 2). Every step is read from what the row actually
// records — status, confirmed_at, line/machine, actual_qty — never from what
// "should" have happened. Statuses: ISSUE_STATUSES in models/spare_stock.py.

const DAY_MS = 86_400_000;
// Unconfirmed longer than this is flagged amber — two days is ample time for
// the fitter to re-scan the part.
export const OVERDUE_AFTER_MS = 2 * DAY_MS;

export const ISSUE_STATUS = {
  ISSUED_BY_STORE: { label: "Issued by store", badge: "badge-info" },
  PENDING_USER_CONFIRMATION: { label: "Awaiting user confirmation", badge: "badge-warning" },
  PARTIALLY_USED: { label: "Installed — partly used", badge: "badge-success" },
  INSTALLED: { label: "Installed", badge: "badge-success" },
  RETURNED: { label: "Returned to store", badge: "badge-neutral" },
  PARTIALLY_RETURNED: { label: "Partly returned to store", badge: "badge-neutral" },
  CANCELLED: { label: "Cancelled", badge: "badge-neutral" },
};
// The two statuses the Stage-2 queue holds (pending_confirmations).
const AWAITING = new Set(["ISSUED_BY_STORE", "PENDING_USER_CONFIRMATION"]);
const USED = new Set(["INSTALLED", "PARTIALLY_USED"]);

export const issueStatusLabel = (status) => {
  if (ISSUE_STATUS[status]) return ISSUE_STATUS[status].label;
  if (!status) return "Status not recorded"; // issues from before the two-stage flow
  const words = status.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

// A confirmation with 0 used is stored as PARTIALLY_USED (confirm_installation:
// used < issued) — nothing was fitted, so it must not read as installed.
export const isNoneUsed = (issue) =>
  issue?.status === "PARTIALLY_USED" && issue.actual_qty != null && Number(issue.actual_qty) === 0;

/** Pass `issue` when the row is at hand, so a none-used confirmation says so. */
export function IssueStatusPill({ status, issue }) {
  if (isNoneUsed(issue)) return <span className="badge badge-neutral">Confirmed — none used</span>;
  const s = issue ? issue.status : status;
  return <span className={`badge ${ISSUE_STATUS[s]?.badge || "badge-neutral"}`}>{issueStatusLabel(s)}</span>;
}

// Ledger times are stored in UTC and SQLite hands them back with no offset —
// read such a stamp as UTC so the shown time and the age are the real moment.
// Kept for existing importers; this file itself reads stamps via parseServerTime.
export const utcStamp = (iso) =>
  !iso || iso.length <= 10 || /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;

/** How long ago `iso` was, as { ms, text, overdue }; null when there is no time. */
export function issueAge(iso, nowMs = Date.now()) {
  const t = parseServerTime(iso)?.getTime() ?? NaN;
  if (Number.isNaN(t)) return null;
  // A client clock a little behind the server's must not read as "-2 min".
  const ms = Math.max(0, nowMs - t);
  const mins = Math.floor(ms / 60_000);
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(ms / DAY_MS);
  let text;
  if (mins < 1) text = "just now";
  else if (hours < 1) text = `${mins} min ago`;
  else if (days < 1) text = `${hours} h ago`;
  // Hours kept for the first week so "2 d 5 h" reads as past the 2-day line.
  else if (days < 7) text = hours % 24 ? `${days} d ${hours % 24} h ago` : `${days} d ago`;
  else text = `${days} d ago`;
  return { ms, text, overdue: ms > OVERDUE_AFTER_MS };
}

/** A clock that ticks once a minute — enough for "3 d ago", and cheap for a list. */
export function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** "issued 3 d ago" — amber with a warning icon once past two days. */
export function IssueAge({ at, now, prefix = "issued" }) {
  const age = issueAge(at, now);
  if (!age) return <span className="text-[11px] text-slate-400">Issue time not recorded</span>;
  const Icon = age.overdue ? TriangleAlert : Clock;
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular ${
        age.overdue
          ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
          : "text-slate-500 dark:text-slate-400"}`}
      title={age.overdue ? "Waiting more than 2 days for the fitter's confirmation" : undefined}>
      <Icon size={12} aria-hidden="true" />
      {prefix ? `${prefix} ${age.text}` : age.text}
      {age.overdue && <span className="sr-only"> (over 2 days)</span>}
    </span>
  );
}

const STATE = {
  done: { Icon: CircleCheck, word: "Done", icon: "text-emerald-600 dark:text-emerald-400", wordTone: "text-emerald-700 dark:text-emerald-300", rail: "bg-emerald-500" },
  current: { Icon: Clock, word: "Waiting", icon: "text-amber-600 dark:text-amber-400", wordTone: "text-amber-700 dark:text-amber-300", rail: "bg-amber-400" },
  pending: { Icon: Circle, word: "Not yet", icon: "text-slate-300 dark:text-slate-600", wordTone: "text-slate-400", rail: "bg-slate-200 dark:bg-navy-700" },
  skipped: { Icon: CircleMinus, word: "Not reached", icon: "text-slate-300 dark:text-slate-600", wordTone: "text-slate-400", rail: "bg-slate-200 dark:bg-navy-700" },
};

// How an issue can end other than by being fitted.
const ENDINGS = {
  RETURNED: { Icon: Undo2, text: "Came back on a return slip — nothing of this issue is still out." },
  PARTIALLY_RETURNED: { Icon: Undo2, text: "Some came back on a return slip — the rest is still out." },
  CANCELLED: { Icon: Ban, text: "This issue is closed." },
};

function buildSteps(issue) {
  const s = issue.status;
  const qty = num(issue.qty);
  const issuedQty = Number(issue.qty);
  // Confirmation stamps confirmed_at and INSTALLED/PARTIALLY_USED together; a
  // later return overwrites the status but keeps the stamp.
  const confirmed = Boolean(issue.confirmed_at) || USED.has(s);
  // Nothing more can happen to a fully returned or cancelled issue, and an
  // issue with no status predates the two-stage flow.
  const closed = s === "RETURNED" || s === "CANCELLED";
  const legacy = !s;
  const later = closed || legacy ? "skipped" : "pending";

  const issued = {
    key: "issued", title: "Issued by store", state: "done",
    lines: [
      fmtStamp(issue.issued_at),
      `Qty ${qty} · ${issue.department || "department not recorded"}`,
      issue.issued_by && `by ${issue.issued_by}`,
    ],
  };
  // issued_to is typed on the same Stage-1 form — there is no separate hand-over
  // moment, so the step says so instead of implying one.
  const handed = {
    key: "handed", state: "done",
    title: issue.issued_to ? `Handed to ${issue.issued_to}` : "Handed over",
    lines: [issue.issued_to ? "Recorded at issue (same moment)" : "Person's name not recorded at issue"],
  };

  const line = [issue.line_name, issue.line_no].filter(Boolean).join(" ");
  const confirm = confirmed
    ? {
      key: "confirm", title: "Machine / line confirmed", state: "done",
      lines: [
        issue.confirmed_at && fmtStamp(issue.confirmed_at),
        line ? `Line ${line}` : "Line not given",
        issue.machine ? `Machine ${issue.machine}` : "Machine not given",
        issue.confirmed_by && `by ${issue.confirmed_by}`,
      ],
    }
    : {
      key: "confirm", title: "Machine / line confirmed",
      state: AWAITING.has(s) ? "current" : later,
      lines: [
        AWAITING.has(s) ? "Fitter to re-scan and confirm"
          : legacy ? "Not tracked for this issue"
            : closed ? "Not confirmed before the issue closed" : "Not confirmed yet",
        issue.machine && `Machine named at issue: ${issue.machine}`,
      ],
    };

  // INSTALLED with no figure counts as fully used (as the backend's
  // _consumed_qty does); otherwise actual_qty is what the fitter recorded.
  const used = issue.actual_qty != null ? Number(issue.actual_qty) : s === "INSTALLED" ? issuedQty : null;
  let install;
  if (confirmed && used > 0) {
    install = {
      state: "done", title: used < issuedQty ? "Installed (part used)" : "Installed",
      lines: [`${num(used)} of ${qty} used`],
    };
  } else if (confirmed) {
    install = {
      state: "skipped", word: used === 0 ? "None used" : "Not recorded", title: used === 0 ? "Not installed" : "Installed",
      lines: [used === 0 ? `0 of ${qty} used` : "Usage not recorded"],
    };
  } else {
    install = { state: later, title: "Installed", lines: [later === "skipped" ? "Not reached" : "Not yet"] };
  }
  return [issued, handed, confirm, { key: "installed", ...install }];
}

/** One issue's lifecycle as a compact horizontal stepper (2 columns on a phone). */
export default function IssueLifecycle({ issue, className = "", heading = "Issue lifecycle" }) {
  if (!issue) return null;
  const steps = buildSteps(issue);
  const ending = ENDINGS[issue.status];
  return (
    <div className={className}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{heading}</span>
        <IssueStatusPill issue={issue} />
      </div>
      <ol className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4" aria-label={heading}>
        {steps.map((st, i) => {
          const look = STATE[st.state];
          return (
            <li key={st.key} className="min-w-0" aria-current={st.state === "current" ? "step" : undefined}>
              <div className={`h-1 rounded-full ${look.rail}`} aria-hidden="true" />
              <div className="mt-2 flex items-start gap-1.5">
                <look.Icon size={15} className={`mt-0.5 shrink-0 ${look.icon}`} aria-hidden="true" />
                <div className="min-w-0">
                  <p className={`text-[10px] font-bold uppercase tracking-wide ${look.wordTone}`}>
                    {i + 1} · {st.word || look.word}
                  </p>
                  <p className="break-words text-xs font-semibold text-slate-800 dark:text-slate-100">{st.title}</p>
                  {st.lines.filter(Boolean).map((l, j) => (
                    <p key={j} className="break-words text-[11px] leading-snug text-slate-500 dark:text-slate-400">{l}</p>
                  ))}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {ending && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-navy-700 dark:bg-navy-800 dark:text-slate-300">
          <ending.Icon size={14} className="mt-px shrink-0" aria-hidden="true" />
          <span><b className="font-semibold">{issueStatusLabel(issue.status)}.</b> {ending.text}</span>
        </div>
      )}
    </div>
  );
}
