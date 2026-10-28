import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { CheckCircle2, Package, Printer } from "lucide-react";
import Modal from "../Modal.jsx";
import { inputCls } from "../scan/forms/flow.js";
import { fmtDate, num } from "../../lib/format.js";
import { barcodeService } from "../../services/barcodeService.js";
import { packetService } from "../../services/packetService.js";
import { printLabels } from "../../utils/barcodeRender.js";
import { LABEL_LIMITS, LABEL_SIZES, labelTier, packetLabelsHtml } from "../../utils/packetLabels.js";

// The Packets & QR Labels dialogs (the store's spec of 27 Oct 2026): verify a
// receipt physically, make its packets / unit labels (or label old stock on the
// shelf, or take the supplier's own box labels), print or reprint them, and
// cancel one made by mistake.
// None of them changes stock — only issuing a packet does (Scan Part).

export const errText = (e) => e?.response?.data?.message || e?.message || "Something went wrong";

function Field({ label, required, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-semibold text-slate-600 dark:text-slate-300">{label}{required && <span className="text-toyotared"> *</span>}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

function Fact({ label, children }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-[13.5px] font-semibold text-slate-800 dark:text-slate-100">{children}</p>
    </div>
  );
}

function ReceiptFacts({ r }) {
  return (
    <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3 dark:bg-navy-950/40 sm:grid-cols-4">
      <Fact label="Part">{r.part.part_no}</Fact>
      <Fact label="Received">{num(r.qty)} {r.uom}</Fact>
      <Fact label="Received on">{fmtDate(r.received_on)}</Fact>
      <Fact label="GRN / Gate entry">{r.grn_no || (r.source === "OPENING" ? "Shelf stock" : "—")}{r.gate_entry_no ? ` · ${r.gate_entry_no}` : ""}</Fact>
      <p className="col-span-full -mt-1 truncate text-[12px] text-slate-500" title={r.part.part_name}>{r.part.part_name}</p>
    </div>
  );
}

function Shell({ title, onClose, footer, children, size = "md" }) {
  return (
    <Modal open onClose={onClose} title={title} size={size}
      footer={<div className="flex w-full flex-wrap justify-end gap-2">{footer}</div>}>
      <div className="space-y-4">{children}</div>
    </Modal>
  );
}

// ---- physical verification -------------------------------------------------------------

export function VerifyDialog({ receipt, onClose, onDone }) {
  const [counted, setCounted] = useState(String(receipt.verified_qty ?? receipt.qty));
  const [remarks, setRemarks] = useState(receipt.verify_remarks || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mismatch = counted !== "" && Number(counted) !== Number(receipt.qty);
  const why = counted === "" || Number.isNaN(Number(counted)) || Number(counted) < 0 ? "Enter the quantity counted"
    : mismatch && !remarks.trim() ? `Counted ${counted} but ${receipt.qty} was received — say why` : null;
  const save = async () => {
    if (why) return;
    setBusy(true);
    setError(null);
    try {
      const r = await packetService.verify(receipt.id, { counted_qty: Number(counted), remarks: remarks.trim() || undefined });
      toast.success(r.data.message);
      onDone(r.data.data);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Physical verification" onClose={onClose}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        <button type="button" className="btn-primary" onClick={save} disabled={Boolean(why) || busy}>
          <CheckCircle2 size={15} aria-hidden="true" /> {busy ? "Saving…" : mismatch ? "Save mismatch" : "Verified"}
        </button>
      </>}>
      <ReceiptFacts r={receipt} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Quantity counted" required hint={`Received: ${num(receipt.qty)} ${receipt.uom || ""}`}>
          <input type="number" min="0" step="any" inputMode="decimal" className={inputCls(false, "w-full text-lg font-semibold")}
            value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus />
        </Field>
        <Field label="Remarks" required={mismatch} hint={mismatch ? "Needed when the count differs" : "Optional"}>
          <input className={inputCls(false, "w-full")} maxLength={255} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>
      </div>
      <p className="text-[12px] text-slate-500 dark:text-slate-400">
        Labels can be made only for what is counted here. Verifying does not change stock — it came in when ERP accepted the GRN.
      </p>
      {(error || (why && counted !== "")) && <p role="alert" className={`rounded-lg px-3 py-2 text-[12.5px] ${error ? "bg-rose-50 text-rose-700" : "bg-slate-50 text-slate-500 dark:bg-navy-950/40"}`}>{error || why}</p>}
    </Shell>
  );
}

// ---- make packets / unit labels ----------------------------------------------------------
//
// For a receipt (`receipt`), or for old stock on the shelf (`old`: a row of the
// Old stock list — the count on the shelf is asked, and it is packed as an
// opening batch). The labels are ours (printed next), or — the store, 27 Oct
// 2026: "supplier k part par agar already qr ya bar code aa rha h to uska hum qr
// label nhi nikalenge" — the supplier's own label already on each box: its code
// is scanned box by box and the box becomes that packet. If the code is the
// same on every box, a box cannot be told apart: the code is mapped to the part
// instead and the stock stays loose (issued by scanning it with a quantity).

function OldFacts({ row }) {
  return (
    <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3 dark:bg-navy-950/40 sm:grid-cols-4">
      <Fact label="Part">{row.part.part_no}</Fact>
      <Fact label="Location">{row.part.location || "—"}</Fact>
      <Fact label="On hand">{num(row.on_hand)} {row.part.uom}</Fact>
      <Fact label="Without a label">{num(row.to_label)} {row.part.uom}</Fact>
      <p className="col-span-full -mt-1 truncate text-[12px] text-slate-500" title={row.part.part_name}>{row.part.part_name}</p>
    </div>
  );
}

function Choice({ options, value, onChange }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map(([k, title, sub]) => (
        <button key={k} type="button" onClick={() => onChange(k)} aria-pressed={value === k}
          className={`rounded-xl border-2 p-3 text-left transition ${value === k ? "border-toyotared bg-toyotared/5" : "border-slate-200 hover:border-slate-300 dark:border-navy-700"}`}>
          <span className="block text-[14px] font-bold text-slate-800 dark:text-white">{title}</span>
          <span className="block text-[12px] text-slate-500">{sub}</span>
        </button>
      ))}
    </div>
  );
}

