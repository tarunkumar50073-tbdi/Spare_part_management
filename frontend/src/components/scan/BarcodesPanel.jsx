import React, { useEffect, useId, useState } from "react";
import toast from "react-hot-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, LoaderCircle, Plus, Power, PowerOff, Star } from "lucide-react";
import { useCan } from "../Can.jsx";
import { useConfirm } from "../ConfirmDialog.jsx";
import { barcodeService } from "../../services/barcodeService.js";
import { supplierService } from "../../services/supplierService.js";
import { scanResultKey } from "../../hooks/useScanWorkstation.js";
import { fmtStamp } from "../../lib/format.js";
import { BARCODE_SOURCE } from "../../lib/scanStatus.js";
import { TONE_CHIP, scanIcon } from "./scanIcons.js";

// The part's barcodes, kept where the part is scanned (there is no separate
// Supplier Barcodes screen any more): its internal QR — which carries only the
// Part No. — and every supplier code mapped to it, active or switched off. A
// mapped supplier code identifies the part on a scan exactly like its own QR;
// the Part No. is never replaced, and a switched-off code stays listed as
// history (scanning it says "Barcode Deactivated").
//
// Anyone may look. Adding a code or switching one off / on needs the
// supplier_barcodes edit right (the server checks it too). A write answers with
// the part's fresh list, which goes straight into the cached scan result.
//
// part       scan.part
// barcodes   scan.barcodes — BarcodeService.list_part_barcodes, internal first
// defaultOpen  open on arrival; collapsed to one line otherwise (the default)
// onRelease  hands the caret back to the scanner gun after a click here

const CODE_MAX = 80; // part_barcodes.code — the longest code that can be mapped

// A supplier code the server answered for with a reason (duplicate, another
// part's Part No.) — or no answer, when it is not known whether it was saved.
const errorText = (e) => (e?.response
  ? e.response.data?.message || "The barcode was not saved."
  : "No answer from the server — check the list below before trying again.");

