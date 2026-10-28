import React, { useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { AlertTriangle, Hammer, Link2, Search, Unlink } from "lucide-react";
import Modal from "../../components/Modal.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import { useCan } from "../../components/Can.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { fmtDate, fmtStamp, num } from "../../lib/format.js";
import { jobWorkService } from "../../services/jobWorkService.js";

// Job Work & RGP — the store's spec of 27 Oct 2026 ("Part Return, Job Work
// Return & Pending RGP Integration"). A user brings a worn / damaged part back
// for job work (Scan Part -> Return -> Job work): it is kept apart, not stock,
// as Pending RGP. Another store employee makes the challan in ERP — a "General
// FOC" returnable challan, made from the issue slip in the vendor's name — the
// app reads those of the spare parts (read only — it never makes one) and links
// each waiting return to its challan by itself; a store person can unlink a
// wrong one and pick another here (27 Oct 2026).
//
//   Returns       each job work return: Pending RGP · RGP available – pending
//                 match · RGP linked · API sync failed
//   ERP challans  the returnable challan lines as last read from ERP, and which
//                 return each is on

const TABS = [{ key: "returns", label: "Job work returns" }, { key: "rgp", label: "ERP challans" }];

// What a challan did to store stock (JobWorkService.STOCK_STATES, 28 Oct 2026):
// a new part sent from stock goes out of it; a used part, a challan with no
// issue slip, or one the part's count already holds moves nothing.
const STOCK_PILL = {
  OUT: "badge-info", WILL_OUT: "badge-info", SHORT: "badge-danger", USED_PART: "badge-success",
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
          Parts brought back for job work wait here (not stock) until the returnable challan made in ERP (General FOC, from the issue slip) is linked — the app links it by itself.
          A new part sent from store stock on a challan with an issue slip goes out of store stock by itself, and comes back on the vendor's GRN. The app only reads ERP — it never makes a challan.
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

function RgpTab() {
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
