import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Ban, Link2, RotateCcw, Search, TriangleAlert, WifiOff, X, XCircle } from "lucide-react";
import PartSearch from "./PartSearch.jsx";
import { useConfirm } from "../ConfirmDialog.jsx";
import { barcodeService } from "../../services/barcodeService.js";

// What a code that did NOT identify a part shows, in place of the part card —
// so a failed read can never leave the previous part on screen to be issued.
// The server says why in errors.result (BarcodeService.resolve); each reason
// gets its own words and only the actions that can help (spec 5):
//   UNKNOWN_BARCODE  not a Part No. here, not mapped  -> Map to Part / Search / Cancel
//   INACTIVE_BARCODE a mapping that was switched off  -> Search / Cancel
//   OTHER_STORE      a part of another store          -> Search / Cancel
//   INACTIVE_PART    the part is deactivated          -> Cancel
//   FAILED           nothing came through             -> Cancel
//   CODE_TOO_LONG    longer than any label or mapping -> Search / Cancel
//   NETWORK          no answer from the server        -> Try again / Cancel
// (NETWORK / NOT_FOUND / ERROR are the workstation's own names for a failure
// that carried no errors.result.)
const COPY = {
  UNKNOWN_BARCODE: {
    tone: "amber", icon: TriangleAlert, title: "Unknown Supplier Barcode",
    sub: "Not a Part No. of this store and not mapped yet",
    search: true,
  },
  INACTIVE_BARCODE: {
    tone: "amber", icon: Ban, title: "Barcode Deactivated",
    sub: "This code was mapped to a part, but the mapping has been switched off (damaged or retired label). A supervisor can switch it back on in that part's Barcodes panel — search the Part No. to open it.",
    search: true,
  },
  OTHER_STORE: {
    tone: "rose", icon: XCircle, title: "Not a Spare Parts Store Part",
    sub: "This code belongs to a part of another store — nothing was selected here.",
    search: true,
  },
  INACTIVE_PART: {
    tone: "rose", icon: Ban, title: "Part Inactive",
    sub: "An administrator must reactivate the part in Part Master before it can be issued, returned or labelled.",
  },
  FAILED: {
    tone: "rose", icon: XCircle, title: "Nothing Scanned",
    sub: "The scan came through empty. Scan the label again.",
  },
  // Longer than any Part No. or mapped supplier code can be (80 characters) —
  // so it can't be mapped either; usually two labels read in one burst.
  CODE_TOO_LONG: {
    tone: "rose", icon: XCircle, title: "Code Too Long",
    sub: "Longer than any DX Store label or mapped supplier barcode — scan one label at a time. Nothing was selected.",
    search: true,
  },
  NETWORK: {
    tone: "rose", icon: WifiOff, title: "No Answer From the Server",
    sub: "The part could not be looked up — check the network and try again. Nothing was selected.",
    retry: true,
  },
  NOT_FOUND: {
    tone: "rose", icon: XCircle, title: "Not Found",
    sub: "No part of this store was found for this code. Nothing was selected.",
    search: true,
  },
  // Any other refusal (no access to the store, a server fault) — the server's
  // message below says which.
  ERROR: {
    tone: "rose", icon: XCircle, title: "Could Not Identify the Part",
    sub: "The lookup was refused. Nothing was selected.",
    retry: true, search: true,
  },
};

const TONES = {
  amber: {
    box: "border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10",
    icon: "text-amber-600 dark:text-amber-400", title: "text-amber-900 dark:text-amber-100",
    text: "text-amber-800 dark:text-amber-200", dot: "bg-amber-500",
  },
  rose: {
    box: "border-rose-300 bg-rose-50 dark:border-rose-500/40 dark:bg-rose-500/10",
    icon: "text-rose-600 dark:text-rose-400", title: "text-rose-900 dark:text-rose-100",
    text: "text-rose-700 dark:text-rose-300", dot: "bg-rose-500",
  },
};

/**
 * failure   { code, result, message }
 * canMap    useCan("supplier_barcodes", "create")
 * onMapped  called once a mapping is saved — the workstation re-resolves the
 *           same code, which now identifies the part (spec 6)
 */
