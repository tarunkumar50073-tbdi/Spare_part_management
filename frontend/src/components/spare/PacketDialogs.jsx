import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Boxes, CheckCircle2, Package, Printer, Search } from "lucide-react";
import Modal from "../Modal.jsx";
import { inputCls } from "../scan/forms/flow.js";
import { fmtDate, num } from "../../lib/format.js";
import { barcodeService } from "../../services/barcodeService.js";
import { packetService } from "../../services/packetService.js";
import { printLabels } from "../../utils/barcodeRender.js";
import { packetLabelsHtml } from "../../utils/packetLabels.js";

// The Packets & QR Labels dialogs (the store's spec of 27 Oct 2026): verify a
// receipt physically, make its packets / unit labels, print or reprint them,
// cancel one made by mistake, and make a batch of stock already on the shelf.
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

export function MakeLabelsDialog({ receipt, onClose, onMade }) {
  const [kind, setKind] = useState("PACKET");
  const [size, setSize] = useState("");
  const [count, setCount] = useState("");
  const [lastSmaller, setLastSmaller] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const args = useMemo(() => ({
    kind, packet_qty: kind === "PACKET" ? Number(size) || undefined : undefined,
    count: count === "" ? undefined : Number(count), last_smaller: kind === "PACKET" && lastSmaller,
  }), [kind, size, count, lastSmaller]);
  const ready = kind === "UNIT" || Number(size) > 0;
  const [asked, setAsked] = useState(args);
  useEffect(() => { const t = setTimeout(() => setAsked(args), 300); return () => clearTimeout(t); }, [args]);
  const plan = useQuery({
    queryKey: ["packets", "plan", receipt.id, asked],
    queryFn: () => packetService.plan(receipt.id, asked, { silent: true }).then((r) => r.data.data),
    enabled: ready,
    retry: false,
  });
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await packetService.pack(receipt.id, args);
      toast.success(r.data.message);
      onMade(r.data.data);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const p = plan.data;
  const unit = receipt.uom || "";
  return (
    <Shell title="Make QR labels" onClose={onClose} size="xl"
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        <button type="button" className="btn-primary" onClick={make} disabled={!ready || !p || plan.isError || busy}>
          <Package size={15} aria-hidden="true" /> {busy ? "Making…" : p ? `Make ${p.count} label${p.count === 1 ? "" : "s"}` : "Make labels"}
        </button>
      </>}>
      <ReceiptFacts r={receipt} />
      <div className="grid grid-cols-2 gap-2">
        {[["PACKET", "Small parts packet", "Nuts, bolts, washers … many in one packet, one QR"],
          ["UNIT", "Individual part", "Each piece its own QR"]].map(([k, title, sub]) => (
          <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k}
            className={`rounded-xl border-2 p-3 text-left transition ${kind === k ? "border-toyotared bg-toyotared/5" : "border-slate-200 hover:border-slate-300 dark:border-navy-700"}`}>
            <span className="block text-[14px] font-bold text-slate-800 dark:text-white">{title}</span>
            <span className="block text-[12px] text-slate-500">{sub}</span>
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {kind === "PACKET" && (
          <Field label="Quantity per packet" required hint="Any number — not fixed">
            <input type="number" min="0" step="any" inputMode="decimal" className={inputCls(false, "w-full text-lg font-semibold")}
              value={size} onChange={(e) => setSize(e.target.value)} autoFocus placeholder="e.g. 20" />
          </Field>
        )}
        <Field label={kind === "PACKET" ? "Number of packets" : "Number of labels"} hint="Blank = all that fit">
          <input type="number" min="1" step="1" inputMode="numeric" className={inputCls(false, "w-full")}
            value={count} onChange={(e) => setCount(e.target.value)} placeholder={p ? String(p.count - (p.last_qty ? 1 : 0)) : ""} />
        </Field>
        {kind === "PACKET" && (
          <label className="flex items-center gap-2 self-end pb-2 text-[13px] text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={lastSmaller} onChange={(e) => setLastSmaller(e.target.checked)} />
            Make a smaller last packet of what is left
          </label>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 p-3 dark:border-navy-700 sm:grid-cols-4">
        <Fact label="Left to pack">{p ? `${num(p.packable)} ${unit}` : `${num(receipt.to_pack)} ${unit}`}</Fact>
        <Fact label={kind === "PACKET" ? "Packets" : "Labels"}>{p ? `${p.count}${p.last_qty ? ` (last of ${num(p.last_qty)})` : ""}` : "—"}</Fact>
        <Fact label="Packed now">{p ? `${num(p.total)} ${unit}` : "—"}</Fact>
        <Fact label="Stays loose">{p ? `${num(p.loose_after)} ${unit}` : "—"}</Fact>
      </div>
      {plan.isError && ready && <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">{errText(plan.error)}</p>}
      {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700">{error}</p>}
      <p className="text-[12px] text-slate-500 dark:text-slate-400">Each label gets its own QR code. Making labels never changes stock.</p>
    </Shell>
  );
}

// ---- print / reprint -----------------------------------------------------------------------

export function PrintDialog({ packets, reprint = false, onClose, onDone }) {
  const [layout, setLayout] = useState(() => {
    try { return localStorage.getItem("dx_packet_label_layout") || "A4"; } catch { return "A4"; }
  });
  const [reason, setReason] = useState("");
  const [step, setStep] = useState("SETUP");             // SETUP -> ASK (did it print?)
  const [busy, setBusy] = useState(false);
  const config = useQuery({
    queryKey: ["barcode", "label-config"],
    queryFn: () => barcodeService.labelConfig().then((r) => r.data.data),
    staleTime: 5 * 60 * 1000,
  });
  const html = useMemo(() => packetLabelsHtml(packets, { layout, config: config.data }), [packets, layout, config.data]);
  const preview = useMemo(() => packetLabelsHtml(packets.slice(0, layout === "A4" ? 24 : 1),
    { layout, config: config.data, zoom: layout === "A4" ? 0.86 : undefined }),
    [packets, layout, config.data]);
  const pick = (v) => { setLayout(v); try { localStorage.setItem("dx_packet_label_layout", v); } catch { /* ok */ } };
  const print = () => {
    if (reprint && !reason.trim()) return;
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
        <button type="button" className="btn-primary" onClick={print} disabled={reprint && !reason.trim()}>
          <Printer size={15} aria-hidden="true" /> Print
        </button>
      </>}>
      {step === "ASK" ? (
        <p className="text-[14px] text-slate-700 dark:text-slate-200">Did the {packets.length} label{packets.length === 1 ? "" : "s"} come out of the printer? Only then is the print recorded.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {[["A4", "A4 sheet (24 a page)"], ["LABEL", `Label printer${config.data ? ` (${config.data.width_mm || 100} × ${config.data.height_mm || 50} mm)` : ""}`]].map(([v, t]) => (
              <button key={v} type="button" onClick={() => pick(v)} aria-pressed={layout === v}
                className={`rounded-lg border px-3 py-1.5 text-[13px] font-semibold ${layout === v ? "border-toyotared bg-toyotared/5 text-toyotared" : "border-slate-200 text-slate-600 dark:border-navy-700 dark:text-slate-300"}`}>
                {t}
              </button>
            ))}
          </div>
          {reprint && (
            <Field label="Why print again" required hint="Torn, lost, faded … — kept with the print history">
              <input className={inputCls(false, "w-full")} maxLength={255} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </Field>
          )}
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-navy-700">
            <iframe title="Label preview" srcDoc={preview}
              className={layout === "A4" ? "h-[420px] w-full bg-white" : "h-[230px] w-full bg-white"} />
          </div>
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

// ---- a batch of stock already on the shelf -----------------------------------------------------

export function OpeningDialog({ storeCode, onClose, onMade }) {
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [part, setPart] = useState(null);
  const [qty, setQty] = useState("");
  const [remarks, setRemarks] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { const t = setTimeout(() => setQ(typed.trim()), 250); return () => clearTimeout(t); }, [typed]);
  const found = useQuery({
    queryKey: ["packets", "parts", storeCode, q],
    queryFn: () => packetService.parts(storeCode, q, { silent: true }).then((r) => r.data.data),
    enabled: q.length >= 2 && !part,
  });
  const why = !part ? "Pick the part" : !(Number(qty) > 0) ? "Enter the quantity" : Number(qty) > Number(part.loose) ? `Only ${part.loose} is loose` : null;
  const make = async () => {
    if (why) return;
    setBusy(true);
    setError(null);
    try {
      const r = await packetService.opening({ store_code: storeCode, part_id: part.id, qty: Number(qty), remarks: remarks.trim() || undefined });
      toast.success(r.data.message);
      onMade(r.data.data);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Pack stock already on the shelf" onClose={onClose}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        <button type="button" className="btn-primary" onClick={make} disabled={Boolean(why) || busy}>
          <Boxes size={15} aria-hidden="true" /> {busy ? "Making…" : "Make batch, then labels"}
        </button>
      </>}>
      {!part ? (
        <>
          <Field label="Part" required>
            <span className="relative block">
              <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className={inputCls(false, "w-full pl-8")} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus placeholder="Part No., name, spec or model no." />
            </span>
          </Field>
          <div className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 dark:divide-navy-800 dark:border-navy-700">
            {(found.data || []).map((p) => (
              <button key={p.id} type="button" disabled={!(p.loose > 0)} onClick={() => { setPart(p); setQty(String(p.loose)); }}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50 disabled:opacity-50 dark:hover:bg-navy-800">
                <span className="min-w-0"><span className="block font-mono text-[13px] font-bold">{p.part_no}</span>
                  <span className="block truncate text-[12px] text-slate-500">{p.part_name}</span></span>
                <span className="shrink-0 text-right text-[12px] text-slate-500">Loose <b className="text-slate-800 dark:text-white">{num(p.loose)}</b> {p.uom}<br />of {num(p.on_hand)} on hand</span>
              </button>
            ))}
            {q.length >= 2 && found.data && found.data.length === 0 && <p className="px-3 py-4 text-center text-[13px] text-slate-400">No part found</p>}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 p-3 dark:bg-navy-950/40">
            <span className="min-w-0"><span className="block font-mono text-[14px] font-bold">{part.part_no}</span>
              <span className="block truncate text-[12px] text-slate-500">{part.part_name}</span></span>
            <button type="button" className="text-[12px] font-semibold text-toyotared hover:underline" onClick={() => setPart(null)}>Change</button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Quantity to pack" required hint={`Loose on the shelf: ${num(part.loose)} ${part.uom || ""}`}>
              <input type="number" min="0" step="any" inputMode="decimal" className={inputCls(false, "w-full text-lg font-semibold")}
                value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
            <Field label="Remarks" hint="Optional">
              <input className={inputCls(false, "w-full")} maxLength={255} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </Field>
          </div>
          <p className="text-[12px] text-slate-500 dark:text-slate-400">
            This stock is the oldest, so its packets go out first (FIFO). Nothing is added to stock.
          </p>
        </>
      )}
      {(error || (why && part)) && <p role="alert" className={`rounded-lg px-3 py-2 text-[12.5px] ${error ? "bg-rose-50 text-rose-700" : "bg-slate-50 text-slate-500 dark:bg-navy-950/40"}`}>{error || why}</p>}
    </Shell>
  );
}
