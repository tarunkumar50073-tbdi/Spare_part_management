import React, { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Mail, Search, Settings2 } from "lucide-react";
import Modal from "../Modal.jsx";
import ErrorState from "../ErrorState.jsx";
import { useCan } from "../Can.jsx";
import { inputCls } from "../scan/forms/flow.js";
import { fmtDate, num } from "../../lib/format.js";
import { rejectionService } from "../../services/rejectionService.js";
import { newRequestId } from "../../services/challanService.js";

// Rejection Mail — the one mail the store sends RQC to punch a rejection in ERP
// (the store, 22 Oct 2026: "jab koi material reject hota h to hum us invoice ki
// grn srv finished me bnwakar rqc wale ko mail karte h ki isko system me punch
// kar do") — and only that ("rejection request only 1 mail k liye h baaki kuch
// nhi"). Two kinds: an SRV rejection (the usual — the GRN made in SRV finished)
// and a line rejection (the GRN was already a store entry and the user rejected
// it later).
//
// The form fills from the ERP GRN line (or is typed in while ERP is not
// reachable); "Open mail in Outlook" hands over the mail as a ready draft in the
// store's own format — the store presses Send; the app sends nothing itself.
// Below, the mails made, to open one again. Never moves stock.
//
// Opened from Short & Rejection ("Rejection mail →" on the Rejection tab), not a
// screen of its own since 28 Oct 2026 ("haan short & rejection me daal de").

const KIND_PILL = { SRV: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300", LINE: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200" };
const errText = (e) => e?.response?.data?.message || e?.message || "Something went wrong";
const BLANK = { kind: "SRV", qty: "", remark: "", hsn: "", po_no: "", po_date: "", ven_name: "", grn_no: "", grn_date: "", challan_no: "", challan_date: "" };