// The supplier's code read off each box, one per packet, checked as it is scanned.
function BoxCodes({ partId, need, boxes, setBoxes, onSame }) {
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState(null);
  const [checking, setChecking] = useState(false);
  const add = async () => {
    const code = typed.trim();
    if (!code || checking) return;
    setNote(null);
    if (boxes.includes(code)) {
      setNote({ same: true, code, text: `Box ${boxes.indexOf(code) + 1} has this same code — the supplier's code is the same on every box, so a box cannot be told apart.` });
      setTyped("");
      return;
    }
    setChecking(true);
    try {
      const r = (await packetService.boxCode(partId, code, { silent: true })).data.data;
      if (r.ok) setBoxes([...boxes, code]);
      else setNote({ same: r.same, code, text: r.message, fields: r.fields });
    } catch (e) {
      setNote({ text: errText(e) });
    } finally {
      setChecking(false);
      setTyped("");
    }
  };
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-navy-700">
      <Field label={`Scan the supplier's code on each box (${boxes.length} of ${need ?? "—"})`} required
        hint="Gun or keyboard: scan, then Enter. One box = one packet, in order.">
        <input className={inputCls(false, "w-full font-mono")} value={typed} onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          disabled={need != null && boxes.length >= need} placeholder={checking ? "Checking…" : "Scan box code"} autoFocus />
      </Field>
      {boxes.length > 0 && (
        <ol className="max-h-40 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-100 text-[12.5px] dark:divide-navy-800 dark:border-navy-800">
          {boxes.map((c, i) => (
            <li key={c} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
              <span className="min-w-0 truncate"><b className="mr-2 text-slate-400">Box {i + 1}</b><span className="font-mono">{c}</span></span>
              <button type="button" className="shrink-0 text-[11px] text-rose-600 hover:underline" onClick={() => setBoxes(boxes.filter((x) => x !== c))}>Remove</button>
            </li>
          ))}
        </ol>
      )}
      {need != null && boxes.length > need && <p className="text-[12px] text-amber-700">{boxes.length - need} more code{boxes.length - need === 1 ? "" : "s"} than packets — remove the extra.</p>}
      {note && (
        <div role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          <p>{note.text}</p>
          {note.same && (
            <button type="button" className="mt-1.5 font-semibold text-toyotared hover:underline" onClick={() => onSame(note.code, note.fields)}>
              Same code on every box — map it to the part and keep the stock loose →
            </button>
          )}
        </div>
      )}
      <button type="button" className="text-[12px] text-slate-500 hover:underline" onClick={() => onSame(null)}>
        The code is the same on every box
      </button>
    </div>
  );
}

