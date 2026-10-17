import React, { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { AlarmClock, ArrowRight, Download, IndianRupee, ListChecks, MapPin, Pencil, Siren, Wallet } from "lucide-react";
import CardHead from "../../components/CardHead.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import KpiCard from "../../components/KpiCard.jsx";
import Modal from "../../components/Modal.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { invalidateStock, useSpareManagement } from "../../lib/stockQueries.js";
import { compactMoney, fmtStamp, money, num, parseServerTime } from "../../lib/format.js";
import { managementService } from "../../services/managementService.js";
import { downloadXlsx } from "../../utils/excel.js";

// The Spare Parts Store's action tracker: every open issue of the store on one
// page — what is wrong, how much money, who must act and by when. The lines and
// their figures come from the server (/dashboard/spare/management → tracker);
// an administrator adds the owner, the target date and remarks.
const STORE_CODE = "MAINTENANCE";

const SEV_ORDER = { critical: 0, warning: 1, info: 2, ok: 3 };
const SEVERITY = {
  critical: { rail: "bg-rose-600", count: "text-rose-700 dark:text-rose-300" },
  warning: { rail: "bg-amber-500", count: "text-amber-700 dark:text-amber-300" },
  info: { rail: "bg-blue-500", count: "text-blue-700 dark:text-blue-300" },
  ok: { rail: "bg-emerald-500", count: "text-slate-400 dark:text-slate-500" },
};

// A CLEAR line goes last whatever severity it carries: "nothing wrong here" is
// still an answer, but it must not sit above a live issue.
const rank = (it) => (it.status === "CLEAR" ? SEV_ORDER.ok : SEV_ORDER[it.severity] ?? SEV_ORDER.info);

const PILL = {
  OVERDUE: "bg-rose-600 text-white dark:bg-rose-500",
  OPEN: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  OPEN_CRITICAL: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
  CLEAR: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  UNKNOWN: "bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-slate-400",
};
// An open line past its target date reads OVERDUE — on screen and in the export.
const statusOf = (it) => (it.overdue ? "OVERDUE" : it.status || "UNKNOWN");
const pillTone = (it) => {
  const status = statusOf(it);
  if (status === "OPEN" && it.severity === "critical") return PILL.OPEN_CRITICAL;
  return PILL[status] || PILL.UNKNOWN;
};

// "Overdue 3 d" / "in 12 d". Nothing for a target that has passed on a line
// that is no longer open — the date alone says it.
const targetHint = (it) => {
  const d = it.days_to_target;
  if (it.overdue) return d == null ? "Overdue" : `Overdue ${Math.abs(d)} d`;
  if (d == null || d < 0) return null;
  return d === 0 ? "Due today" : `in ${d} d`;
};

// generated_at is a server UTC stamp; parseServerTime keeps it right should the
// zone ever be dropped.
const fmtTime = (iso) => {
  const d = iso ? parseServerTime(iso) : null;
  return d ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;
};

// target_date and as_of are plant calendar dates ("YYYY-MM-DD"), not instants.
// They are read and printed in UTC, so the viewer's own time zone can never
// move one to the day before — the rule the dashboard's board prints its
// targets by.
const fmtPlantDate = (ymd) => {
  if (!ymd) return "—";
  const d = new Date(`${ymd}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? ymd
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
};

const EXPORT_HEADERS = ["Issue", "Detail", "Count", "Value (₹)", "Action needed", "Action by", "Target date", "Status", "Remarks"];

// One column template for the header row and every line, so the columns line up
// down the page. The two trailing tracks are fixed widths because each line is
// its own grid: an `auto` track would size per line and shift the columns.
const COLS = "xl:grid-cols-[minmax(0,2.2fr)_minmax(0,0.8fr)_minmax(0,1.05fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,1.05fr)_5.5rem_7rem]";
// Five tiles across only from xl: with the side rail open, an lg screen leaves
// the page under 1000px and a ₹ figure would be cut off in a fifth of that.
const TILES = "grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5";
const COL_LABEL = "text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500";
const ROW_BTN = "inline-flex h-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition-colors hover:border-toyotared hover:text-toyotared focus:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/50 dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300";
const dash = <span className="text-sm text-slate-300 dark:text-slate-600">—</span>;

// Below xl a line stacks (two cells across, four from md), and the header row
// is hidden — so each cell prints its own column label there. order-3 keeps the
// cells after the issue (1) and its section chips (2) on a stacked line.
function Cell({ label, children }) {
  return (
    <div className="order-3 min-w-0">
      <div className={`${COL_LABEL} mb-1 xl:hidden`}>{label}</div>
      {children}
    </div>
  );
}

// Owner / target date / remarks of one line — an administrator's edit. Mounted
// only while a line is being edited, so the form always starts from that line.
function EditDialog({ item, onClose }) {
  const qc = useQueryClient();
  // An unassigned line shows the default owner as the placeholder, not as a
  // value: saving it back would turn the default into an assignment.
  const saved = {
    owner: item.owner_is_default ? "" : item.owner || "",
    target_date: item.target_date || "",
    remarks: item.remarks || "",
  };
  const [form, setForm] = useState(saved);
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const next = { owner: form.owner.trim(), target_date: form.target_date, remarks: form.remarks.trim() };
  const changed = next.owner !== saved.owner || next.target_date !== saved.target_date || next.remarks !== saved.remarks;

  const save = async () => {
    setSaving(true);
    try {
      await managementService.saveTrackerItem(STORE_CODE, item.key,
        { owner: next.owner, target_date: next.target_date || null, remarks: next.remarks });
      toast.success("Action tracker updated");
      // Under "stock": this page and the dashboard refetch; the server's own
      // "stock" push does the same for every other screen and the wall board.
      invalidateStock(qc);
      onClose();
    } catch { /* the api interceptor toasts the server's message */ } finally {
      setSaving(false);
    }
  };

  const label = "block text-sm font-medium text-slate-600 dark:text-slate-300";
  const hint = "mt-1 block text-xs font-normal text-slate-400";
  return (
    <Modal open onClose={onClose} title={`Edit — ${item.label}`}
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary disabled:opacity-40" onClick={save} disabled={!changed || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      )}>
      <div className="space-y-4">
        {item.action && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Action needed: <b className="font-semibold text-slate-700 dark:text-slate-200">{item.action}</b>
          </p>
        )}
        <label className={label}>Action by (owner)
          <input className="input-field mt-1" value={form.owner} onChange={set("owner")} maxLength={60} disabled={saving}
            placeholder={item.owner_is_default && item.owner ? item.owner : "Default owner"} />
          <span className={hint}>Leave empty to use the default</span>
        </label>
        <div>
          <label htmlFor="tracker-target" className={label}>Target date</label>
          <div className="mt-1 flex items-center gap-2">
            <input id="tracker-target" type="date" className="input-field" value={form.target_date}
              onChange={set("target_date")} disabled={saving} />
            {form.target_date && (
              <button type="button" className="btn-secondary shrink-0" disabled={saving}
                onClick={() => setForm({ ...form, target_date: "" })}>
                Clear
              </button>
            )}
          </div>
        </div>
        <label className={label}>Remarks
          <textarea className="input-field mt-1 resize-none" rows={3} value={form.remarks} onChange={set("remarks")}
            maxLength={200} disabled={saving} />
          <span className={`${hint} tabular`}>{form.remarks.length} / 200</span>
        </label>
        {item.updated_by && (
          <p className="text-xs text-slate-400">Last saved by {item.updated_by} · {fmtStamp(item.updated_at)}</p>
        )}
      </div>
    </Modal>
  );
}

function TrackerLine({ it, canEdit, onOpen, onEdit }) {
  const sev = SEVERITY[it.status === "CLEAR" ? "ok" : it.severity] || SEVERITY.info;
  const hint = targetHint(it);
  const sections = it.sections || [];
  return (
    <li className={`relative ${it.status === "CLEAR" ? "opacity-60" : ""}`}>
      <span className={`absolute left-0 top-0 h-full w-1 rounded-r-full ${sev.rail}`} aria-hidden="true" />
      <div className={`grid grid-cols-2 items-start gap-x-4 gap-y-3 px-5 py-4 md:grid-cols-4 xl:items-center xl:gap-3 ${COLS}`}>
        <div className="order-1 col-span-full min-w-0 xl:col-span-1">
          <div className="break-words text-[15px] font-semibold leading-snug text-slate-800 dark:text-white">{it.label}</div>
          {it.detail && <div className="mt-0.5 break-words text-[13px] text-slate-500 dark:text-slate-400">{it.detail}</div>}
        </div>

        {/* WHERE — right under the issue on a stacked line; on the wide table a
            row of its own beneath the columns, because three chips stacked in
            the narrow Issue column would double the height of every line. */}
        {sections.length > 0 && (
          <div className="order-2 col-span-full flex flex-wrap gap-1 xl:order-last xl:-mt-1">
            {sections.map((s) => (
              <span key={s.section_id ?? "none"}
                className="inline-flex items-center gap-1 rounded border border-slate-200/70 bg-white px-1.5 py-0.5 text-xs text-slate-600 dark:border-navy-700 dark:bg-navy-900 dark:text-slate-300">
                <MapPin size={11} className="text-slate-400" aria-hidden="true" />
                {s.name} <b className="tabular text-slate-800 dark:text-white">{num(s.count)}</b>
              </span>
            ))}
          </div>
        )}

        <Cell label="Count">
          <span className={`text-xl font-bold leading-none tabular ${sev.count}`}>{num(it.count)}</span>
        </Cell>

        <Cell label="₹ at stake">
          {it.value == null ? dash : (
            <>
              <div className="text-[15px] font-bold tabular text-slate-900 dark:text-white" title={money(it.value)}>
                {compactMoney(it.value)}
              </div>
              {it.value_label && <div className="text-xs text-slate-400 dark:text-slate-500">{it.value_label}</div>}
            </>
          )}
        </Cell>

        <Cell label="Action needed">
          {it.action ? <span className="break-words text-sm text-slate-700 dark:text-slate-200">{it.action}</span> : dash}
        </Cell>

        <Cell label="Action by">
          {it.owner ? (
            <span title={it.owner_is_default ? "Default — not yet assigned" : undefined}
              className={`break-words text-sm ${it.owner_is_default
                ? "italic text-slate-500 dark:text-slate-400"
                : "font-semibold text-slate-800 dark:text-white"}`}>
              {it.owner}
            </span>
          ) : dash}
        </Cell>

        <Cell label="Target">
          {it.target_date ? (
            <>
              <div className="whitespace-nowrap text-sm font-medium tabular text-slate-800 dark:text-white">{fmtPlantDate(it.target_date)}</div>
              {hint && (
                <div className={`text-xs ${it.overdue ? "font-semibold text-rose-600 dark:text-rose-400" : "text-slate-400 dark:text-slate-500"}`}>
                  {hint}
                </div>
              )}
            </>
          ) : dash}
        </Cell>

        <Cell label="Status">
          <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-bold tracking-wide ${pillTone(it)}`}>
            {statusOf(it)}
          </span>
        </Cell>

        {/* The last column, so leaving it out (no link, not an administrator)
            moves no other. */}
        {(it.link || canEdit) && (
          <div className="order-3 col-span-2 flex items-center gap-1.5 xl:col-span-1 xl:justify-end">
            {it.link && (
              <button type="button" onClick={() => onOpen(it.link)} title={it.link.label} aria-label={`${it.link.label} — ${it.label}`}
                className={`${ROW_BTN} gap-1 px-2.5 text-[13px] font-semibold`}>
                Open <ArrowRight size={13} aria-hidden="true" />
              </button>
            )}
            {canEdit && (
              <button type="button" onClick={() => onEdit(it)} title="Edit owner, target date and remarks"
                aria-label={`Edit owner, target date and remarks — ${it.label}`}
                className={`${ROW_BTN} w-8`}>
                <Pencil size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>
      {it.remarks && (
        <p className="-mt-1.5 break-words px-5 pb-3.5 text-[13px] text-slate-500 dark:text-slate-400">
          <span className="font-semibold text-slate-600 dark:text-slate-300">Remarks:</span> {it.remarks}
        </p>
      )}
    </li>
  );
}

function TrackerSkeleton() {
  return (
    <div className="card space-y-3" aria-busy="true">
      <div className="skeleton h-4 w-56" />
      {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-14 w-full" />)}
    </div>
  );
}

export default function ActionTracker() {
  const navigate = useNavigate();
  const { stores } = useStores();
  const sections = useMemo(
    () => (stores.find((s) => s.code === STORE_CODE)?.sections || []).filter((s) => s.is_active),
    [stores]);
  // "" = the whole store; otherwise one section's id as the <select> holds it.
  const [pick, setPick] = useState("");
  const section = sections.find((s) => String(s.id) === pick) || null;
  const { data, isPending, error, refetch } = useSpareManagement(STORE_CODE, section ? section.id : null);
  const tracker = data?.tracker;
  const [editing, setEditing] = useState(null);   // the line whose owner / target is being edited
  // One handler for the life of the page: the dialog re-takes keyboard focus
  // whenever its onClose changes, and this page re-renders on every refetch
  // (each realtime stock push) — a fresh closure would pull the cursor out of
  // the field the administrator is typing in.
  const closeEdit = useCallback(() => setEditing(null), []);

  // Worst first; the sort is stable, so the server's order holds inside a severity.
  const rows = useMemo(() => [...(tracker?.items || [])].sort((a, b) => rank(a) - rank(b)), [tracker]);

  const openLink = (link) => navigate(link.status ? `${link.to}?status=${encodeURIComponent(link.status)}` : link.to);

  // The lines as listed, with the exact rupee and the status the page shows.
  const exportRows = () => downloadXlsx(
    `action_tracker_${(section?.name || "all sections").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}_${data.as_of}`,
    EXPORT_HEADERS,
    rows.map((it) => [
      it.label, it.detail || "", it.count ?? "", it.value ?? "", it.action || "", it.owner || "",
      it.target_date ? fmtPlantDate(it.target_date) : "", statusOf(it), it.remarks || "",
    ]),
    "Action Tracker");

  const updated = fmtTime(data?.generated_at);
  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-xl font-bold text-slate-800 dark:text-white">Action Tracker</h2>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          What is wrong, how much money, who must act and by when — worst first
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {updated && <span className="text-xs text-slate-400">Updated {updated}</span>}
        <select value={section ? pick : ""} onChange={(e) => setPick(e.target.value)} aria-label="Section"
          className="input-field w-auto min-w-[12rem]">
          <option value="">All sections</option>
          {sections.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
        </select>
        <button type="button" className="btn-secondary disabled:opacity-40" onClick={exportRows} disabled={!rows.length}>
          <Download size={16} aria-hidden="true" /> Export
        </button>
      </div>
    </div>
  );

  // No tracker to show: still loading, or the call failed with nothing held
  // from before. Either way no tile and no line is drawn — never a 0 that is
  // really "not loaded".
  if (!tracker) {
    return (
      <div className="space-y-6">
        {header}
        {isPending ? (
          <>
            <div className={TILES}>
              {Array.from({ length: 5 }).map((_, i) => <KpiCard key={i} loading />)}
            </div>
            <TrackerSkeleton />
          </>
        ) : (
          <div className="card">
            <ErrorState title="Could not load the action tracker"
              message={error?.response?.data?.message || "The server did not answer, so no figure is shown."}
              onRetry={() => refetch()} />
          </div>
        )}
      </div>
    );
  }

  const s = tracker.summary || {};
  const canEdit = Boolean(tracker.can_edit);
  return (
    <div className="space-y-6">
      {header}

      <div className={TILES}>
        <KpiCard tone="navy" icon={ListChecks} label="Open" value={s.open ?? "—"}
          hint={s.clear == null ? undefined : `${num(s.clear)} line${s.clear === 1 ? "" : "s"} clear`} />
        <KpiCard tone={s.overdue ? "red" : "navy"} icon={AlarmClock} label="Overdue" value={s.overdue ?? "—"}
          priority={Boolean(s.overdue)} hint="Past the target date" />
        <KpiCard tone={s.critical_parts ? "red" : "navy"} icon={Siren} label="Critical parts" value={s.critical_parts ?? "—"}
          hint="Zero + below minimum" />
        <KpiCard tone="amber" icon={IndianRupee} label="To restock" value={compactMoney(s.to_restock)}
          valueTitle={s.to_restock == null ? undefined : money(s.to_restock)} hint="Critical + reorder, to max" />
        <KpiCard tone="blue" icon={Wallet} label="Tied up" value={compactMoney(s.tied_up)}
          valueTitle={s.tied_up == null ? undefined : money(s.tied_up)} hint="Stock above maximum" />
      </div>

      <section className="card !p-0 overflow-hidden" aria-label="Action tracker">
        <div className="px-5 pt-5">
          <CardHead icon={ListChecks} tone="navy" title="Summary of issues · owner · target"
            hint={`${num(rows.length)} line${rows.length === 1 ? "" : "s"} · as of ${fmtPlantDate(data.as_of)}${section ? ` · ${section.name}` : ""}`} />
        </div>

        {/* Column header (xl+) — the alignment key for the lines below */}
        <div className={`hidden gap-3 border-y border-slate-100 px-5 py-2.5 dark:border-navy-800 xl:grid xl:items-center ${COL_LABEL} ${COLS}`}>
          <span>Issue</span>
          <span>Count</span>
          <span>₹ at stake</span>
          <span>Action needed</span>
          <span>Action by</span>
          <span>Target</span>
          <span>Status</span>
          <span className="sr-only">Open / edit</span>
        </div>

        {rows.length ? (
          <ul className="divide-y divide-slate-100 border-t border-slate-100 dark:divide-navy-800 dark:border-navy-800 xl:border-t-0">
            {rows.map((it) => (
              <TrackerLine key={it.key} it={it} canEdit={canEdit} onOpen={openLink} onEdit={setEditing} />
            ))}
          </ul>
        ) : (
          <p className="px-5 py-10 text-center text-sm text-slate-500 dark:text-slate-400">No tracker lines for this scope.</p>
        )}

        <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-400 dark:border-navy-800">
          {canEdit
            ? "Use the pencil on a line to assign its owner, target date and remarks."
            : "Only an administrator can assign owners and targets."}
          {section && " Lines that exist only for the whole store are listed under All sections."}
        </p>
      </section>

      {editing && <EditDialog key={editing.key} item={editing} onClose={closeEdit} />}
    </div>
  );
}
