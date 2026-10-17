import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, ShieldCheck, TriangleAlert, X } from "lucide-react";
import Glyph from "../Glyph.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { parseServerTime } from "../../lib/format.js";

// Shared pieces of the Email & Notifications screens (/email/…): the admin
// gate, the page header, the mail-status badge, the recipient picker and the
// "mail server is not configured" strip. One definition, so the nine screens
// read as one module.

/**
 * Every screen of this module is admin-only. The server enforces it on each
 * route; this keeps a non-admin from landing on a page full of failed calls —
 * the children (and their queries) are not mounted at all.
 */
export function AdminOnly({ children }) {
  const { user } = useAuth();
  if (!user?.is_admin) {
    return (
      <div className="card max-w-lg mx-auto mt-10 text-center">
        <ShieldCheck size={28} className="mx-auto text-slate-300 mb-2" aria-hidden="true" />
        <p className="text-sm text-slate-500 dark:text-slate-400">This page is for administrators only.</p>
      </div>
    );
  }
  return children;
}

/** Page header: title with its icon, a one-line hint, and the actions on the right. */
export function PageHead({ icon, title, hint, children }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="section-title flex items-center gap-2">
          <Glyph icon={icon} size={20} /> {title}
        </h1>
        {hint && <p className="mt-0.5 max-w-3xl text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

// Status -> [label, classes]. PARTIAL has no .badge-* of its own (orange sits
// between "sent" and "failed": delivered, but the server refused someone).
const MAIL_STATUS = {
  QUEUED: ["Queued", "badge-warning"],
  SENDING: ["Sending", "badge-info"],
  SENT: ["Sent", "badge-success"],
  PARTIAL: ["Partial", "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300"],
  FAILED: ["Failed", "badge-danger"],
  CANCELLED: ["Cancelled", "badge-neutral"],
  SKIPPED: ["Skipped", "badge-neutral"],
};

export function MailStatusBadge({ status }) {
  if (!status) return <span className="text-slate-400">—</span>;
  const [label, tone] = MAIL_STATUS[String(status).toUpperCase()] || [status, "badge-neutral"];
  return <span className={`badge ${tone}`}>{label}</span>;
}

export const MAIL_TYPE_LABEL = {
  reorder: "Reorder list",
  window_time: "Window-time sheet",
  smtp_test: "Test mail",
  manual_alert: "Manual alert",
  excess_list: "Excess parts list",
  stock_report: "Daily stock report",
  tracker_digest: "Action Tracker summary",
  tracker_reminder: "Reminder",
  tracker_escalation: "Escalation",
  short_rejection: "Short & Rejection list",
};

// A mail type the app no longer sends but the log can still hold: the critical
// parts digest was dropped on 13 Oct 2026. It is named here so that an old mail
// reads in words — not in the list above, which holds what can be sent today.
const RETIRED_MAIL_TYPE_LABEL = { critical_digest: "Critical parts digest" };

export const mailTypeLabel = (t) => MAIL_TYPE_LABEL[t] || RETIRED_MAIL_TYPE_LABEL[t] || t || "—";

/**
 * A server timestamp as "12 Oct 2026, 17:05" in the plant's clock. The server
 * sends zone-less UTC, so it goes through parseServerTime — never new Date(str).
 * A calendar date ("2026-10-05", e.g. a target date) carries no clock time and
 * is shown as the day alone.
 */
export const fmtWhen = (iso) => {
  if (!iso) return "—";
  const s = String(iso).trim();
  // Local midnight, so a plain date can never slip to the day before or after.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : parseServerTime(s);
  if (!d || Number.isNaN(d.getTime())) return "—";
  return s.length <= 10
    ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** The amber strip shown while no mail server is set up. Renders nothing once it is. */
export function SmtpBanner({ smtp }) {
  // Not loaded (or the status call failed) is not the same as "not configured":
  // say nothing rather than warn about something we do not know.
  if (!smtp || smtp.configured) return null;
  return (
    <div role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
      <TriangleAlert size={16} className="shrink-0" aria-hidden="true" />
      <span className="font-medium">Mail server is not configured — nothing can be sent yet.</span>
      <Link to="/email/configuration" className="font-semibold underline underline-offset-2 hover:text-toyotared">
        Open Email Configuration
      </Link>
    </div>
  );
}

const ROLES = [["TO", "To"], ["CC", "Cc"], ["BCC", "Bcc"]];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const roleOf = (r) => (ROLES.some(([k]) => k === String(r || "").toUpperCase()) ? String(r).toUpperCase() : "TO");

function RoleSelect({ value, onChange, disabled, label }) {
  return (
    <select value={roleOf(value)} disabled={disabled} aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      className="input-field w-auto shrink-0 py-1.5 font-semibold disabled:cursor-not-allowed disabled:opacity-60">
      {ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
    </select>
  );
}

/**
 * Who a mail goes to: tick whole departments (their people come from the
 * Department Emails master, each in the To / Cc / Bcc role set there) and add
 * extra addresses with a role of their own.
 *
 *   onChange({ departmentIds, emails })   // emails: [{ email, role: "TO" | "CC" | "BCC" }]
 */
export function RecipientPicker({ departments, departmentIds, emails, onChange, disabled }) {
  const depts = departments || [];
  const ids = departmentIds || [];
  const extra = emails || [];
  const [draft, setDraft] = useState({ email: "", role: "TO" });
  const [err, setErr] = useState(null);

  const emit = (patch) => onChange({ departmentIds: ids, emails: extra, ...patch });

  const toggleDept = (id) =>
    emit({ departmentIds: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] });

  const addEmail = () => {
    const email = draft.email.trim();
    if (!email) { setErr("Type an e-mail address first."); return; }
    if (!EMAIL_RE.test(email)) { setErr("Enter a full e-mail address, e.g. name@toyota-boshoku.com."); return; }
    if (extra.some((x) => (x.email || "").toLowerCase() === email.toLowerCase())) {
      setErr(`${email} is already on the list.`);
      return;
    }
    emit({ emails: [...extra, { email, role: roleOf(draft.role) }] });
    setDraft({ email: "", role: draft.role });
    setErr(null);
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300">Departments</p>
        {depts.length === 0 ? (
          <p className="text-xs text-slate-400">No departments to pick from — add them under Department Emails.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {depts.map((d) => {
              // Only a person with an address can be mailed; a name alone is skipped.
              const people = (d.recipients || []).filter((r) => (r.email || "").trim()).length;
              const on = ids.includes(d.id);
              return (
                <label key={d.id}
                  className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${on
                    ? "border-toyotared/50 bg-toyotared/[0.04] dark:border-toyotared/60 dark:bg-toyotared/10"
                    : "border-slate-200 dark:border-navy-700"}`}>
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-toyotared" checked={on} disabled={disabled}
                    onChange={() => toggleDept(d.id)} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-800 dark:text-white">
                      {d.name}
                      {d.is_active === false && <span className="ml-1.5 text-[11px] font-normal text-slate-400">(inactive)</span>}
                    </span>
                    <span className={`block text-[11px] ${people ? "text-slate-500 dark:text-slate-400" : "text-amber-600 dark:text-amber-400"}`}>
                      {people ? `${people} ${people === 1 ? "person" : "people"} with an address` : "No one with an address yet"}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <p className="mb-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300">Extra addresses</p>
        {extra.length > 0 && (
          <ul className="mb-2 space-y-1.5">
            {extra.map((x, i) => (
              <li key={`${x.email}-${i}`} className="flex items-center gap-2">
                <RoleSelect value={x.role} disabled={disabled} label={`Role of ${x.email}`}
                  onChange={(role) => emit({ emails: extra.map((y, j) => (j === i ? { ...y, role } : y)) })} />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">{x.email}</span>
                <button type="button" disabled={disabled} aria-label={`Remove ${x.email}`}
                  onClick={() => emit({ emails: extra.filter((_, j) => j !== i) })}
                  className="shrink-0 rounded p-1 text-slate-400 hover:text-rose-500 disabled:cursor-not-allowed disabled:opacity-60">
                  <X size={15} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <RoleSelect value={draft.role} disabled={disabled} label="Role of the new address"
            onChange={(role) => setDraft({ ...draft, role })} />
          <input type="email" className="input-field min-w-[12rem] flex-1 py-1.5 disabled:cursor-not-allowed disabled:opacity-60"
            placeholder="name@toyota-boshoku.com" aria-label="Extra e-mail address"
            value={draft.email} disabled={disabled}
            onChange={(e) => { setDraft({ ...draft, email: e.target.value }); setErr(null); }}
            // Enter adds the address; it must not submit a form the picker sits in.
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEmail(); } }} />
          <button type="button" className="btn-secondary !py-1.5" onClick={addEmail} disabled={disabled}>
            <Plus size={15} aria-hidden="true" /> Add
          </button>
        </div>
        {err && <p className="mt-1.5 text-xs text-rose-600 dark:text-rose-400">{err}</p>}
      </div>
    </div>
  );
}