// The supplier's code is the same on every box: map it to the part (its item
// code picked out of a QR of several fields); the stock stays loose.
function KeepLoose({ part, receiptId, first, onBack, onDone }) {
  const [typed, setTyped] = useState(first?.code || "");
  const [fields, setFields] = useState(first?.fields || null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const code = typed.trim();
  const several = (fields || []).length > 1;
  const save = async () => {
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      const r = await packetService.keepLoose(part.id, { code, map_code: pick || undefined, receipt_id: receiptId });
      toast.success(r.data.message);
      onDone(r.data.data);
    } catch (e) {
      const errs = e?.response?.data?.errors;
      if (errs?.fields) setFields(errs.fields);
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-xl border-2 border-amber-300 bg-amber-50/40 p-3 dark:border-amber-500/40 dark:bg-amber-500/5">
      <p className="text-[13px] font-semibold text-slate-800 dark:text-white">Same supplier code on every box</p>
      <p className="text-[12px] text-slate-600 dark:text-slate-300">
        The code is mapped to {part.part_no}, so scanning it on Scan Part names the part. No label is made and the stock stays loose —
        it is issued by scanning the code and entering the quantity (no FIFO between the boxes).
      </p>
      <Field label="Supplier's code" required>
        <input className={inputCls(false, "w-full font-mono")} value={typed} autoFocus={!first}
          onChange={(e) => { setTyped(e.target.value); setFields(null); setPick(""); }} placeholder="Scan one box" />
      </Field>
      {several && (
        <div>
          <p className="mb-1 text-[12px] font-semibold text-slate-600 dark:text-slate-300">Which part of the code is the item code? <span className="font-normal text-slate-400">(lot / qty change box to box)</span></p>
          <div className="flex flex-wrap gap-1.5">
            {fields.map((f) => (
              <button key={f} type="button" onClick={() => setPick(f)} aria-pressed={pick === f}
                className={`rounded-full border px-2.5 py-1 font-mono text-[12px] ${pick === f ? "border-toyotared bg-toyotared/10 text-toyotared" : "border-slate-200 text-slate-600 dark:border-navy-700 dark:text-slate-300"}`}>
                {f}
              </button>
            ))}
          </div>
        </div>
      )}
      {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-secondary py-1.5 text-[12.5px]" onClick={onBack}>Back</button>
        <button type="button" className="btn-primary py-1.5 text-[12.5px]" onClick={save} disabled={!code || (several && !pick) || busy}>
          {busy ? "Mapping…" : "Map code, keep stock loose"}
        </button>
      </div>
    </div>
  );
}

export function MakeLabelsDialog({ receipt, old, onClose, onMade, onKeptLoose }) {
  const part = receipt ? receipt.part : old.part;
  const unit = (receipt ? receipt.uom : old.part.uom) || "";
  const [kind, setKind] = useState("PACKET");
  const [size, setSize] = useState("");
  const [count, setCount] = useState("");
  const [counted, setCounted] = useState("");
  const [lastSmaller, setLastSmaller] = useState(false);
  const [labels, setLabels] = useState("OURS");          // OURS | SUPPLIER
  const [boxes, setBoxes] = useState([]);
  const [same, setSame] = useState(null);               // { code, fields } while mapping a same-on-every-box code
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const args = useMemo(() => ({
    kind, packet_qty: kind === "PACKET" ? Number(size) || undefined : undefined,
    last_smaller: kind === "PACKET" && lastSmaller,
    ...(receipt ? { count: count === "" ? undefined : Number(count) } : { counted_qty: Number(counted) || undefined }),
  }), [kind, size, count, counted, lastSmaller, receipt]);
  const ready = (kind === "UNIT" || Number(size) > 0) && (Boolean(receipt) || Number(counted) > 0);
  const [asked, setAsked] = useState(args);
  useEffect(() => { const t = setTimeout(() => setAsked(args), 300); return () => clearTimeout(t); }, [args]);
  const plan = useQuery({
    queryKey: ["packets", "plan", receipt ? `r${receipt.id}` : `p${part.id}`, asked],
    queryFn: () => (receipt ? packetService.plan(receipt.id, asked, { silent: true })
      : packetService.oldStockPlan(part.id, asked, { silent: true })).then((r) => r.data.data),
    enabled: ready && (Boolean(receipt) || Number(asked.counted_qty) > 0),
    retry: false,
  });
  const p = plan.data;
  const supplier = labels === "SUPPLIER";
  // How a label will print, before any is made (28 Oct 2026: "lable printing
  // me preview ka option bhi hona chahiye"): a sample code — each real label
  // gets its own — at the size picked here, which the print step keeps.
  const ls = useLabelSize();
  const sampleQty = kind === "UNIT" ? 1 : Number(size) || 0;
  const sample = useMemo(() => packetLabelsHtml([{
    code: "SPK-SAMPLE01", kind, qty: sampleQty, uom: unit, location: part.location, part,
  }], { size: ls.size }), [kind, sampleQty, unit, part, ls.size.w, ls.size.h]); // eslint-disable-line react-hooks/exhaustive-deps
  const boxesOk = !supplier || (p && boxes.length === p.count);
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...args, supplier_codes: supplier ? boxes : undefined };
      const r = await (receipt ? packetService.pack(receipt.id, body) : packetService.oldStockPack(part.id, body));
      toast.success(r.data.message);
      onMade(r.data.data);
    } catch (e) {
      const errs = e?.response?.data?.errors;
      if (errs?.code === "SAME_CODE") setSame({ code: errs.scanned, fields: errs.fields });
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const short = !receipt && Number(counted) > 0 && Number(counted) < Number(old.to_label);
  return (
    <Shell title={receipt ? "Make QR labels" : "Label old stock"} onClose={onClose} size="xl"
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        {!same && (
          <button type="button" className="btn-primary" onClick={make} disabled={!ready || !p || plan.isError || !boxesOk || busy}>
            <Package size={15} aria-hidden="true" /> {busy ? "Making…" : !p ? "Make labels"
              : supplier ? `Make ${p.count} packet${p.count === 1 ? "" : "s"} — no printing`
                : `Make ${p.count} label${p.count === 1 ? "" : "s"}`}
          </button>
        )}
      </>}>
      {receipt ? <ReceiptFacts r={receipt} /> : <OldFacts row={old} />}
      {!receipt && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Counted on the shelf" required hint={`The app has ${num(old.to_label)} ${unit} without a label`}>
            <span className="flex gap-2">
              <input type="number" min="0" step="any" inputMode="decimal" className={inputCls(false, "w-full text-lg font-semibold")}
                value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus placeholder="Count it" />
              <button type="button" className="btn-secondary shrink-0 px-2.5 text-[12px]" onClick={() => setCounted(String(old.to_label))}>Same as app</button>
            </span>
          </Field>
          {short && (
            <p className="self-end rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
              {num(Number(old.to_label) - Number(counted))} {unit} stays without a label. If the shelf really holds less than the app, put the stock right (stock count).
            </p>
          )}
        </div>
      )}
      <Choice value={kind} onChange={setKind} options={[
        ["PACKET", "Small parts packet", "Nuts, bolts, washers … many in one packet, one QR"],
        ["UNIT", "Individual part", "Each piece its own QR"]]} />
      <div className="grid gap-3 sm:grid-cols-3">
        {kind === "PACKET" && (
          <Field label="Quantity per packet" required hint="Any number — not fixed">
            <input type="number" min="0" step="any" inputMode="decimal" className={inputCls(false, "w-full text-lg font-semibold")}
              value={size} onChange={(e) => setSize(e.target.value)} autoFocus={Boolean(receipt)} placeholder="e.g. 20" />
          </Field>
        )}
        {receipt && (
          <Field label={kind === "PACKET" ? "Number of packets" : "Number of labels"} hint="Blank = all that fit">
            <input type="number" min="1" step="1" inputMode="numeric" className={inputCls(false, "w-full")}
              value={count} onChange={(e) => setCount(e.target.value)} placeholder={p ? String(p.count - (p.last_qty ? 1 : 0)) : ""} />
          </Field>
        )}
        {kind === "PACKET" && (
          <label className="flex items-center gap-2 self-end pb-2 text-[13px] text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={lastSmaller} onChange={(e) => setLastSmaller(e.target.checked)} />
            Make a smaller last packet of what is left
          </label>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 p-3 dark:border-navy-700 sm:grid-cols-4">
        <Fact label={receipt ? "Left to pack" : "Counted"}>{p ? `${num(p.packable)} ${unit}` : receipt ? `${num(receipt.to_pack)} ${unit}` : "—"}</Fact>
        <Fact label={kind === "PACKET" ? "Packets" : "Labels"}>{p ? `${p.count}${p.last_qty ? ` (last of ${num(p.last_qty)})` : ""}` : "—"}</Fact>
        <Fact label="Packed now">{p ? `${num(p.total)} ${unit}` : "—"}</Fact>
        <Fact label="Stays loose">{p ? `${num(p.loose_after)} ${unit}` : "—"}</Fact>
      </div>
      <Choice value={labels} onChange={(v) => { setLabels(v); setSame(null); }} options={[
        ["OURS", "Print our QR labels", "One label per packet, printed next"],
        ["SUPPLIER", "Supplier's label is on the box", "No printing — scan each box's own QR / barcode"]]} />
      {!supplier && (
        <div className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-navy-700">
          <p className="text-[12px] font-bold uppercase tracking-wider text-slate-400">Label preview</p>
          <LabelSizePicker ls={ls} />
          {sampleQty > 0 ? (
            <>
              <LabelPreview html={sample} size={ls.size} sizeOk={ls.sizeOk} />
              <p className="text-[11.5px] text-slate-500 dark:text-slate-400">A sample — each label gets its own QR code. The size picked here is the one the print step uses.</p>
            </>
          ) : <p className="text-[12px] text-slate-500 dark:text-slate-400">Enter the quantity per packet to see the label.</p>}
        </div>
      )}
      {supplier && (same ? (
        <KeepLoose part={part} receiptId={receipt?.id} first={same.code ? same : null} onBack={() => setSame(null)}
          onDone={(out) => onKeptLoose?.(out)} />
      ) : (
        <BoxCodes partId={part.id} need={p ? p.count : null} boxes={boxes} setBoxes={setBoxes}
          onSame={(code, fields) => setSame({ code, fields })} />
      ))}
      {plan.isError && ready && <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">{errText(plan.error)}</p>}
      {error && !same && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700">{error}</p>}
      <p className="text-[12px] text-slate-500 dark:text-slate-400">
        {supplier ? "Each box scans as its own packet — oldest first, issued whole, once." : "Each label gets its own QR code."} Making labels never changes stock.
      </p>
    </Shell>
  );
}

// ---- print / reprint -----------------------------------------------------------------------

// The label size picked last on this terminal: a preset key, "PRINTER" (the
// label printer's own size) or "CUSTOM" with its mm (28 Oct 2026: "size chote
// part and bade part k according adjustable hona chahiye a4 paper par nhi
// nikalenge" — labels go on the label printer only, never an A4 sheet). Picked
// on the make-labels dialog's preview or the print dialog, the same either way.
const SIZE_KEY = "dx_packet_label_size";
const TIER_WORDS = { FULL: "every line", MID: "description on one line", SMALL: "Part No., spec / model, location" };

function savedSize() {
  try { return JSON.parse(localStorage.getItem(SIZE_KEY)) || { key: "PRINTER" }; } catch { return { key: "PRINTER" }; }
}

function useLabelSize() {
  const [choice, setChoice] = useState(savedSize);
  const config = useQuery({
    queryKey: ["barcode", "label-config"],
    queryFn: () => barcodeService.labelConfig().then((r) => r.data.data),
    staleTime: 5 * 60 * 1000,
  });
  const printerSize = { w: Number(config.data?.width_mm) || 100, h: Number(config.data?.height_mm) || 50 };
  const size = choice.key === "CUSTOM" ? { w: Number(choice.w) || 0, h: Number(choice.h) || 0 }
    : choice.key === "PRINTER" ? printerSize : (LABEL_SIZES.find((x) => x.key === choice.key) || printerSize);
  const sizeOk = size.w >= LABEL_LIMITS.minW && size.w <= LABEL_LIMITS.maxW
    && size.h >= LABEL_LIMITS.minH && size.h <= LABEL_LIMITS.maxH;
  const pick = (next) => {
    setChoice(next);
    try { localStorage.setItem(SIZE_KEY, JSON.stringify(next)); } catch { /* remembered for this visit only */ }
  };
  return { choice, pick, size, sizeOk, printerSize };
}

function LabelSizePicker({ ls }) {
  const { choice, pick, size, sizeOk, printerSize } = ls;
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-semibold text-slate-600 dark:text-slate-300">Label size — on the label printer</p>
      <div role="group" aria-label="Label size" className="flex flex-wrap items-center gap-2">
        {[{ key: "PRINTER", label: "Printer size", ...printerSize }, ...LABEL_SIZES, { key: "CUSTOM", label: "Custom" }].map((o) => {
          const on = choice.key === o.key;
          return (
            <button key={o.key} type="button" aria-pressed={on}
              onClick={() => pick(o.key === "CUSTOM" ? { key: "CUSTOM", w: choice.w || size.w, h: choice.h || size.h } : { key: o.key })}
              className={`rounded-lg border px-3 py-1.5 text-[13px] font-semibold ${on ? "border-toyotared bg-toyotared/5 text-toyotared" : "border-slate-200 text-slate-600 dark:border-navy-700 dark:text-slate-300"}`}>
              {o.label}{o.w ? <span className="ml-1 font-normal opacity-80">{o.w} × {o.h} mm</span> : null}
            </button>
          );
        })}
      </div>
      {choice.key === "CUSTOM" && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Field label="Width (mm)" hint={`${LABEL_LIMITS.minW} to ${LABEL_LIMITS.maxW}`}>
            <input type="number" inputMode="numeric" className={inputCls(false, "w-28")} value={choice.w ?? ""}
              onChange={(e) => pick({ ...choice, w: e.target.value })} />
          </Field>
          <Field label="Height (mm)" hint={`${LABEL_LIMITS.minH} to ${LABEL_LIMITS.maxH}`}>
            <input type="number" inputMode="numeric" className={inputCls(false, "w-28")} value={choice.h ?? ""}
              onChange={(e) => pick({ ...choice, h: e.target.value })} />
          </Field>
        </div>
      )}
      <p className="mt-1.5 text-[12px] text-slate-500 dark:text-slate-400">
        {sizeOk ? `${size.w} × ${size.h} mm — ${TIER_WORDS[labelTier(size.h)]}. Set the same size on the label printer.`
          : `Size must be ${LABEL_LIMITS.minW}–${LABEL_LIMITS.maxW} mm wide and ${LABEL_LIMITS.minH}–${LABEL_LIMITS.maxH} mm high.`}
      </p>
    </div>
  );
}

// One label as it will print, at the picked size.
function LabelPreview({ html, size, sizeOk }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-navy-700">
      <iframe title="Label preview" srcDoc={html} className="w-full bg-white"
        style={{ height: `${Math.min(420, Math.round((sizeOk ? size.h : 50) * 3.78) + 24)}px` }} />
    </div>
  );
}

