import React, { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { AlertTriangle, ChevronRight, Hammer, Link2, Search, Unlink } from "lucide-react";
import Modal from "../../components/Modal.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import { useCan } from "../../components/Can.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { fmtDate, fmtStamp, num } from "../../lib/format.js";
import { jobWorkService } from "../../services/jobWorkService.js";

// Job Work & RGP — the store's spec of 27 Oct 2026 ("Part Return, Job Work
// Return & Pending RGP Integration"). A user brings a worn / damaged part back
// for job work (Scan Part -> Return -> Job work): it comes into the main
// store's stock, as ERP's return slip does, and waits as Pending RGP. Another
// store employee makes the challan in ERP — a "General
// FOC" returnable challan, made from the issue slip in the vendor's name — the
// app reads those of the spare parts (read only — it never makes one) and links
// each waiting return to its challan by itself; a store person can unlink a
// wrong one and pick another here (27 Oct 2026).
//
//   Returns       each job work return: Pending RGP · RGP available – pending
//                 match · RGP linked · API sync failed
//   ERP challans  RGP status (12 Nov 2026: every RGP made from an issue slip
//                 for a spare part, any party — when, parts, qty, back,
//                 pending, days), and the challan lines as last read from ERP

const TABS = [{ key: "returns", label: "Job work returns" }, { key: "rgp", label: "ERP challans" }];

// What a challan did to store stock (JobWorkService.STOCK_STATES, 28 Oct 2026):
// a new part sent from stock goes out of it; a used part, a challan with no
// issue slip, or one the part's count already holds moves nothing.
const STOCK_PILL = {
  OUT: "badge-info", WILL_OUT: "badge-info", SHORT: "badge-danger",
  NO_SLIP: "badge-neutral", NOT_COUNTED: "badge-warning", BEFORE_COUNT: "badge-neutral", BEFORE_FROM: "badge-neutral",
  OFF: "badge-warning", CANCELLED: "badge-neutral", NOT_IN_MASTER: "badge-neutral",
};
const STATES = [
  { key: "", label: "All" },
  { key: "PENDING_RGP", label: "Pending RGP" },
  { key: "RGP_AVAILABLE", label: "RGP available – match" },
  { key: "RGP_LINKED", label: "RGP linked" },
  { key: "SYNC_FAILED", label: "API sync failed" },
];
const PILL = {
  PENDING_RGP: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",
  RGP_AVAILABLE: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200",
  RGP_LINKED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  SYNC_FAILED: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
};
const errText = (e) => e?.response?.data?.message || e?.message || "Something went wrong";
const TH = ({ children, right }) => <th className={`whitespace-nowrap px-3 py-2.5 font-semibold ${right ? "text-right" : ""}`}>{children}</th>;

function useDebounced(text, ms = 300) {
  const [v, setV] = useState(text);
  useEffect(() => { const t = setTimeout(() => setV(text.trim()), ms); return () => clearTimeout(t); }, [text, ms]);
  return v;
}

function SearchBox({ value, onChange, placeholder }) {
  return (
    <span className="relative">
      <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
      <input className="input-field w-72 py-1.5 pl-8 text-[13px]" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </span>
  );
}

// When ERP was last read (by itself, with the ERP read every 2 minutes), and
// whether the last try failed.
function SyncBar({ sync }) {
  if (!sync) return null;
  return (
    <div className={`card flex flex-wrap items-center justify-between gap-3 py-3 text-[12.5px] ${sync.ok === false ? "border-rose-200 dark:border-rose-500/30" : ""}`}>
      <div className="space-y-0.5">
        <p className="text-slate-700 dark:text-slate-200">
          ERP returnable challans (General FOC) of spare parts: <b>{num(sync.lines)}</b> lines read · <b>{num(sync.linked)}</b> linked to returns
          {sync.newest_rgp && <> · newest challan in ERP {fmtDate(sync.newest_rgp)}</>}
        </p>
        <p className="text-slate-500">
          Last good read: {sync.last_ok_at ? fmtStamp(sync.last_ok_at) : "never"}
          {sync.ok === false && <span className="ml-2 inline-flex items-center gap-1 font-semibold text-rose-600"><AlertTriangle size={12} aria-hidden="true" />Last read failed {fmtStamp(sync.last_error_at)}: {sync.last_error}</span>}
        </p>
      </div>
    </div>
  );
}

export default function JobWork() {
  const { activeCode } = useStores();
  const [tab, setTab] = useState("returns");
  return (
    <div className="space-y-5">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-lg font-bold text-slate-800 dark:text-white"><Hammer size={20} aria-hidden="true" /> Job Work &amp; RGP</h2>
        <p className="mt-0.5 text-xs text-slate-400">
          As in ERP: a part brought back for job work comes into the main store's stock (the return slip) and waits here until the returnable challan made in ERP from the issue slip is linked — the app links it by itself.
          Every challan with an issue slip — a used part or a new one — takes the part out of store stock, and the vendor's GRN brings it back. The app only reads ERP — it never makes a challan.
          A job work return is made on Scan Part → Return → Job work.
        </p>
      </div>
      <div role="tablist" aria-label="Job work" className="inline-grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-navy-800 dark:bg-navy-900">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${tab === t.key ? "bg-toyotared text-white shadow-sm" : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-navy-800"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "returns" ? <ReturnsTab storeCode={activeCode} /> : <RgpTab />}
    </div>
  );
}

function ReturnsTab({ storeCode }) {
  const qc = useQueryClient();
  const canLink = useCan("scan_part", "update");
  const [state, setState] = useState("");
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed);
  const [linking, setLinking] = useState(null);
  const list = useQuery({
    queryKey: ["job-work", "returns", storeCode, state, q],
    queryFn: () => jobWorkService.returns({ store_code: storeCode, state: state || undefined, q: q || undefined }, { silent: true }).then((r) => r.data.data),
    enabled: Boolean(storeCode),
    placeholderData: keepPreviousData,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["job-work"] });
  const unlink = async (r) => {
    try {
      const res = await jobWorkService.unlink(r.id);
      toast.success(res.data.message);
      refresh();
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const d = list.data;
  return (
    <div className="space-y-3">
      <SyncBar sync={d?.sync} />
      <div className="card p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-navy-800">
          <div className="flex flex-wrap gap-1">
            {STATES.map((s) => (
              <button key={s.key} type="button" onClick={() => setState(s.key)} aria-pressed={state === s.key}
                className={`rounded-full px-3 py-1 text-[12px] font-semibold ${state === s.key ? "bg-navy-900 text-white dark:bg-white dark:text-navy-900" : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"}`}>
                {s.label}{s.key && d?.counts ? ` · ${d.counts[s.key] ?? 0}` : ""}
              </button>
            ))}
          </div>
          <SearchBox value={typed} onChange={setTyped} placeholder="Part, return no., person, department…" />
        </div>
        {list.isError ? <div className="p-4"><ErrorState title="Job work returns did not load" message={errText(list.error)} onRetry={() => list.refetch()} /></div> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-[12.5px]">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
                <tr><TH>Returned</TH><TH>Part</TH><TH right>Qty</TH><TH>Job work reason</TH><TH>Department · By</TH><TH>Original issue</TH><TH>RGP</TH><TH /></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                {(d?.rows || []).map((r) => (
                  <tr key={r.id} className="align-top text-slate-700 dark:text-slate-200">
                    <td className="whitespace-nowrap px-3 py-2.5"><div>{fmtStamp(r.created_at)}</div><div className="text-[11px] text-slate-400">{r.return_no}{r.identified_by ? ` · ${r.identified_by === "QR" ? "QR scan" : "manual"}` : ""}</div></td>
                    <td className="px-3 py-2.5"><div className="font-mono font-semibold">{r.part_no}</div><div className="max-w-[220px] truncate text-[11px] text-slate-400" title={r.part_name}>{r.part_name}</div></td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular">{num(r.qty)} {r.uom}</td>
                    <td className="px-3 py-2.5">{r.reason}{r.remarks && <div className="max-w-[180px] truncate text-[11px] text-slate-400" title={r.remarks}>{r.remarks}</div>}</td>
                    <td className="px-3 py-2.5"><div>{r.department || "—"}</div><div className="text-[11px] text-slate-400">{r.returned_by || "—"}</div></td>
                    <td className="whitespace-nowrap px-3 py-2.5"><div>{r.issue_date ? fmtDate(r.issue_date) : "—"}</div><div className="text-[11px] text-slate-400">#{r.issue_id} · {num(r.issued_qty)} issued</div></td>
                    <td className="px-3 py-2.5">
                      <span className={`badge ${PILL[r.state]}`}>{r.state_label}{r.state === "RGP_AVAILABLE" ? ` (${r.suggested})` : ""}</span>
                      {r.link && <div className="mt-1 text-[11px] text-slate-500"><b className="font-mono text-slate-700 dark:text-slate-200">{r.link.rgp.challan_no}</b> · {fmtDate(r.link.rgp.challan_date)} · {r.link.rgp.party_name}<br />linked by {r.link.linked_by} {fmtStamp(r.link.linked_at)}</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      {canLink && (r.link ? (
                        <button type="button" className="text-[11px] text-slate-500 hover:underline" onClick={() => unlink(r)}>
                          <Unlink size={11} aria-hidden="true" className="mr-1 inline" />Unlink
                        </button>
                      ) : (
                        <button type="button" className="btn-primary py-1 text-[12px]" onClick={() => setLinking(r)}>
                          <Link2 size={13} aria-hidden="true" /> Link RGP
                        </button>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d && d.rows.length === 0 && <p className="px-4 py-8 text-center text-sm text-slate-400">{q || state ? "No job work return matches." : "No job work return yet — make one on Scan Part → Return → Job work."}</p>}
          </div>
        )}
      </div>
      {linking && <LinkDialog ret={linking} onClose={() => setLinking(null)} onLinked={() => { setLinking(null); refresh(); }} />}
    </div>
  );
}

function LinkDialog({ ret, onClose, onLinked }) {
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed);
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);
  const cand = useQuery({
    queryKey: ["job-work", "candidates", ret.id, q],
    queryFn: () => jobWorkService.candidates(ret.id, q, { silent: true }).then((r) => r.data.data),
    placeholderData: keepPreviousData,
  });
  const save = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      const r = await jobWorkService.link(ret.id, picked.id);
      toast.success(r.data.message);
      onLinked();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const Row = ({ l, hint }) => (
    <button type="button" onClick={() => setPicked(l)} aria-pressed={picked?.id === l.id}
      className={`flex w-full items-start justify-between gap-3 border-b border-slate-100 px-3 py-2 text-left text-[12.5px] last:border-0 dark:border-navy-800 ${picked?.id === l.id ? "bg-toyotared/5 ring-1 ring-inset ring-toyotared" : "hover:bg-slate-50 dark:hover:bg-navy-800"}`}>
      <span className="min-w-0">
        <span className="block font-mono font-semibold text-slate-800 dark:text-white">{l.challan_no} <span className="font-sans text-[11px] font-normal text-slate-400">{fmtDate(l.challan_date)} · {l.status}</span></span>
        <span className="block truncate text-slate-600 dark:text-slate-300">{l.item_cd} — {l.item_desc}</span>
        <span className="block text-[11px] text-slate-400">{l.party_name}</span>
      </span>
      <span className="shrink-0 text-right">
        <b className="tabular">{num(l.qty)} {l.uom}</b>
        {hint && <span className={`mt-0.5 block text-[10.5px] ${l.qty_matches ? "text-emerald-700" : "text-amber-700"}`}>{l.qty_matches ? "qty matches" : "qty differs"}</span>}
      </span>
    </button>
  );
  const c = cand.data;
  return (
    <Modal open onClose={onClose} size="xl" title={`Link the RGP — ${ret.return_no}`}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        <button type="button" className="btn-primary" onClick={save} disabled={!picked || busy}>
          <Link2 size={15} aria-hidden="true" /> {busy ? "Linking…" : picked ? `Link ${picked.challan_no}` : "Pick an RGP"}
        </button>
      </>}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3 text-[12.5px] dark:bg-navy-950/40 sm:grid-cols-4">
          <div><p className="text-[11px] font-semibold uppercase text-slate-400">Part</p><p className="font-mono font-semibold">{ret.part_no}</p></div>
          <div><p className="text-[11px] font-semibold uppercase text-slate-400">Qty</p><p className="font-semibold">{num(ret.qty)} {ret.uom}</p></div>
          <div><p className="text-[11px] font-semibold uppercase text-slate-400">Returned</p><p className="font-semibold">{fmtDate(ret.created_at)}</p></div>
          <div><p className="text-[11px] font-semibold uppercase text-slate-400">Reason</p><p className="font-semibold">{ret.reason}</p></div>
        </div>
        <div>
          <p className="mb-1 text-[12px] font-semibold text-slate-600 dark:text-slate-300">Suggested — same item, made on or after the return, not on another return</p>
          <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-navy-700">
            {(c?.suggested || []).map((l) => <Row key={l.id} l={l} hint />)}
            {c && c.suggested.length === 0 && <p className="px-3 py-4 text-center text-[12.5px] text-slate-400">No RGP of {ret.part_no} in ERP yet — search by challan no. or party below, or wait for the next ERP read.</p>}
          </div>
          {c && c.suggested.length > 1 && <p className="mt-1 text-[11.5px] text-amber-700">{c.suggested.length} RGPs fit — check the challan no. with the store employee who made it before linking.</p>}
        </div>
        <div>
          <SearchBox value={typed} onChange={setTyped} placeholder="Search any RGP: challan no., item, party…" />
          {q && (
            <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-navy-700">
              {(c?.found || []).map((l) => <Row key={l.id} l={l} />)}
              {c && c.found.length === 0 && <p className="px-3 py-4 text-center text-[12.5px] text-slate-400">No unlinked RGP matches "{q}".</p>}
            </div>
          )}
        </div>
        <p className="text-[11.5px] text-slate-500">Nothing is linked until you press Link. One RGP line goes to one return only.</p>
      </div>
    </Modal>
  );
}

// ---- RGP status (12 Nov 2026: "issue hokar jo bhi part ja rha h spare part store se wo sabhi") ----

const RGP_STATE = {
  OPEN: { label: "Pending", cls: "badge-danger" },
  PART_BACK: { label: "Part back", cls: "badge-warning" },
  CLOSED: { label: "Closed", cls: "badge-success" },
};
const RGP_FILTERS = [{ key: "", label: "All" }, { key: "open", label: "Pending" }, { key: "closed", label: "Closed" }];
const daysTone = (d) => (d > 30 ? "text-rose-600 dark:text-rose-400" : d > 15 ? "text-amber-600 dark:text-amber-400" : "text-slate-700 dark:text-slate-200");

function Tile({ label, value, hint, tone = "" }) {
  return (
    <div className="card py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular ${tone || "text-slate-800 dark:text-white"}`}>{value}</p>
      {hint && <p className="text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

function RgpRow({ r }) {
  const [open, setOpen] = useState(false);
  const st = RGP_STATE[r.state] || RGP_STATE.OPEN;
  return (
    <>
      <tr className="cursor-pointer align-top text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-navy-800/40"
        onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <td className="whitespace-nowrap px-3 py-2.5">
          <div className="flex items-start gap-1.5">
            <ChevronRight size={14} aria-hidden="true" className={`mt-0.5 shrink-0 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`} />
            <div><div className="font-mono font-semibold">{r.challan_no}</div><div className="text-[11px] text-slate-400">{fmtDate(r.challan_date)}</div></div>
          </div>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11.5px]">{r.issue_slips.join(", ") || "—"}</td>
        <td className="px-3 py-2.5"><div className="max-w-[220px] truncate" title={r.party_name}>{r.party_name}</div><div className="font-mono text-[11px] text-slate-400">{r.party_cd}</div></td>
        <td className="px-3 py-2.5 text-right tabular">{num(r.parts)}</td>
        <td className="px-3 py-2.5 text-right tabular">{num(r.qty)}</td>
        <td className="px-3 py-2.5 text-right tabular text-emerald-700 dark:text-emerald-400">{num(r.back)}</td>
        <td className={`px-3 py-2.5 text-right tabular font-semibold ${r.pending > 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-400"}`}>{num(r.pending)}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right">
          {r.days_open != null
            ? <span className={`font-semibold tabular ${daysTone(r.days_open)}`}>{num(r.days_open)} days</span>
            : r.days_taken != null
              ? <span className="text-[11.5px] text-slate-400" title={`Last part back on ${fmtDate(r.last_return)}`}>back in {num(r.days_taken)} days</span>
              : "—"}
        </td>
        <td className="px-3 py-2.5"><span className={`badge ${st.cls}`}>{st.label}</span></td>
      </tr>
      {open && (
        <tr className="bg-slate-50/60 dark:bg-navy-950/30">
          <td colSpan={9} className="px-3 pb-3 pt-1">
            <table className="w-full text-[12px]">
              <thead className="text-[10.5px] uppercase tracking-wide text-slate-400">
                <tr><th className="px-2 py-1.5 text-left font-semibold">Part</th><th className="px-2 py-1.5 text-right font-semibold">Sent</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Back</th><th className="px-2 py-1.5 text-right font-semibold">Pending</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Came back on (party's GRN)</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                {r.lines.map((l) => (
                  <tr key={l.part_no} className="align-top">
                    <td className="px-2 py-1.5"><span className="font-mono">{l.part_no}</span> <span className="text-slate-500">{l.part_name}</span></td>
                    <td className="px-2 py-1.5 text-right tabular">{num(l.qty)} {l.uom}</td>
                    <td className="px-2 py-1.5 text-right tabular text-emerald-700 dark:text-emerald-400">{num(l.back)}</td>
                    <td className={`px-2 py-1.5 text-right tabular ${l.pending > 0 ? "font-semibold text-rose-600 dark:text-rose-400" : "text-slate-400"}`}>{num(l.pending)}</td>
                    <td className="px-2 py-1.5">
                      {l.grns.length
                        ? l.grns.map((g) => <div key={`${g.grn_no}${g.grn_date}`} className="whitespace-nowrap"><span className="font-mono">{g.grn_no}</span> · {fmtDate(g.grn_date)} · {num(g.qty)}</div>)
                        : <span className="text-slate-400">Not back yet</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

function RgpStatus() {
  const [party, setParty] = useState("");
  const [state, setState] = useState("");
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed).toUpperCase();
  const list = useQuery({
    queryKey: ["job-work", "rgp-summary"],
    queryFn: () => jobWorkService.rgpSummary({ silent: true }).then((r) => r.data.data),
    placeholderData: keepPreviousData,
  });
  const d = list.data;
  const rows = useMemo(() => (d?.rows || []).filter((r) => (!party || r.party_cd === party)
    && (!state || (state === "closed" ? r.state === "CLOSED" : r.state !== "CLOSED"))
    && (!q || [r.challan_no, r.party_name, r.party_cd, ...r.issue_slips, ...r.lines.map((l) => `${l.part_no} ${l.part_name}`)]
      .join(" ").toUpperCase().includes(q))), [d, party, state, q]);
  const t = d?.totals;
  if (list.isError) return <ErrorState title="RGP status did not load" message={errText(list.error)} onRetry={() => list.refetch()} />;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Pending RGPs" value={t ? num(t.open) : "…"} hint={t ? `of ${num(t.rgps)} RGPs made from an issue slip` : ""} tone={t?.open ? "text-rose-600 dark:text-rose-400" : ""} />
        <Tile label="Pending qty" value={t ? num(t.pending_qty) : "…"} hint="Sent and not back yet" />
        <Tile label="Oldest pending" value={t ? (t.oldest_days != null ? `${num(t.oldest_days)} days` : "—") : "…"} hint="Since the challan date" tone={t?.oldest_days > 30 ? "text-rose-600 dark:text-rose-400" : ""} />
        <Tile label="Parties" value={d ? num(d.parties.length) : "…"} hint="With an RGP of a spare part" />
      </div>
      <p className="flex items-start gap-2 rounded-lg bg-sky-50 px-3 py-2 text-[11.5px] leading-relaxed text-sky-800 dark:bg-sky-500/10 dark:text-sky-200">
        <AlertTriangle size={14} className="mt-px shrink-0" aria-hidden="true" />
        <span>
          Every RGP (General FOC returnable challan) made from an issue slip for a spare part, any party. <b>Back</b> = the party&apos;s GRN of the same part dated on / after the challan, the oldest RGP first — ERP&apos;s GRN does not carry the RGP no., so this is the app&apos;s match until IT gives the RGP receiving detail. Check a doubtful one in ERP.
          {d?.grns_read_at && <> GRNs read {fmtStamp(d.grns_read_at)}.</>}
        </span>
      </p>
      <div className="card p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-navy-800">
          {[{ party_cd: "", party_name: "All parties", open: t?.open }, ...(d?.parties || [])].map((p) => (
            <button key={p.party_cd || "all"} type="button" aria-pressed={party === p.party_cd} onClick={() => setParty(p.party_cd)}
              title={p.party_cd ? `${num(p.rgps)} RGPs · ${num(p.qty)} sent · ${num(p.back)} back · ${num(p.pending)} pending` : undefined}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${party === p.party_cd
                ? "border-toyotared bg-toyotared text-white" : "border-slate-200 text-slate-700 hover:border-toyotared dark:border-navy-700 dark:text-slate-200"}`}>
              <span className="max-w-[180px] truncate">{p.party_name}</span>
              {p.open > 0 && <span className={`rounded-full px-1.5 text-[11px] font-semibold tabular ${party === p.party_cd ? "bg-white/20" : "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"}`}>{num(p.open)}</span>}
            </button>
          ))}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <span className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-navy-700">
              {RGP_FILTERS.map((f) => (
                <button key={f.key || "all"} type="button" aria-pressed={state === f.key} onClick={() => setState(f.key)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium ${state === f.key ? "bg-slate-800 text-white dark:bg-white dark:text-navy-900" : "text-slate-600 dark:text-slate-300"}`}>
                  {f.label}
                </button>
              ))}
            </span>
            <SearchBox value={typed} onChange={setTyped} placeholder="Challan, issue slip, part, party…" />
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-[12.5px]">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
              <tr><TH>RGP (challan) · date</TH><TH>Issue slip</TH><TH>Party</TH><TH right>Parts</TH><TH right>Qty sent</TH><TH right>Back</TH><TH right>Pending</TH><TH right>Days</TH><TH>Status</TH></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {rows.map((r) => <RgpRow key={r.challan_no} r={r} />)}
            </tbody>
          </table>
          {list.isPending && <p className="px-4 py-8 text-center text-sm text-slate-400">Loading…</p>}
          {d && rows.length === 0 && <p className="px-4 py-8 text-center text-sm text-slate-400">{d.rows.length ? "No RGP matches." : "No RGP made from an issue slip for a spare part yet."}</p>}
        </div>
      </div>
    </div>
  );
}

const RGP_VIEWS = [{ key: "status", label: "RGP status" }, { key: "lines", label: "All challan lines" }];

function RgpTab() {
  const [view, setView] = useState("status");
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="ERP challans" className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-navy-800 dark:bg-navy-900">
        {RGP_VIEWS.map((v) => (
          <button key={v.key} type="button" role="tab" aria-selected={view === v.key} onClick={() => setView(v.key)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${view === v.key ? "bg-slate-800 text-white dark:bg-white dark:text-navy-900" : "text-slate-600 dark:text-slate-300"}`}>
            {v.label}
          </button>
        ))}
      </div>
      {view === "status" ? <RgpStatus /> : <RgpLines />}
    </div>
  );
}

function RgpLines() {
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed);
  const list = useQuery({
    queryKey: ["job-work", "rgp", q],
    queryFn: () => jobWorkService.rgp(q, { silent: true }).then((r) => r.data.data),
    placeholderData: keepPreviousData,
  });
  const d = list.data;
  return (
    <div className="space-y-3">
      <SyncBar sync={d?.sync} />
      <div className="card p-0">
        <div className="flex justify-end border-b border-slate-100 px-4 py-3 dark:border-navy-800">
          <SearchBox value={typed} onChange={setTyped} placeholder="Challan no., item, party…" />
        </div>
        {list.isError ? <div className="p-4"><ErrorState title="ERP RGPs did not load" message={errText(list.error)} onRetry={() => list.refetch()} /></div> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-[12.5px]">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
                <tr><TH>Challan</TH><TH>Issue slip</TH><TH>Part No</TH><TH right>Qty</TH><TH>Party</TH><TH>ERP status</TH><TH>Target</TH><TH>Linked return</TH><TH>Store stock</TH></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                {(d?.rows || []).map((l) => (
                  <tr key={l.id} className="align-top text-slate-700 dark:text-slate-200">
                    <td className="whitespace-nowrap px-3 py-2.5"><div className="font-mono font-semibold">{l.challan_no}</div><div className="text-[11px] text-slate-400">{fmtDate(l.challan_date)}</div></td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11.5px]">{l.doc_no || <span className="text-slate-400">—</span>}</td>
                    <td className="px-3 py-2.5"><div className="font-mono">{l.item_cd}</div><div className="max-w-[240px] truncate text-[11px] text-slate-400" title={l.item_desc}>{l.item_desc}</div></td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular">{num(l.qty)} {l.uom}</td>
                    <td className="px-3 py-2.5">{l.party_name}</td>
                    <td className="px-3 py-2.5">{l.status}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">{l.target_date ? fmtDate(l.target_date) : "—"}</td>
                    <td className="px-3 py-2.5">{l.linked_return || <span className="text-slate-400">—</span>}</td>
                    <td className="px-3 py-2.5">
                      {l.stock_state
                        ? <span className={`badge ${STOCK_PILL[l.stock_state] || "badge-neutral"}`} title={l.stock_label}>{l.stock_label}</span>
                        : <span className="text-slate-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d && d.rows.length === 0 && <p className="px-4 py-8 text-center text-sm text-slate-400">{q ? "No challan matches." : "No challan read from ERP yet — they come with the next automatic ERP read."}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
