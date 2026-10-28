import React, { useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Archive, CheckCircle2, ListOrdered, Package, Printer, QrCode, RotateCcw, Search, Undo2, XCircle } from "lucide-react";
import Modal from "../../components/Modal.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import { useCan } from "../../components/Can.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { fmtDate, fmtStamp, num } from "../../lib/format.js";
import { packetService } from "../../services/packetService.js";
import {
  CancelDialog, MakeLabelsDialog, PrintDialog, VerifyDialog, errText,
} from "../../components/spare/PacketDialogs.jsx";

// Packets & QR Labels — the store's spec of 27 Oct 2026: ERP gate entry ->
// physical verification -> packet creation -> unique QR labels -> FIFO stock ->
// issue of whole packets (on Scan Part).
//
//   Receipts      every batch that came in — a spare part's ERP gate entry as
//                 the material arrives (28 Oct 2026: "gate entry k baad store
//                 verification k baad hi nikal de"), an ERP GRN accepted by
//                 quality with no gate receipt, or stock already on the shelf
//                 made into a batch: verify it, make its packets or unit
//                 labels, print them — or take the supplier's own box labels.
//                 A gate receipt's labels wait for ERP's QC before issue.
//   Old stock     the stock already on the shelf with no label, rack by rack
//                 (27 Oct 2026: "jo store me old stock pada h uske qr code bhi
//                 niklenge"): count it, pack it, print.
//   Packets & FIFO the packets on the shelf, oldest receipt first — which to
//                 issue next; reprint a label, cancel one made by mistake.
//   Issued        the packets that went out: when, to whom, by whom, and any
//                 FIFO exception's reason.
//
// Stock is never changed here: it comes in when ERP accepts the GRN (ERP's own
// process — "store stock to erp api se update hoga") and goes out when a
// packet's QR is scanned on Scan Part -> Issue.

const TABS = [
  { key: "receipts", label: "Receipts", icon: Package },
  { key: "old", label: "Old stock", icon: Archive },
  { key: "packets", label: "Packets & FIFO", icon: ListOrdered },
  { key: "issued", label: "Issued", icon: Undo2 },
];
const RECEIPT_FILTERS = [
  { key: "", label: "All" }, { key: "PENDING", label: "To verify" },
  { key: "TO_PACK", label: "To pack" }, { key: "PACKED", label: "Packed" },
];
const VERIFY_PILL = {
  PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",
  VERIFIED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  MISMATCH: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
};
const STATUS_PILL = {
  // A gate entry receipt's label made before ERP's QC (28 Oct 2026): printed,
  // never issued, until ERP accepts the GRN.
  QC_PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",
  AVAILABLE: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  ISSUED: "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300",
  CANCELLED: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
};

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

function Pager({ data, page, setPage }) {
  if (!data || data.pages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-2 text-[12px] dark:border-navy-800">
      <span className="text-slate-400">Page {data.page} of {data.pages} · {num(data.total)}</span>
      <button type="button" className="btn-secondary py-1 text-[12px]" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
      <button type="button" className="btn-secondary py-1 text-[12px]" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Next</button>
    </div>
  );
}

const TH = ({ children, right }) => <th className={`whitespace-nowrap px-3 py-2.5 font-semibold ${right ? "text-right" : ""}`}>{children}</th>;
const PartCell = ({ part }) => (
  <td className="px-3 py-2.5"><div className="font-mono font-semibold">{part.part_no}</div>
    <div className="max-w-[220px] truncate text-[11px] text-slate-400" title={part.part_name}>{part.part_name}</div></td>
);

export default function PacketManagement() {
  const { activeCode } = useStores();
  const [tab, setTab] = useState("receipts");
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-800 dark:text-white"><QrCode size={20} aria-hidden="true" /> Packets &amp; QR Labels</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Verify what came in, pack it with its own QR labels, and issue the oldest first — a packet goes out whole on Scan Part → Issue.
          </p>
        </div>
      </div>
      <div role="tablist" aria-label="Packets"
        className="inline-grid grid-cols-2 gap-1 rounded-xl border sm:grid-cols-4 border-slate-200 bg-white p-1 dark:border-navy-800 dark:bg-navy-900">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${tab === t.key
              ? "bg-toyotared text-white shadow-sm" : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-navy-800"}`}>
            <t.icon size={15} aria-hidden="true" /> {t.label}
          </button>
        ))}
      </div>
      {tab === "receipts" && <ReceiptsTab storeCode={activeCode} />}
      {tab === "old" && <OldStockTab storeCode={activeCode} />}
      {tab === "packets" && <PacketsTab storeCode={activeCode} />}
      {tab === "issued" && <IssuedTab storeCode={activeCode} />}
    </div>
  );
}