function Field({ label, required, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-semibold text-slate-600 dark:text-slate-300">{label}{required && <span className="text-toyotared"> *</span>}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

function useDebounced(text, ms = 250) {
  const [v, setV] = useState(text);
  useEffect(() => { const t = setTimeout(() => setV(text.trim()), ms); return () => clearTimeout(t); }, [text, ms]);
  return v;
}

const mailName = (r) => `${r.request_no} ${r.ven_name} rejection.eml`;

export default function RejectionMailDialog({ storeCode: activeCode, onClose }) {
  const canCreate = useCan("rejection_request", "create");   // C: make a mail
  const canEdit = useCan("rejection_request", "update");     // E: mail settings, open a mail draft
  const qc = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [q, setQ] = useState("");
  const asked = useDebounced(q);
  const list = useQuery({
    queryKey: ["rejections", "list", activeCode, asked],
    queryFn: () => rejectionService.list({ store_code: activeCode, q: asked || undefined, page_size: 50 }, { silent: true }).then((r) => r.data.data),
    enabled: Boolean(activeCode),
    placeholderData: keepPreviousData,
  });
  const openMail = (r) => rejectionService.downloadMail(r.id, mailName(r)).catch((e) => toast.error(errText(e)));

  return (
    <Modal open onClose={onClose} size="full" title="Rejection mail">
      <div className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="min-w-0 text-xs text-slate-400">The mail to RQC to punch an SRV / line rejection — it opens in Outlook, ready to send.</p>
          {canEdit && (
            <button type="button" className="btn-secondary" onClick={() => setSettingsOpen(true)} title="Who the mail goes to">
              <Settings2 size={15} aria-hidden="true" /> Mail settings
            </button>
          )}
        </div>

        {canCreate ? (
          <MailForm storeCode={activeCode} onMade={(row) => { qc.invalidateQueries({ queryKey: ["rejections", "list"] }); openMail(row); }} />
        ) : (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">You can see the mails made. Making one needs the Rejection Mail edit right.</p>
        )}

        <div className="card p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-navy-800">
            <h3 className="text-[14px] font-bold text-slate-800 dark:text-white">Mails made</h3>
            <span className="relative">
              <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className="input-field w-64 py-1.5 pl-8 text-[13px]" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Supplier, part, GRN, challan…" />
            </span>
          </div>
          {list.isError ? <div className="p-4"><ErrorState title="The list did not load" message={errText(list.error)} onRetry={() => list.refetch()} /></div> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-[12.5px]">
                <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
                  <tr>{["Made", "Kind", "Supplier", "Part", "Qty", "GRN / Challan", "Remark", ""].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2.5 font-semibold">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                  {(list.data?.rows || []).map((r) => (
                    <tr key={r.id} className="align-top text-slate-700 dark:text-slate-200">
                      <td className="whitespace-nowrap px-3 py-2.5"><div>{fmtDate(r.created_at)}</div><div className="text-[11px] text-slate-400">{r.created_by}</div></td>
                      <td className="px-3 py-2.5"><span className={`badge ${KIND_PILL[r.kind]}`}>{r.kind_label}</span></td>
                      <td className="px-3 py-2.5"><div className="max-w-[200px] truncate" title={r.ven_name}>{r.ven_name}</div></td>
                      <td className="px-3 py-2.5"><div className="font-mono font-semibold">{r.item_cd}</div><div className="max-w-[200px] truncate text-[11px] text-slate-400" title={r.item_desc}>{r.item_desc}</div></td>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular">{num(r.qty)} {r.uom}</td>
                      <td className="px-3 py-2.5"><div>{r.grn_no || "—"}</div><div className="text-[11px] text-slate-400">{r.challan_no ? `Challan ${r.challan_no}` : ""}</div></td>
                      <td className="px-3 py-2.5"><div className="max-w-[180px] truncate" title={r.remark}>{r.remark}</div></td>
                      <td className="px-3 py-2.5 text-right">
                        {canEdit && (
                          <button type="button" onClick={() => openMail(r)} className="inline-flex items-center gap-1 text-[12px] font-semibold text-toyotared hover:underline">
                            <Mail size={13} aria-hidden="true" /> Open mail
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {list.data && list.data.total === 0 && <p className="px-4 py-8 text-center text-sm text-slate-400">{asked ? "No mail matches." : "No rejection mail made yet."}</p>}
            </div>
          )}
        </div>

        {settingsOpen && <MailSettings onClose={() => setSettingsOpen(false)} />}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ the form */

function MailForm({ storeCode, onMade }) {
  const [requestId, setRequestId] = useState(newRequestId);
  const [mode, setMode] = useState("erp");          // erp: pick the ERP GRN line · typed: no ERP line
  const [text, setText] = useState("");
  const found = useDebounced(text);
  const [line, setLine] = useState(null);
  const [part, setPart] = useState(null);
  const [f, setF] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const lines = useQuery({
    queryKey: ["rejections", "grn-lines", storeCode, found],
    queryFn: () => rejectionService.grnLines(storeCode, found, { silent: true }).then((r) => r.data.data || []),
    enabled: mode === "erp" && !line && found.length >= 2,
  });
  const parts = useQuery({
    queryKey: ["rejections", "parts", storeCode, found],
    queryFn: () => rejectionService.parts(storeCode, found, { silent: true }).then((r) => r.data.data || []),
    enabled: mode === "typed" && !part && found.length >= 2,
  });
  const reset = () => { setLine(null); setPart(null); setText(""); setF(BLANK); setError(null); setRequestId(newRequestId()); };
  const pickLine = (l) => {
    setLine(l);
    setF((x) => ({ ...x, kind: l.suggested_kind, qty: String(l.receipt_qty ?? ""), po_no: l.po_no || "" }));
  };
  const ready = (mode === "erp" ? Boolean(line) : Boolean(part && f.ven_name.trim() && (f.grn_no.trim() || f.challan_no.trim())))
    && Number(f.qty) > 0 && f.remark.trim();
  const make = async () => {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await rejectionService.create({
        store_code: storeCode, request_id: requestId, kind: f.kind, qty: f.qty, remark: f.remark.trim(), hsn: f.hsn.trim() || null,
        po_no: f.po_no.trim() || null, po_date: f.po_date || null,
        ...(mode === "erp" ? { receiving_register_id: line.id } : {
          part_id: part.id, ven_name: f.ven_name.trim(), grn_no: f.grn_no.trim() || null, grn_date: f.grn_date || null,
          challan_no: f.challan_no.trim() || null, challan_date: f.challan_date || null,
        }),
      });
      toast.success("Mail ready — open the downloaded file, Outlook shows it ready to send");
      onMade(r.data.data);
      reset();
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap gap-2">
        {[["erp", "From the ERP GRN line"], ["typed", "Type it in (GRN not in ERP data)"]].map(([k, label]) => (
          <button key={k} type="button" onClick={() => { setMode(k); reset(); }}
            className={`rounded-lg px-3 py-1.5 text-[12.5px] font-semibold ${mode === k ? "bg-navy-900 text-white dark:bg-white dark:text-navy-900" : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"}`}>
            {label}
          </button>
        ))}
      </div>

      {mode === "erp" && !line && (
        <div>
          <input className={inputCls(false, "w-full")} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="GRN no., challan no., Part No., description or supplier…" />
          <div className="mt-2 max-h-72 space-y-1.5 overflow-y-auto">
            {lines.isPending && found.length >= 2 && <p className="text-[12px] text-slate-400">Searching the ERP GRN register…</p>}
            {lines.data && lines.data.length === 0 && <p className="text-[12px] text-slate-400">No GRN line of this store's parts matches — the ERP data may not have it yet; use "Type it in".</p>}
            {(lines.data || []).map((l) => (
              <button key={l.id} type="button" onClick={() => pickLine(l)}
                className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-[12.5px] hover:border-toyotared dark:border-navy-700">
                <span className="font-semibold text-slate-900 dark:text-white">{l.grn_no}</span>
                <span className="ml-2 text-slate-500">{fmtDate(l.grn_date)} · {l.ven_name}</span>
                <span className={`badge ml-2 ${KIND_PILL[l.suggested_kind]}`}>{l.suggested_kind === "LINE" ? "Store entry · line rejection" : "SRV rejection"}</span>
                <span className="block text-[11px] text-slate-400">
                  <b className="font-mono text-slate-600 dark:text-slate-300">{l.part_no}</b> {l.item_desc} · challan {l.challan_no || "—"} · received {num(l.receipt_qty)} {l.uom}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === "erp" && line && (
        <div className="flex items-start justify-between gap-2 rounded-lg bg-slate-50 p-3 text-[12.5px] dark:bg-navy-950/40">
          <div>
            <div className="font-semibold text-slate-900 dark:text-white">{line.ven_name}</div>
            <div className="text-slate-500">GRN {line.grn_no} · {fmtDate(line.grn_date)} · challan {line.challan_no || "—"} · PO {line.po_no || "—"}</div>
            <div className="text-slate-500"><b className="font-mono">{line.part_no}</b> {line.item_desc} · received {num(line.receipt_qty)} {line.uom}</div>
          </div>
          <button type="button" className="text-[12px] font-semibold text-toyotared" onClick={() => setLine(null)}>Change</button>
        </div>
      )}

      {mode === "typed" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Part" required>
              {part ? (
                <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-[12.5px] dark:border-navy-700">
                  <span><b className="font-mono">{part.part_no}</b> {part.part_name}</span>
                  <button type="button" className="text-[12px] font-semibold text-toyotared" onClick={() => { setPart(null); setText(""); }}>Change</button>
                </div>
              ) : (
                <div className="relative">
                  <input className={inputCls(false, "w-full")} value={text} onChange={(e) => setText(e.target.value)} placeholder="Part No. or description…" />
                  {found.length >= 2 && (
                    <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-cardHover dark:border-navy-700 dark:bg-navy-900">
                      {(parts.data || []).map((p) => (
                        <button key={p.id} type="button" onClick={() => setPart(p)} className="block w-full px-3 py-2 text-left text-[12.5px] hover:bg-slate-50 dark:hover:bg-navy-800">
                          <b className="font-mono">{p.part_no}</b> <span className="text-slate-500">{p.part_name}</span>
                        </button>
                      ))}
                      {parts.data && parts.data.length === 0 && <p className="px-3 py-2 text-[12px] text-slate-400">No part found.</p>}
                    </div>
                  )}
                </div>
              )}
            </Field>
          </div>
          <Field label="Supplier" required><input className={inputCls(false, "w-full")} maxLength={160} value={f.ven_name} onChange={set("ven_name")} /></Field>
          <Field label="GRN No." hint="GRN or challan no. — at least one"><input className={inputCls(false, "w-full")} maxLength={60} value={f.grn_no} onChange={set("grn_no")} /></Field>
          <Field label="GRN date"><input type="date" className={inputCls(false, "w-full")} value={f.grn_date} onChange={set("grn_date")} /></Field>
          <Field label="Challan No."><input className={inputCls(false, "w-full")} maxLength={60} value={f.challan_no} onChange={set("challan_no")} /></Field>
          <Field label="Challan date"><input type="date" className={inputCls(false, "w-full")} value={f.challan_date} onChange={set("challan_date")} /></Field>
        </div>
      )}

      {(line || mode === "typed") && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind" required hint={line ? (line.suggested_kind === "LINE" ? "The GRN is a store entry — a line rejection" : "The GRN awaits quality — an SRV rejection (made in SRV finished)") : undefined}>
            <select className={inputCls(false, "w-full")} value={f.kind} onChange={set("kind")}>
              <option value="SRV">SRV rejection</option>
              <option value="LINE">Line rejection</option>
            </select>
          </Field>
          <Field label="Rejected qty" required hint={line ? `${num(line.receipt_qty)} ${line.uom} received` : undefined}>
            <input type="number" min="0" step="0.01" className={inputCls(false, "w-full")} value={f.qty} onChange={set("qty")} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Reason / remark" required hint='As it goes in the mail — e.g. "Bin received green colour"'>
              <input className={inputCls(false, "w-full")} maxLength={255} value={f.remark} onChange={set("remark")} />
            </Field>
          </div>
          <Field label="PO No."><input className={inputCls(false, "w-full")} maxLength={60} value={f.po_no} onChange={set("po_no")} /></Field>
          <Field label="PO date" hint="Not in the ERP data — fill it for the mail"><input type="date" className={inputCls(false, "w-full")} value={f.po_date} onChange={set("po_date")} /></Field>
          <Field label="HSN" hint="Not in the ERP data — fill it for the mail"><input className={inputCls(false, "w-full")} maxLength={20} value={f.hsn} onChange={set("hsn")} /></Field>
          <div className="flex items-end justify-end">
            <button type="button" className="btn-primary" onClick={make} disabled={!ready || saving}>
              <Mail size={15} aria-hidden="true" /> {saving ? "Making…" : "Open mail in Outlook"}
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------ mail settings */

function MailSettings({ onClose }) {
  const q = useQuery({ queryKey: ["rejections", "settings"], queryFn: () => rejectionService.settings({ silent: true }).then((r) => r.data.data) });
  const [f, setF] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (q.data && !f) setF(q.data); }, [q.data, f]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const preview = useMemo(() => (f ? `Dear ${f.rqc_name || "Sir"} San — Please punch … rejection as per below details… ${f.transport_name ? `@${f.transport_name} San ` : ""}Please provide vehicle no. for e-Way Bill` : ""), [f]);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await rejectionService.saveSettings(f);
      toast.success("Mail settings saved");
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Rejection mail — who it goes to"
      footer={(
        <div className="flex w-full justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          <button type="button" className="btn-primary" onClick={save} disabled={saving || !f}>{saving ? "Saving…" : "Save"}</button>
        </div>
      )}>
      {!f ? <p className="text-sm text-slate-400">Loading…</p> : (
        <div className="grid gap-3">
          <Field label="To" hint="RQC — e-mail addresses, separated by commas"><input className={inputCls(false, "w-full")} value={f.to} onChange={set("to")} /></Field>
          <Field label="CC" hint="e.g. the store, the BOP / purchase team"><input className={inputCls(false, "w-full")} value={f.cc} onChange={set("cc")} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Greeting name (RQC)" hint='"Dear Rajesh San"'><input className={inputCls(false, "w-full")} maxLength={60} value={f.rqc_name} onChange={set("rqc_name")} /></Field>
            <Field label="Vehicle / e-Way bill person" hint='"@Harjeet Singh San"'><input className={inputCls(false, "w-full")} maxLength={60} value={f.transport_name} onChange={set("transport_name")} /></Field>
          </div>
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11.5px] text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">{preview}</p>
        </div>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700">{error}</p>}
    </Modal>
  );
}