function BarcodeRow({ b, partNo, canEdit, busy, onToggle }) {
  const src = BARCODE_SOURCE[b.source] || { label: b.source, icon: "Barcode" };
  const Icon = scanIcon(src.icon);
  const internal = b.source === "INTERNAL";
  const what = internal
    ? `${b.symbology === "QR" ? "Internal QR" : `Internal barcode (${b.symbology || "—"})`} — the Part No.`
    : b.supplier_name || "Supplier not recorded";
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${b.is_active ? TONE_CHIP.info : TONE_CHIP.neutral}`}>
        <Icon size={15} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
          <span className={`break-all font-mono ${b.is_active ? "" : "text-slate-400 line-through decoration-slate-300"}`}>{b.code}</span>
          {b.is_primary && <Star size={13} className="fill-amber-400 text-amber-400" aria-label="Primary barcode" />}
          <span className={`badge ${b.is_active ? "badge-success" : "badge-neutral"}`}>{b.is_active ? "Active" : "Inactive"}</span>
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {internal ? what : <>{src.label} · {what}</>}
          {b.code === partNo && !internal && " · same as the Part No."}
        </p>
        {b.created_at && (
          <p className="text-[11px] text-slate-400">
            Added {fmtStamp(b.created_at)}{b.created_by ? ` by ${b.created_by}` : ""}
          </p>
        )}
      </div>
      {/* The internal QR cannot be switched off — it is the Part No. itself. */}
      {canEdit && !internal && (
        <button type="button" onClick={() => onToggle(b)} disabled={busy}
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded text-xs font-semibold text-toyotared hover:underline disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/40">
          {busy ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
            : b.is_active ? <PowerOff size={13} aria-hidden="true" /> : <Power size={13} aria-hidden="true" />}
          {b.is_active ? "Deactivate" : "Activate"}
        </button>
      )}
    </li>
  );
}

function AddBarcodeForm({ part, onSaved, onCancel }) {
  const [code, setCode] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const codeId = useId();
  const supplierFieldId = useId();
  const suppliers = useQuery({
    queryKey: ["suppliers", "all"],
    queryFn: () => supplierService.list({ per_page: 500 }).then((r) => r.data.data || []),
    staleTime: 5 * 60_000,
  });

  const save = async (e) => {
    e.preventDefault();
    const c = code.trim();
    if (!c || saving) return;
    setSaving(true);
    setError(null);
    try {
      // A keyboard-wedge read does not say which symbology the supplier's
      // label is, so it is recorded as OTHER rather than guessed.
      const res = await barcodeService.createMapping({
        part_id: part.id, code: c, symbology: "OTHER",
        supplier_id: supplierId ? Number(supplierId) : undefined,
      }, { silent: true });
      toast.success(`${c} mapped to ${part.part_no}`);
      onSaved(res.data.data);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  // data-scan-nofocus: a click in here must not pull the caret back to the
  // scan box, or the supplier's code would be read as the next part.
  return (
    <form onSubmit={save} data-scan-nofocus
      className="mt-3 space-y-3 rounded-lg border border-slate-200 p-3 dark:border-navy-700">
      <div className="space-y-1.5">
        <label htmlFor={codeId} className="kpi-label block">
          Supplier barcode <span className="text-toyotared">*</span>
        </label>
        {/* The gun ends its read with Enter; that must not save the code before
            the supplier is chosen, so only the Save button saves. */}
        <input id={codeId} value={code} autoFocus maxLength={CODE_MAX} autoComplete="off" spellCheck={false}
          onChange={(e) => { setCode(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
          disabled={saving} placeholder="Scan it with the gun, or type it as printed"
          className={`input-field h-11 font-mono text-base tracking-wide ${error ? "border-rose-400 dark:border-rose-500/60" : ""}`}
          aria-invalid={Boolean(error)} />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={supplierFieldId} className="kpi-label block">Supplier (optional)</label>
        <select id={supplierFieldId} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
          disabled={saving || suppliers.isPending} className="input-field">
          <option value="">{suppliers.isPending ? "Loading the supplier master…" : "Not recorded"}</option>
          {(suppliers.data || []).map((s) => (
            <option key={s.id} value={s.id}>{s.supplier_name}{s.vendor_code ? ` · ${s.vendor_code}` : ""}</option>
          ))}
        </select>
        {suppliers.isError && (
          <p className="text-[11px] text-rose-600 dark:text-rose-400">
            Couldn&apos;t load the supplier master — the code can still be saved without one.{" "}
            <button type="button" onClick={() => suppliers.refetch()} className="font-semibold underline underline-offset-2">Retry</button>
          </p>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      <p className="text-[11px] text-slate-500 dark:text-slate-400">
        Once saved, scanning this code identifies <b className="font-mono">{part.part_no}</b> straight away — the Part No. and its own QR stay as they are.
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving || !code.trim()}>
          {saving ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
          Save barcode
        </button>
      </div>
    </form>
  );
}

export default function BarcodesPanel({ part, barcodes, defaultOpen = false, onRelease }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const canEdit = useCan("supplier_barcodes", "edit");
  const bodyId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState(null);

  // Folded unless the caller opens it; a new part starts without a half-typed
  // code from the last one.
  useEffect(() => { setOpen(defaultOpen); }, [defaultOpen]);
  useEffect(() => { setAdding(false); }, [part.id]);

  const list = Array.isArray(barcodes) ? barcodes : null;
  const internal = list?.find((b) => b.source === "INTERNAL") || null;
  const supplierCodes = (list || []).filter((b) => b.source !== "INTERNAL");
  const off = supplierCodes.filter((b) => !b.is_active).length;
  const summary = list == null ? "" : [
    "QR",
    supplierCodes.length
      ? `${supplierCodes.length} supplier code${supplierCodes.length === 1 ? "" : "s"}${off ? ` (${off} off)` : ""}`
      : "no supplier code",
  ].join(" · ");

  // The write's answer is the fresh list — shown at once, without re-reading
  // the whole scan result.
  const showList = (fresh) => {
    if (Array.isArray(fresh)) {
      qc.setQueryData(scanResultKey(part.id), (old) => (old ? { ...old, barcodes: fresh } : old));
    }
  };

  const toggle = async (b) => {
    if (b.is_active) {
      const ok = await confirm({
        title: "Switch off this supplier barcode?",
        message: `After this, scanning ${b.code} no longer identifies ${part.part_no} — it says "Barcode Deactivated". It stays listed and can be switched on again.`,
        confirmText: "Deactivate",
      });
      if (!ok) { onRelease?.(); return; }
    }
    setBusyId(b.id);
    try {
      const res = await barcodeService.setMappingActive(b.id, !b.is_active);
      showList(res.data.data);
      toast.success(b.is_active ? `${b.code} switched off` : `${b.code} identifies ${part.part_no} again`);
    } catch {
      /* the interceptor toasts the server's reason */
    } finally {
      setBusyId(null);
      onRelease?.();
    }
  };

  return (
    <section className="card p-4" aria-label="Barcodes">
      <button type="button" aria-expanded={open} aria-controls={bodyId}
        onClick={() => { setOpen((o) => !o); onRelease?.(); }}
        className="flex w-full items-center justify-between gap-2 text-left">
        <span className="kpi-label">Barcodes</span>
        <span className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          {summary}
          <ChevronDown size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </span>
      </button>

      {open && (
        <div id={bodyId} className="mt-3">
          {list == null ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">The server did not send this part&apos;s barcode list.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-navy-800 dark:border-navy-700">
              {/* Every part has its QR (it is the Part No.); the server keeps a
                  row for it from the first label print on. */}
              {internal ? (
                <BarcodeRow b={internal} partNo={part.part_no} canEdit={false} />
              ) : (
                <BarcodeRow partNo={part.part_no} canEdit={false}
                  b={{ id: "qr", code: part.part_no, source: "INTERNAL", symbology: "QR", is_active: true }} />
              )}
              {supplierCodes.map((b) => (
                <BarcodeRow key={b.id} b={b} partNo={part.part_no} canEdit={canEdit}
                  busy={busyId === b.id} onToggle={toggle} />
              ))}
              {supplierCodes.length === 0 && (
                <li className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                  No supplier barcode is mapped to this part yet.
                </li>
              )}
            </ul>
          )}

          {!canEdit ? (
            <p className="mt-2.5 text-xs text-slate-500 dark:text-slate-400">
              Ask a supervisor to add a supplier barcode or switch one off.
            </p>
          ) : adding ? (
            <AddBarcodeForm part={part}
              onSaved={(fresh) => { showList(fresh); setAdding(false); onRelease?.(); }}
              onCancel={() => { setAdding(false); onRelease?.(); }} />
          ) : (
            <button type="button" onClick={() => setAdding(true)} className="btn-secondary mt-3 py-2">
              <Plus size={16} aria-hidden="true" />Add supplier barcode
            </button>
          )}
        </div>
      )}
    </section>
  );
}