// ---- Receipts ----------------------------------------------------------------------------------

// The labels to print after packets are made: ours only — a box that carries
// the supplier's own label needs none.
const printable = (packets) => (packets || []).filter((p) => !p.supplier_code);
const STATUS_WORD = { AVAILABLE: "On the shelf", QC_PENDING: "Waiting for QC" };
const LABELLED = new Set(["AVAILABLE", "QC_PENDING"]);

function ReceiptsTab({ storeCode }) {
  const canCreate = useCan("spare_packets", "create");
  const canUpdate = useCan("spare_packets", "update");
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [status, q]);
  const [dialog, setDialog] = useState(null);           // { kind: VERIFY | MAKE | PRINT, ... }
  const list = useQuery({
    queryKey: ["packets", "receipts", storeCode, status, q, page],
    queryFn: () => packetService.receipts({ store_code: storeCode, status: status || undefined, q: q || undefined, page, page_size: 25 },
      { silent: true }).then((r) => r.data.data),
    enabled: Boolean(storeCode),
    placeholderData: keepPreviousData,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["packets"] });
  // The receipt's labels not printed yet; a printed one is reprinted from
  // Packets & FIFO, with a reason.
  const printNew = async (r) => {
    try {
      const res = await packetService.packets({ store_code: storeCode, q: r.receipt_no, page_size: 100 });
      const rows = printable(res.data.data.rows.filter((p) => p.receipt.id === r.id && LABELLED.has(p.status) && !p.print_count));
      if (rows.length) setDialog({ kind: "PRINT", packets: rows });
      else toast("Every label of this receipt is printed (or on the supplier's label) — reprint one from Packets & FIFO");
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const reopen = async (r) => {
    try {
      const res = await packetService.reopen(r.id);
      toast.success(res.data.message);
      refresh();
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const made = (out) => {
    refresh();
    const rows = printable(out.packets);
    setDialog(rows.length ? { kind: "PRINT", packets: rows } : null);
  };
  return (
    <div className="card p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-navy-800">
        <div className="flex flex-wrap gap-1">
          {RECEIPT_FILTERS.map((f) => (
            <button key={f.key} type="button" onClick={() => setStatus(f.key)} aria-pressed={status === f.key}
              className={`rounded-full px-3 py-1 text-[12px] font-semibold ${status === f.key ? "bg-navy-900 text-white dark:bg-white dark:text-navy-900" : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"}`}>
              {f.label}
            </button>
          ))}
        </div>
        <SearchBox value={typed} onChange={setTyped} placeholder="Part, GRN, gate entry, supplier…" />
      </div>
      {list.isError ? <div className="p-4"><ErrorState title="Receipts did not load" message={errText(list.error)} onRetry={() => list.refetch()} /></div> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-[12.5px]">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
              <tr><TH>Received</TH><TH>Part</TH><TH>GRN / Gate entry</TH><TH right>Received qty</TH><TH>Verification</TH><TH right>In packets</TH><TH right>To pack</TH><TH /></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {(list.data?.rows || []).map((r) => (
                <tr key={r.id} className="align-top text-slate-700 dark:text-slate-200">
                  <td className="whitespace-nowrap px-3 py-2.5"><div>{fmtDate(r.received_on)}</div><div className="text-[11px] text-slate-400">{r.receipt_no}</div></td>
                  <PartCell part={r.part} />
                  <td className="px-3 py-2.5">
                    <div>{r.source === "OPENING" ? "Shelf stock" : r.grn_no || (r.source === "GATE" ? "Gate entry" : "—")}</div>
                    {r.qc === "QC_PENDING" && <span className="badge mt-0.5 bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200" title="Labels can be made and printed now; they are issued once ERP accepts the GRN">QC pending in ERP</span>}
                    {r.qc === "ACCEPTED" && <span className="badge mt-0.5 bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">Accepted {num(r.accepted_qty)} in ERP</span>}
                    <div className="max-w-[200px] truncate text-[11px] text-slate-400" title={r.supplier_name}>
                      {[r.gate_entry_no && `GE ${r.gate_entry_no}`, r.supplier_name].filter(Boolean).join(" · ")}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular">{num(r.qty)} {r.uom}</td>
                  <td className="px-3 py-2.5">
                    <span className={`badge ${VERIFY_PILL[r.verify_status]}`}>
                      {r.verify_status === "PENDING" ? "To verify" : r.verify_status === "VERIFIED" ? `Verified ${num(r.verified_qty)}` : `Counted ${num(r.verified_qty)}`}
                    </span>
                    {r.verify_status === "MISMATCH" && <div className="mt-0.5 max-w-[180px] truncate text-[11px] text-rose-600" title={r.verify_remarks}>{r.verify_remarks}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular">
                    {num(r.packed_qty)}<div className="text-[11px] text-slate-400">{r.packets.qc_pending ? `${r.packets.qc_pending} waiting for QC · ` : ""}{r.packets.available} on shelf · {r.packets.issued} issued</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular">
                    {r.loose_note ? <span className="badge bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200" title={r.loose_note}>Kept loose</span>
                      : r.verify_status === "PENDING" ? "—" : num(r.to_pack)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">
                    <div className="flex flex-col items-end gap-1">
                      {canCreate && (r.verify_status === "PENDING" ? (
                        <button type="button" className="btn-primary py-1 text-[12px]" onClick={() => setDialog({ kind: "VERIFY", receipt: r })}>
                          <CheckCircle2 size={13} aria-hidden="true" /> Verify
                        </button>
                      ) : r.to_pack > 0 && (
                        <button type="button" className="btn-primary py-1 text-[12px]" onClick={() => setDialog({ kind: "MAKE", receipt: r })}>
                          <Package size={13} aria-hidden="true" /> Make labels
                        </button>
                      ))}
                      {canCreate && (r.packets.available > 0 || r.packets.qc_pending > 0) && (
                        <button type="button" className="text-[12px] font-semibold text-toyotared hover:underline"
                          onClick={() => printNew(r)}>
                          <Printer size={12} aria-hidden="true" className="mr-1 inline" />Print labels
                        </button>
                      )}
                      {canUpdate && r.loose_note && (
                        <button type="button" className="text-[11px] text-slate-500 hover:underline" onClick={() => reopen(r)}
                          title="Supplier code on every box — mapped to the part. Pack it after all?">
                          <RotateCcw size={11} aria-hidden="true" className="mr-1 inline" />Pack after all
                        </button>
                      )}
                      {canCreate && r.verify_status !== "PENDING" && r.packed_qty === 0 && !r.loose_note && (
                        <button type="button" className="text-[11px] text-slate-500 hover:underline" onClick={() => setDialog({ kind: "VERIFY", receipt: r })}>Recount</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data && list.data.total === 0 && (
            <p className="px-4 py-8 text-center text-sm text-slate-400">
              {q || status ? "No receipt matches." : "No receipt yet — a spare part's ERP gate entry shows here as the material arrives. Stock already on the shelf is labelled from Old stock."}
            </p>
          )}
        </div>
      )}
      <Pager data={list.data} page={page} setPage={setPage} />
      {!canCreate && <p className="border-t border-slate-100 px-4 py-2 text-[12px] text-amber-700 dark:border-navy-800">Verifying and making labels need the Packets &amp; QR Labels create right.</p>}

      {dialog?.kind === "VERIFY" && (
        <VerifyDialog receipt={dialog.receipt} onClose={() => setDialog(null)}
          onDone={(r) => { refresh(); setDialog(r.to_pack > 0 ? { kind: "MAKE", receipt: r } : null); }} />
      )}
      {dialog?.kind === "MAKE" && (
        <MakeLabelsDialog receipt={dialog.receipt} onClose={() => setDialog(null)} onMade={made}
          onKeptLoose={() => { refresh(); setDialog(null); }} />
      )}
      {dialog?.kind === "PRINT" && dialog.packets?.length > 0 && (
        <PrintDialog packets={dialog.packets} onClose={() => setDialog(null)} onDone={refresh} />
      )}
    </div>
  );
}

// ---- Old stock -----------------------------------------------------------------------------------
//
// The stock already on the shelf with no label, rack by rack — the walk the
// store makes: pick the section and the rack, count each part, pack it, print.
// What is waiting in a receipt is labelled from Receipts, so it is not counted
// here; a part whose supplier code is mapped scans as it is.

const OLD_SHOW = [{ key: "todo", label: "To label" }, { key: "done", label: "Done" }, { key: "all", label: "All" }];
const OLD_STATE = {
  TODO: ["To label", "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200"],
  PARTLY: ["Part labelled", "bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-200"],
  DONE: ["Labelled", "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"],
  RECEIPT: ["In Receipts", "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"],
  SUPPLIER: ["Supplier code", "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200"],
};

function OldStockTab({ storeCode }) {
  const canCreate = useCan("spare_packets", "create");
  const qc = useQueryClient();
  const [section, setSection] = useState("");
  const [rack, setRack] = useState("");
  const [show, setShow] = useState("todo");
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [section, rack, show, q]);
  useEffect(() => { setRack(""); }, [section]);
  const [dialog, setDialog] = useState(null);           // { kind: MAKE | PRINT, ... }
  const list = useQuery({
    queryKey: ["packets", "old", storeCode, section, rack, show, q, page],
    queryFn: () => packetService.oldStock({ store_code: storeCode, section_id: section || undefined, rack: rack || undefined,
      show, q: q || undefined, page, page_size: 50 }, { silent: true }).then((r) => r.data.data),
    enabled: Boolean(storeCode),
    placeholderData: keepPreviousData,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["packets"] });
  const d = list.data;
  const sum = d?.summary;
  const pct = sum && sum.parts ? Math.round((sum.done / sum.parts) * 100) : 0;
  return (
    <div className="space-y-3">
      {sum && (
        <div className="card flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
          <div className="min-w-[220px] flex-1">
            <p className="text-[12px] font-semibold text-slate-500">
              {rack ? `Rack ${rack}` : section ? (d.sections.find((x) => String(x.id) === String(section))?.name || "Section") : "Whole store"}
              {" "}— {num(sum.done)} of {num(sum.parts)} parts labelled
            </p>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-navy-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
            </div>
          </div>
          {[["To label", sum.to_do, "text-amber-700"], ["Part labelled", sum.partly, "text-orange-700"], ["Qty without label", sum.qty_to_label, "text-slate-800 dark:text-white"]].map(([l, v, c]) => (
            <div key={l}><p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{l}</p>
              <p className={`text-lg font-bold tabular ${c}`}>{num(v)}</p></div>
          ))}
        </div>
      )}
      <div className="card p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-navy-800">
          <div className="flex flex-wrap items-center gap-2">
            <select className="input-field py-1.5 text-[13px] sm:w-auto" value={section} onChange={(e) => setSection(e.target.value)} aria-label="Section">
              <option value="">All sections</option>
              {(d?.sections || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <select className="input-field py-1.5 text-[13px] sm:w-auto" value={rack} onChange={(e) => setRack(e.target.value)} aria-label="Rack">
              <option value="">All racks</option>
              {(d?.racks || []).map((r) => <option key={r.rack} value={r.rack}>{r.rack}{r.to_do ? ` — ${r.to_do} to label` : " — done"}</option>)}
            </select>
            <div className="flex flex-wrap gap-1">
              {OLD_SHOW.map((f) => (
                <button key={f.key} type="button" onClick={() => setShow(f.key)} aria-pressed={show === f.key}
                  className={`rounded-full px-3 py-1 text-[12px] font-semibold ${show === f.key ? "bg-navy-900 text-white dark:bg-white dark:text-navy-900" : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"}`}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <SearchBox value={typed} onChange={setTyped} placeholder="Part, description, location…" />
        </div>
        {list.isError ? <div className="p-4"><ErrorState title="Old stock did not load" message={errText(list.error)} onRetry={() => list.refetch()} /></div> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-left text-[12.5px]">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
                <tr><TH>Location</TH><TH>Part</TH><TH>Section</TH><TH right>On hand</TH><TH right>In packets</TH><TH right>Without label</TH><TH>State</TH><TH /></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                {(d?.rows || []).map((r) => {
                  const [word, pill] = OLD_STATE[r.state] || [r.state, ""];
                  return (
                    <tr key={r.part.id} className="align-top text-slate-700 dark:text-slate-200">
                      <td className="whitespace-nowrap px-3 py-2.5"><div className="font-semibold">{r.part.location || "—"}</div><div className="text-[11px] text-slate-400">Rack {r.rack}</div></td>
                      <PartCell part={r.part} />
                      <td className="px-3 py-2.5 text-[12px]">{r.part.section || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular">{num(r.on_hand)} {r.part.uom}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular">{num(r.packed_available)}
                        {r.waiting_in_receipts > 0 && <div className="text-[11px] text-slate-400">{num(r.waiting_in_receipts)} in Receipts</div>}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular">{num(r.to_label)}</td>
                      <td className="px-3 py-2.5"><span className={`badge ${pill}`}>{word}</span></td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right">
                        {canCreate && r.to_label > 0 && (
                          <button type="button" className="btn-primary py-1 text-[12px]" onClick={() => setDialog({ kind: "MAKE", row: r })}>
                            <QrCode size={13} aria-hidden="true" /> Label
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {d && d.total === 0 && (
              <p className="px-4 py-8 text-center text-sm text-slate-400">
                {show === "todo" && !q ? "Nothing left to label here." : "No part matches."}
              </p>
            )}
          </div>
        )}
        <Pager data={d} page={page} setPage={setPage} />
        {!canCreate && <p className="border-t border-slate-100 px-4 py-2 text-[12px] text-amber-700 dark:border-navy-800">Labelling needs the Packets &amp; QR Labels create right.</p>}
      </div>
      {dialog?.kind === "MAKE" && (
        <MakeLabelsDialog old={dialog.row} onClose={() => setDialog(null)}
          onMade={(out) => { refresh(); const rows = printable(out.packets); setDialog(rows.length ? { kind: "PRINT", packets: rows } : null); }}
          onKeptLoose={() => { refresh(); setDialog(null); }} />
      )}
      {dialog?.kind === "PRINT" && dialog.packets?.length > 0 && (
        <PrintDialog packets={dialog.packets} onClose={() => setDialog(null)} onDone={refresh} />
      )}
    </div>
  );
}

// ---- Packets & FIFO ------------------------------------------------------------------------------

function PacketsTab({ storeCode }) {
  const canReprint = useCan("spare_packets", "update");
  const canPrint = useCan("spare_packets", "create");
  const canCancel = useCan("spare_packets", "delete");
  const qc = useQueryClient();
  const [status, setStatus] = useState("AVAILABLE");
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [status, q]);
  const [dialog, setDialog] = useState(null);
  const list = useQuery({
    queryKey: ["packets", "list", storeCode, status, q, page],
    queryFn: () => packetService.packets({ store_code: storeCode, status: status || undefined, q: q || undefined, page, page_size: 50 },
      { silent: true }).then((r) => r.data.data),
    enabled: Boolean(storeCode),
    placeholderData: keepPreviousData,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["packets"] });
  return (
    <div className="card p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-navy-800">
        <div className="flex flex-wrap gap-1">
          {[["AVAILABLE", "On the shelf"], ["QC_PENDING", "Waiting for QC"], ["CANCELLED", "Cancelled"], ["", "All"]].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setStatus(k)} aria-pressed={status === k}
              className={`rounded-full px-3 py-1 text-[12px] font-semibold ${status === k ? "bg-navy-900 text-white dark:bg-white dark:text-navy-900" : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"}`}>
              {label}
            </button>
          ))}
        </div>
        <SearchBox value={typed} onChange={setTyped} placeholder="Part, packet / supplier code, receipt…" />
      </div>
      {list.isError ? <div className="p-4"><ErrorState title="Packets did not load" message={errText(list.error)} onRetry={() => list.refetch()} /></div> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-[12.5px]">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
              <tr><TH>Part</TH><TH>Packet</TH><TH right>Qty</TH><TH>Received</TH><TH>Location</TH><TH>Status</TH><TH right>Labels</TH><TH /></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {(list.data?.rows || []).map((p) => (
                <tr key={p.id} className="align-top text-slate-700 dark:text-slate-200">
                  <PartCell part={p.part} />
                  <td className="px-3 py-2.5"><div className="font-mono text-[12px] font-semibold">{p.code}</div>
                    <div className="text-[11px] text-slate-400">{p.kind === "UNIT" ? "Individual" : "Packet"} #{p.seq}</div>
                    {p.supplier_code && <div className="max-w-[200px] truncate font-mono text-[11px] text-sky-700 dark:text-sky-300" title={p.supplier_code}>Supplier label: {p.supplier_code}</div>}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular">{num(p.qty)} {p.uom}</td>
                  <td className="whitespace-nowrap px-3 py-2.5"><div>{fmtDate(p.receipt.received_on)}</div><div className="text-[11px] text-slate-400">{p.receipt.receipt_no}</div></td>
                  <td className="px-3 py-2.5">{p.location || "—"}</td>
                  <td className="px-3 py-2.5"><span className={`badge ${STATUS_PILL[p.status]}`}>{STATUS_WORD[p.status] || p.status.toLowerCase()}</span>
                    {p.cancel_reason && <div className="mt-0.5 max-w-[160px] truncate text-[11px] text-slate-400" title={p.cancel_reason}>{p.cancel_reason}</div>}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular">{p.print_count ? `${p.print_count}×`
                    : p.supplier_code ? <span className="text-sky-700 dark:text-sky-300">supplier's</span> : <span className="text-amber-600">not printed</span>}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">
                    <div className="flex flex-col items-end gap-1">
                      <button type="button" className="text-[12px] font-semibold text-navy-800 hover:underline dark:text-slate-200" onClick={() => setDialog({ kind: "FIFO", partId: p.part.id })}>
                        <ListOrdered size={12} aria-hidden="true" className="mr-1 inline" />FIFO order
                      </button>
                      {LABELLED.has(p.status) && (p.print_count ? canReprint : canPrint) && (
                        <button type="button" className="text-[12px] font-semibold text-toyotared hover:underline"
                          onClick={() => setDialog({ kind: "PRINT", packets: [p], reprint: Boolean(p.print_count) })}>
                          <Printer size={12} aria-hidden="true" className="mr-1 inline" />{p.print_count ? "Reprint" : "Print"}
                        </button>
                      )}
                      {LABELLED.has(p.status) && canCancel && (
                        <button type="button" className="text-[11px] text-rose-600 hover:underline" onClick={() => setDialog({ kind: "CANCEL", packet: p })}>
                          <XCircle size={11} aria-hidden="true" className="mr-1 inline" />Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data && list.data.total === 0 && <p className="px-4 py-8 text-center text-sm text-slate-400">{q ? "No packet matches." : "No packet here yet."}</p>}
        </div>
      )}
      <Pager data={list.data} page={page} setPage={setPage} />
      {dialog?.kind === "FIFO" && <FifoDialog partId={dialog.partId} onClose={() => setDialog(null)} />}
      {dialog?.kind === "PRINT" && <PrintDialog packets={dialog.packets} reprint={dialog.reprint} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === "CANCEL" && <CancelDialog packet={dialog.packet} onClose={() => setDialog(null)} onDone={refresh} />}
    </div>
  );
}

function FifoDialog({ partId, onClose }) {
  const fifo = useQuery({
    queryKey: ["packets", "fifo", partId],
    queryFn: () => packetService.fifo(partId, { silent: true }).then((r) => r.data.data),
  });
  const d = fifo.data;
  return (
    <Modal open onClose={onClose} size="xl" title={d ? `${d.part.part_no} — issue order` : "Issue order"}
      footer={<button type="button" className="btn-secondary" onClick={onClose}>Close</button>}>
      {!d ? <p className="text-sm text-slate-400">{fifo.isError ? errText(fifo.error) : "Loading…"}</p> : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3 text-center dark:bg-navy-950/40">
            {[["On hand", d.on_hand], ["In packets", d.packed_available], ["Loose", d.loose]].map(([l, v]) => (
              <div key={l}><p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{l}</p>
                <p className="text-lg font-bold tabular text-slate-800 dark:text-white">{num(v)} <span className="text-[12px] font-medium text-slate-400">{d.part.uom}</span></p></div>
            ))}
          </div>
          <ol className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-navy-800 dark:border-navy-700">
            {d.packets.map((p) => (
              <li key={p.id} className={`flex items-center justify-between gap-3 px-3 py-2 ${p.issue_first ? "bg-emerald-50/60 dark:bg-emerald-500/5" : ""}`}>
                <span className="flex min-w-0 items-center gap-3">
                  <span className="w-6 text-right text-[12px] font-bold text-slate-400">{p.rank}</span>
                  <span className="min-w-0"><span className="block font-mono text-[12.5px] font-semibold">{p.code}</span>
                    <span className="block text-[11px] text-slate-400">Received {fmtDate(p.receipt.received_on)} · {p.receipt.receipt_no}</span></span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-[13px] font-semibold tabular">{num(p.qty)} {p.uom}</span>
                  {p.issue_first && <span className="badge bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">Issue first</span>}
                </span>
              </li>
            ))}
            {d.packets.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-400">No packet on the shelf.</li>}
          </ol>
          <p className="text-[12px] text-slate-500 dark:text-slate-400">Oldest receipt first. Scanning a newer packet on Scan Part asks for a reason.</p>
        </div>
      )}
    </Modal>
  );
}

// ---- Issued -----------------------------------------------------------------------------------------

function IssuedTab({ storeCode }) {
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, from, to]);
  const list = useQuery({
    queryKey: ["packets", "issued", storeCode, q, from, to, page],
    queryFn: () => packetService.issued({ store_code: storeCode, q: q || undefined, from: from || undefined, to: to || undefined, page, page_size: 50 },
      { silent: true }).then((r) => r.data.data),
    enabled: Boolean(storeCode),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="card p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-navy-800">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-500">
          <input type="date" className="input-field py-1.5 text-[12.5px]" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          <span>to</span>
          <input type="date" className="input-field py-1.5 text-[12.5px]" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        </div>
        <SearchBox value={typed} onChange={setTyped} placeholder="Part, packet, department, person…" />
      </div>
      {list.isError ? <div className="p-4"><ErrorState title="The history did not load" message={errText(list.error)} onRetry={() => list.refetch()} /></div> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-[12.5px]">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
              <tr><TH>Issued</TH><TH>Part</TH><TH>Packet</TH><TH right>Qty</TH><TH>Department · Issued to</TH><TH>Received</TH><TH>FIFO</TH></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {(list.data?.rows || []).map((p) => (
                <tr key={p.id} className="align-top text-slate-700 dark:text-slate-200">
                  <td className="whitespace-nowrap px-3 py-2.5"><div>{fmtStamp(p.issued_at)}</div><div className="text-[11px] text-slate-400">by {p.issued_by}</div></td>
                  <PartCell part={p.part} />
                  <td className="px-3 py-2.5 font-mono text-[12px]">{p.code}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular">{num(p.qty)} {p.uom}</td>
                  <td className="px-3 py-2.5"><div>{p.department}</div><div className="text-[11px] text-slate-400">{p.issued_to}</div></td>
                  <td className="whitespace-nowrap px-3 py-2.5"><div>{fmtDate(p.receipt.received_on)}</div><div className="text-[11px] text-slate-400">{p.receipt.receipt_no}</div></td>
                  <td className="px-3 py-2.5">{p.fifo_override_reason
                    ? <span className="text-[12px] text-amber-700" title={p.fifo_override_reason}>Skipped: {p.fifo_override_reason}</span>
                    : <span className="text-[12px] text-emerald-700">In order</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data && list.data.total === 0 && <p className="px-4 py-8 text-center text-sm text-slate-400">No packet issued{q || from || to ? " that matches" : " yet"}.</p>}
        </div>
      )}
      <Pager data={list.data} page={page} setPage={setPage} />
    </div>
  );
}