// The fields of a supplier QR, as the server splits them (barcode_service
// scan_fields): on | , ; # tab / newline and spaces, fields under 3 characters
// (a qty, a unit) dropped. Only one that fits a mapping (80) is offered.
const fieldsOf = (code) => {
  const out = [];
  for (const piece of String(code || "").split(/[|,;#\t\r\n ]+/)) {
    const f = piece.trim();
    if (f.length >= 3 && f.length <= 80 && !out.includes(f)) out.push(f);
  }
  return out;
};

export default function ScanFailurePanel({ failure, canMap, storeCode, onSearch, onCancel, onRetry, onMapped }) {
  const confirm = useConfirm();
  const [mapping, setMapping] = useState(false);
  const [saving, setSaving] = useState(false);
  const copy = COPY[failure.result] || COPY.NOT_FOUND;
  const tone = TONES[copy.tone];
  const unknown = failure.result === "UNKNOWN_BARCODE";
  // A supplier QR carries its item code among lot / qty / date, which change
  // every lot: mapping the whole read would never match the next lot, so the
  // ITEM field is mapped (the store, 22 Oct 2026). A one-field code maps whole.
  const fields = fieldsOf(failure.code);
  const multi = fields.length > 1 || (fields.length === 1 && fields[0] !== String(failure.code || "").trim());
  const [mapCode, setMapCode] = useState(multi ? fields[0] : failure.code);
  useEffect(() => { setMapCode(multi ? fields[0] : failure.code); }, [failure.code]); // eslint-disable-line react-hooks/exhaustive-deps

  const mapTo = async (p) => {
    const ok = await confirm({
      title: "Map supplier barcode",
      message: `Map ${mapCode} → ${p.part_no}${p.part_name ? ` (${p.part_name})` : ""}? After this, scanning ${multi ? "any of this supplier's labels with this item code" : mapCode} identifies ${p.part_no} straight away.`,
      confirmText: "Map to Part",
      danger: false,
    });
    if (!ok) return;
    setSaving(true);
    try {
      // The label's symbology is not known from a keyboard-wedge read, so it
      // is recorded as OTHER rather than guessed.
      await barcodeService.createMapping({ part_id: p.part_id, code: mapCode, symbology: "OTHER" });
      toast.success(`${mapCode} mapped to ${p.part_no}`);
      setMapping(false);
      await onMapped?.();
    } catch {
      /* the interceptor toasts the server's reason (e.g. already mapped) */
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`rounded-xl2 border p-4 ${tone.box}`} aria-label={copy.title}>
      <div className="flex items-start gap-3">
        <copy.icon size={28} className={`mt-0.5 shrink-0 ${tone.icon}`} aria-hidden="true" />
        <div role="alert" className="min-w-0 flex-1">
          <p className={`flex items-center gap-2 text-base font-bold ${tone.title}`}>
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
            {copy.title}
          </p>
          {failure.code && (
            <p className={`mt-1 break-all font-mono text-lg font-semibold ${tone.title}`}>{failure.code}</p>
          )}
          <p className={`mt-1 text-sm ${tone.text}`}>{copy.sub}</p>
          {/* The server's own words where they add something (e.g. which part is inactive). */}
          {failure.message && !unknown && failure.result !== "NETWORK" && (
            <p className={`mt-0.5 text-xs ${tone.text} opacity-80`}>{failure.message}</p>
          )}
          {unknown && !canMap && (
            <p className={`mt-2 text-sm font-semibold ${tone.text}`}>Ask a supervisor to map this code to its part.</p>
          )}
        </div>
        <button type="button" onClick={onCancel} aria-label="Dismiss"
          className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-white/60 hover:text-slate-600 dark:hover:bg-navy-800 dark:hover:text-slate-200">
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      {mapping ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-white p-3 dark:border-amber-500/30 dark:bg-navy-900">
          {multi && (
            <div className="mb-3">
              <p className="mb-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
                This label has several codes — tap the supplier's <b>item code</b>:
              </p>
              <p className="mb-2 text-[11px] text-slate-500 dark:text-slate-400">
                Lot no., qty and date change every delivery; only the item code stays the same.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {fields.map((f) => (
                  <button key={f} type="button" onClick={() => setMapCode(f)}
                    className={`rounded-lg border px-2.5 py-1 font-mono text-sm ${mapCode === f
                      ? "border-toyotared bg-toyotared/10 font-bold text-toyotared"
                      : "border-slate-200 text-slate-600 hover:border-slate-300 dark:border-navy-700 dark:text-slate-300"}`}>
                    {f}
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Which part of this store is <span className="font-mono">{mapCode}</span>?
          </p>
          <PartSearch storeCode={storeCode} onPick={mapTo} busy={saving} clearOnPick={false}
            label="Part to map this barcode to" placeholder="Search the Part No. this barcode belongs to…" />
          <div className="mt-3 flex justify-end">
            <button type="button" className="btn-secondary" onClick={() => setMapping(false)} disabled={saving}>Back</button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {unknown && canMap && (
            <button type="button" className="btn-primary" onClick={() => setMapping(true)}>
              <Link2 size={16} aria-hidden="true" />Map to Part
            </button>
          )}
          {copy.retry && (
            <button type="button" className="btn-primary" onClick={onRetry}>
              <RotateCcw size={16} aria-hidden="true" />Try again
            </button>
          )}
          {copy.search && (
            <button type="button" className="btn-secondary" onClick={onSearch}>
              <Search size={16} aria-hidden="true" />Search Part No.
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
      )}
    </section>
  );
}