export function PrintDialog({ packets, reprint = false, onClose, onDone }) {
  const ls = useLabelSize();
  const { size, sizeOk } = ls;
  const [reason, setReason] = useState("");
  const [step, setStep] = useState("SETUP");             // SETUP -> ASK (did it print?)
  const [busy, setBusy] = useState(false);
  const html = useMemo(() => packetLabelsHtml(packets, { size }), [packets, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo(() => packetLabelsHtml(packets.slice(0, 1), { size }), [packets, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps
  const print = () => {
    if ((reprint && !reason.trim()) || !sizeOk) return;
    printLabels(html);
    setStep("ASK");
  };
  const record = async () => {
    setBusy(true);
    try {
      await packetService.recordPrint(packets.map((p) => p.code), { reprint, reason: reason.trim() || undefined });
      toast.success(`${packets.length} label${packets.length === 1 ? "" : "s"} recorded`);
      onDone?.();
      onClose();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title={reprint ? "Reprint QR label" : `Print ${packets.length} QR label${packets.length === 1 ? "" : "s"}`} onClose={onClose} size="xl"
      footer={step === "ASK" ? <>
        <button type="button" className="btn-secondary" onClick={() => setStep("SETUP")}>Not printed — try again</button>
        <button type="button" className="btn-primary" onClick={record} disabled={busy}>
          <CheckCircle2 size={15} aria-hidden="true" /> {busy ? "Saving…" : "Yes, the labels printed"}
        </button>
      </> : <>
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        <button type="button" className="btn-primary" onClick={print} disabled={(reprint && !reason.trim()) || !sizeOk}>
          <Printer size={15} aria-hidden="true" /> Print
        </button>
      </>}>
      {step === "ASK" ? (
        <p className="text-[14px] text-slate-700 dark:text-slate-200">Did the {packets.length} label{packets.length === 1 ? "" : "s"} come out of the printer? Only then is the print recorded.</p>
      ) : (
        <>
          <LabelSizePicker ls={ls} />
          {reprint && (
            <Field label="Why print again" required hint="Torn, lost, faded … — kept with the print history">
              <input className={inputCls(false, "w-full")} maxLength={255} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </Field>
          )}
          <LabelPreview html={preview} size={size} sizeOk={sizeOk} />
          <p className="text-[12px] text-slate-500 dark:text-slate-400">The QR carries each packet's own code. No price is printed. Printing never adds stock.</p>
        </>
      )}
    </Shell>
  );
}

// ---- cancel ----------------------------------------------------------------------------------

export function CancelDialog({ packet, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const cancel = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await packetService.cancel(packet.code, reason.trim());
      toast.success(r.data.message);
      onDone?.();
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title={`Cancel packet ${packet.code}`} onClose={onClose}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>Keep it</button>
        <button type="button" className="btn-danger" onClick={cancel} disabled={!reason.trim() || busy}>{busy ? "Cancelling…" : "Cancel packet"}</button>
      </>}>
      <p className="text-[13px] text-slate-600 dark:text-slate-300">
        {packet.part?.part_no} · {num(packet.qty)} {packet.uom || ""} — its quantity becomes loose again and its label no longer
        scans as available. Remove the label from the packet. The code is never used again.
      </p>
      <Field label="Why" required hint="Packed by mistake, wrong quantity …">
        <input className={inputCls(false, "w-full")} maxLength={255} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
      {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700">{error}</p>}
    </Shell>
  );
}
