import React, { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useStores } from "../context/StoreContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import ScanPanel from "../components/ScanPanel.jsx";
import Badge from "../components/Badge.jsx";
import { barcodeService } from "../services/barcodeService.js";
import { spareStockService } from "../services/spareStockService.js";
import { departmentService } from "../services/departmentService.js";
import { supplierService } from "../services/supplierService.js";

const MODES = [
  { key: "LOOKUP", label: "Lookup", emoji: "🔎" },
  { key: "ISSUE", label: "Issue", emoji: "📤" },
  { key: "RECEIVE", label: "Receive", emoji: "📥" },
  { key: "RETURN", label: "Return", emoji: "↩️" },
  { key: "UPDATE_LOCATION", label: "Location", emoji: "📍" },
  { key: "CONFIRM", label: "Confirm", emoji: "✅" },
  { key: "HISTORY", label: "History", emoji: "📜" },
];
const CHECK_RESULTS = ["OK", "SHORT", "EXCESS", "DAMAGED"];
// Why a department sent an issued part back (matches the backend RETURN_REASONS).
const RETURN_REASONS = ["Did not fit", "Wrong part", "Damaged / defective", "Excess — not required", "Other"];
// RETURN acts on an existing issue; audit its scan as a plain LOOKUP (a valid
// scan mode) rather than inventing a new one.
const scanModeFor = (mode) => (mode === "CONFIRM" ? "ISSUE" : mode === "RETURN" ? "LOOKUP" : mode);
const fmt = (v) => (v == null || v === "" ? "—" : v);

function Field({ label, children }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-base font-semibold text-slate-800 dark:text-slate-100">{children}</div>
    </div>
  );
}

export default function ScanPart() {
  const { activeCode } = useStores();
  const { user } = useAuth();
  const storeCode = activeCode || "MAINTENANCE";

  const [mode, setMode] = useState("LOOKUP");
  const [busy, setBusy] = useState(false);
  const [part, setPart] = useState(null);
  const [form, setForm] = useState({});
  const [pending, setPending] = useState([]);
  const [history, setHistory] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [now, setNow] = useState(() => new Date());
  const resolvingRef = useRef(false);
  const reqSeqRef = useRef(0);   // invalidates a resolve whose mode changed mid-flight

  useEffect(() => {
    departmentService.list(true).then((r) => setDepartments(r.data.data || [])).catch(() => {});
    supplierService.list({ per_page: 500 }).then((r) => setSuppliers(r.data.data || [])).catch(() => {});
  }, []);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); clearInterval(id); };
  }, []);

  const reset = () => { setPart(null); setForm({}); setPending([]); setHistory([]); };
  const changeMode = (m) => { reqSeqRef.current++; setMode(m); reset(); };

  const handleCode = async (code, source) => {
    if (resolvingRef.current || busy) return;
    resolvingRef.current = true;
    const seq = ++reqSeqRef.current;
    setBusy(true);
    try {
      const res = await barcodeService.resolve(storeCode, code, {
        scanSource: source, scanMode: scanModeFor(mode),
      });
      // Mode changed (or a new scan started) while this resolve was in flight —
      // drop the stale result instead of resurrecting the old part.
      if (reqSeqRef.current !== seq) return;
      const data = res.data.data;
      setPart(data);
      setForm(defaultForm(mode));
      if (mode === "CONFIRM") {
        const p = await spareStockService.partPendingConfirmations(data.part_id);
        setPending(p.data.data || []);
      }
      if (mode === "RETURN") {
        const p = await spareStockService.returnableIssues(data.part_id);
        setPending(p.data.data || []);
      }
      if (mode === "HISTORY") {
        const h = await spareStockService.history(data.part_id, 200);
        setHistory(h.data.data || []);
      }
    } catch {
      /* interceptor toasts the message (unknown/inactive/no-access) */
    } finally {
      setBusy(false);
      resolvingRef.current = false;
    }
  };

  const defaultForm = (m) => {
    if (m === "ISSUE") return { qty: "", department: "", issued_to: "", returnable: false, remarks: "" };
    if (m === "RECEIVE") return { qty: "", supplier_id: "", invoice_no: "", invoice_date: "", check_result: "OK", department: "", remarks: "" };
    if (m === "UPDATE_LOCATION") return { new_location: "", reason: "" };
    if (m === "CONFIRM") return { ledger_id: "", line_name: "", line_no: "", machine: "", actual_qty: "" };
    if (m === "RETURN") return { ledger_id: "", qty: "", reason: "", returned_by: "", note: "" };
    return {};
  };

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (action) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      toast.success("Done — scan the next part");
      reset();
    } catch {
      /* interceptor toasts */
    } finally {
      setBusy(false);
    }
  };

  const doIssue = () => {
    if (!(Number(form.qty) > 0)) return toast.error("Enter a quantity");
    if (Number(form.qty) > Number(part.qty_on_hand ?? 0)) return toast.error(`Only ${fmt(part.qty_on_hand)} in stock`);
    if (!form.department) return toast.error("Choose a department");
    return submit(() => spareStockService.issue(part.part_id, {
      qty: Number(form.qty), department: form.department,
      issued_to: form.issued_to || undefined, returnable: !!form.returnable,
      remarks: form.remarks || undefined,
    }));
  };

  const doReceive = () => {
    if (!(Number(form.qty) > 0)) return toast.error("Enter a quantity");
    return submit(() => spareStockService.receive(part.part_id, {
      qty: Number(form.qty),
      supplier_id: form.supplier_id ? Number(form.supplier_id) : undefined,
      invoice_no: form.invoice_no || undefined,
      invoice_date: form.invoice_date || undefined,
      check_result: form.check_result || undefined,
      department: form.department || undefined,
      remarks: form.remarks || undefined,
    }));
  };

  const doLocation = () => {
    if (!form.new_location.trim()) return toast.error("Enter a new location");
    if (!form.reason.trim()) return toast.error("Enter a reason");
    return submit(() => spareStockService.updateLocation(part.part_id, {
      new_location: form.new_location.trim(), reason: form.reason.trim(),
    }));
  };

  const doConfirm = () => {
    if (!form.ledger_id) return toast.error("Select the issue to confirm");
    return submit(() => spareStockService.confirm(form.ledger_id, {
      line_name: form.line_name || undefined, line_no: form.line_no || undefined,
      machine: form.machine || undefined,
      actual_qty: form.actual_qty !== "" ? Number(form.actual_qty) : undefined,
    }));
  };

  // The issue picked in RETURN mode — its outstanding qty caps the return.
  const returnIssue = useMemo(
    () => pending.find((p) => String(p.id) === String(form.ledger_id)) || null,
    [pending, form.ledger_id]);

  const doReturn = async () => {
    if (busy) return;
    if (!form.ledger_id) return toast.error("Select the issue being returned");
    if (!form.reason) return toast.error("Choose a reason");
    const outstanding = Number(returnIssue?.outstanding_qty ?? 0);
    const qty = form.qty === "" ? outstanding : Number(form.qty);
    if (!(qty > 0)) return toast.error("Enter a quantity to return");
    if (qty > outstanding) return toast.error(`Only ${outstanding} still out on this issue`);
    setBusy(true);
    try {
      const res = await spareStockService.returnItem(form.ledger_id, {
        qty, reason: form.reason,
        note: form.note || undefined, returned_by: form.returned_by || undefined,
      });
      const slip = res?.data?.data?.return_no;
      toast.success(slip ? `Returned to store · slip ${slip}` : "Returned to store");
      reset();
    } catch {
      /* interceptor toasts */
    } finally {
      setBusy(false);
    }
  };

  const clock = useMemo(() =>
    `${now.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`,
  [now]);

  return (
    <div className="space-y-4">
      {/* status bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl2 border border-slate-200 bg-white px-4 py-2 text-sm dark:border-navy-800 dark:bg-navy-900">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-slate-800 dark:text-white">Scan Part</span>
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-navy-800 dark:text-slate-300">{storeCode}</span>
        </div>
        <div className="flex items-center gap-3 text-slate-500 dark:text-slate-400">
          <span className={`inline-flex items-center gap-1 ${online ? "text-emerald-600" : "text-rose-500"}`}>
            <span className={`h-2 w-2 rounded-full ${online ? "bg-emerald-500" : "bg-rose-500"}`} />{online ? "Online" : "Offline"}
          </span>
          <span>{user?.full_name || user?.username}</span>
          <span className="tabular-nums">{clock}</span>
        </div>
      </div>

      {/* mode tabs */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {MODES.map((m) => (
          <button key={m.key} type="button" onClick={() => changeMode(m.key)} disabled={busy}
            className={`rounded-lg py-3 text-sm font-semibold ${
              mode === m.key ? "bg-toyotared text-white" : "bg-slate-100 text-slate-700 dark:bg-navy-800 dark:text-slate-200"}`}>
            <span className="mr-1">{m.emoji}</span>{m.label}
          </button>
        ))}
      </div>

      <ScanPanel onCode={handleCode} busy={busy}
        hint={mode === "CONFIRM" ? "Re-scan the issued part to confirm"
          : mode === "RETURN" ? "Scan the part the department is sending back"
          : "Scan or enter Part No., then Enter"} />

      {part && (
        <div className="rounded-xl2 border border-slate-200 bg-white p-4 dark:border-navy-800 dark:bg-navy-900">
          {/* resolved part header */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3 dark:border-navy-800">
            <div>
              <div className="text-lg font-bold text-slate-900 dark:text-white">{part.part_no}</div>
              <div className="text-sm text-slate-500 dark:text-slate-400">{part.part_name}</div>
            </div>
            <div className="flex items-center gap-2">
              <Badge status={part.status} />
              <button type="button" onClick={reset} className="btn-secondary">Scan next</button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="In Stock">{fmt(part.qty_on_hand)}</Field>
            <Field label="Min / Max">{fmt(part.min_stock_level)} / {fmt(part.max_stock_level)}</Field>
            <Field label="Location">{fmt(part.location)}</Field>
            <Field label="UOM">{fmt(part.uom)}</Field>
            <Field label="Category">{fmt(part.category)}</Field>
            <Field label="Type">{fmt(part.sub_category)}</Field>
            <Field label="Resolved by">{part.resolved_by === "SUPPLIER" ? "Supplier barcode" : part.resolved_by === "INTERNAL" ? "Internal barcode" : "Part No."}</Field>
            <Field label="Stock source">
              <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                {part.data_status?.stock_source || "MANUAL"}
              </span>
              {part.data_status?.erp_last_sync && (
                <span className="ml-1 text-xs text-slate-400">ERP sync {new Date(part.data_status.erp_last_sync).toLocaleString("en-GB")}</span>
              )}
            </Field>
          </div>

          {part.data_status?.warning && (
            <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              ⚠️ {part.data_status.warning}
              {part.data_status?.write && !part.data_status.write.active && (
                <span className="ml-1">· ERP stock write is off — issue/receive stay in the app for now.</span>
              )}
            </div>
          )}

          {/* mode-specific action */}
          <div className="mt-4 border-t border-slate-100 pt-4 dark:border-navy-800">
            {mode === "LOOKUP" && (
              <p className="text-sm text-slate-500 dark:text-slate-400">Read-only lookup — no stock changed. Switch to a mode above to act on this part.</p>
            )}

            {mode === "ISSUE" && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Quantity *</span>
                    <input type="number" min={1} max={Number(part.qty_on_hand ?? 0)} value={form.qty} onChange={(e) => set("qty", e.target.value)}
                      className={`input-field mt-1 w-full text-lg ${form.qty !== "" && Number(form.qty) > Number(part.qty_on_hand ?? 0) ? "border-rose-400" : ""}`} />
                    {form.qty !== "" && Number(form.qty) > Number(part.qty_on_hand ?? 0) && (
                      <span className="mt-1 block text-[11px] font-semibold text-rose-600 dark:text-rose-400">Only {fmt(part.qty_on_hand)} in stock — cannot issue more.</span>
                    )}
                  </label>
                  <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Department *</span>
                    <select value={form.department} onChange={(e) => set("department", e.target.value)} className="input-field mt-1 w-full text-lg">
                      <option value="">Select…</option>
                      {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                    </select></label>
                  <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Issued to (person)</span>
                    <input value={form.issued_to} onChange={(e) => set("issued_to", e.target.value)} className="input-field mt-1 w-full" /></label>
                  <label className="mt-6 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                    <input type="checkbox" checked={form.returnable} onChange={(e) => set("returnable", e.target.checked)} /> Returnable (tool/die)</label>
                </div>
                <p className="text-xs text-slate-400">Machine / line are captured later by the user who fits the part (Confirm mode).</p>
                <button type="button" onClick={doIssue}
                  disabled={busy || form.qty === "" || Number(form.qty) <= 0 || Number(form.qty) > Number(part.qty_on_hand ?? 0)}
                  className="btn-primary w-full py-3 text-lg">Confirm issue</button>
              </div>
            )}

            {mode === "RECEIVE" && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Received qty *</span>
                    <input type="number" min={1} value={form.qty} onChange={(e) => set("qty", e.target.value)} className="input-field mt-1 w-full text-lg" /></label>
                  <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Supplier</span>
                    <select value={form.supplier_id} onChange={(e) => set("supplier_id", e.target.value)} className="input-field mt-1 w-full">
                      <option value="">Select…</option>
                      {suppliers.map((s) => <option key={s.id} value={s.id}>{s.supplier_name}</option>)}
                    </select></label>
                  <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Invoice no.</span>
                    <input value={form.invoice_no} onChange={(e) => set("invoice_no", e.target.value)} className="input-field mt-1 w-full" /></label>
                  <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Invoice date</span>
                    <input type="date" value={form.invoice_date} onChange={(e) => set("invoice_date", e.target.value)} className="input-field mt-1 w-full" /></label>
                  <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Physical check</span>
                    <select value={form.check_result} onChange={(e) => set("check_result", e.target.value)} className="input-field mt-1 w-full">
                      {CHECK_RESULTS.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select></label>
                  <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Responsible section</span>
                    <select value={form.department} onChange={(e) => set("department", e.target.value)} className="input-field mt-1 w-full">
                      <option value="">Select…</option>
                      {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                    </select></label>
                </div>
                <p className="text-xs text-slate-400">Spare receiving is direct — no RQC, no put-away.</p>
                <button type="button" onClick={doReceive} disabled={busy} className="btn-primary w-full py-3 text-lg">Confirm receive</button>
              </div>
            )}

            {mode === "UPDATE_LOCATION" && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Current location">{fmt(part.location)}</Field>
                  <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">New location *</span>
                    <input value={form.new_location} onChange={(e) => set("new_location", e.target.value)} className="input-field mt-1 w-full text-lg" /></label>
                  <label className="block sm:col-span-2"><span className="text-sm text-slate-600 dark:text-slate-300">Reason *</span>
                    <input value={form.reason} onChange={(e) => set("reason", e.target.value)} className="input-field mt-1 w-full" /></label>
                </div>
                <button type="button" onClick={doLocation} disabled={busy} className="btn-primary w-full py-3 text-lg">Update location</button>
              </div>
            )}

            {mode === "CONFIRM" && (
              <div className="space-y-3">
                {pending.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">No pending issues for this part to confirm.</p>
                ) : (
                  <>
                    <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Which issue *</span>
                      <select value={form.ledger_id} onChange={(e) => set("ledger_id", e.target.value)} className="input-field mt-1 w-full">
                        <option value="">Select the issue…</option>
                        {pending.map((p) => (
                          <option key={p.id} value={p.id}>
                            {new Date(p.issued_at).toLocaleDateString("en-GB")} · {p.qty} to {p.department}{p.issued_to ? ` · ${p.issued_to}` : ""}
                          </option>
                        ))}
                      </select></label>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Line name (seat slider / recliner…)</span>
                        <input value={form.line_name} onChange={(e) => set("line_name", e.target.value)} className="input-field mt-1 w-full" /></label>
                      <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Line no.</span>
                        <input value={form.line_no} onChange={(e) => set("line_no", e.target.value)} className="input-field mt-1 w-full" /></label>
                      <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Machine no.</span>
                        <input value={form.machine} onChange={(e) => set("machine", e.target.value)} className="input-field mt-1 w-full" /></label>
                      <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Actual used qty</span>
                        <input type="number" min={0} value={form.actual_qty} onChange={(e) => set("actual_qty", e.target.value)} className="input-field mt-1 w-full" /></label>
                    </div>
                    <button type="button" onClick={doConfirm} disabled={busy} className="btn-primary w-full py-3 text-lg">Confirm installation</button>
                  </>
                )}
              </div>
            )}

            {mode === "RETURN" && (
              <div className="space-y-3">
                {pending.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    No issued stock of this part is out on the floor — nothing to take back.
                  </p>
                ) : (
                  <>
                    <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Which issue is coming back *</span>
                      <select value={form.ledger_id}
                        onChange={(e) => { const id = e.target.value; const it = pending.find((p) => String(p.id) === String(id)); setForm((f) => ({ ...f, ledger_id: id, qty: it ? String(it.outstanding_qty) : "" })); }}
                        className="input-field mt-1 w-full">
                        <option value="">Select the issue…</option>
                        {pending.map((p) => (
                          <option key={p.id} value={p.id}>
                            {new Date(p.issued_at).toLocaleDateString("en-GB")} · {p.outstanding_qty} out · {p.department}{p.issued_to ? ` · ${p.issued_to}` : ""}{p.returnable ? " · tool/die" : ""}
                          </option>
                        ))}
                      </select></label>
                    {returnIssue && (
                      <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-navy-800 dark:text-slate-400">
                        Issued {returnIssue.issued_qty}{returnIssue.consumed_qty ? ` · ${returnIssue.consumed_qty} fitted` : ""}{returnIssue.returned_qty ? ` · ${returnIssue.returned_qty} already back` : ""} · <span className="font-semibold text-slate-700 dark:text-slate-200">{returnIssue.outstanding_qty} still out</span>
                      </div>
                    )}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Return qty *</span>
                        <input type="number" min={0} step="any" max={Number(returnIssue?.outstanding_qty ?? 0)}
                          value={form.qty} onChange={(e) => set("qty", e.target.value)}
                          className={`input-field mt-1 w-full text-lg ${form.qty !== "" && returnIssue && Number(form.qty) > Number(returnIssue.outstanding_qty) ? "border-rose-400" : ""}`} />
                        {form.qty !== "" && returnIssue && Number(form.qty) > Number(returnIssue.outstanding_qty) && (
                          <span className="mt-1 block text-[11px] font-semibold text-rose-600 dark:text-rose-400">Only {returnIssue.outstanding_qty} still out on this issue.</span>
                        )}
                      </label>
                      <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Reason *</span>
                        <select value={form.reason} onChange={(e) => set("reason", e.target.value)} className="input-field mt-1 w-full">
                          <option value="">Select…</option>
                          {RETURN_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select></label>
                      <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Returned by (person)</span>
                        <input value={form.returned_by} onChange={(e) => set("returned_by", e.target.value)} className="input-field mt-1 w-full" /></label>
                      <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Note</span>
                        <input value={form.note} onChange={(e) => set("note", e.target.value)} placeholder={form.reason === "Other" ? "Describe the reason" : "Optional"} className="input-field mt-1 w-full" /></label>
                    </div>
                    <p className="text-xs text-slate-400">A store return slip (RET-…) is raised and stock is added back. Anything already fitted can't be taken back.</p>
                    <button type="button" onClick={doReturn}
                      disabled={busy || !form.ledger_id || !form.reason || (returnIssue && Number(form.qty) > Number(returnIssue.outstanding_qty))}
                      className="btn-primary w-full py-3 text-lg">Take back on return slip</button>
                  </>
                )}
              </div>
            )}

            {mode === "HISTORY" && (
              <div className="max-h-[50vh] overflow-y-auto">
                {history.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">No history yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase text-slate-400">
                      <tr><th className="py-1">When</th><th>Type</th><th>Qty</th><th>Dept / To</th><th>Line / Machine</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {history.map((h) => (
                        <tr key={h.id} className="border-t border-slate-100 dark:border-navy-800">
                          <td className="py-1 tabular-nums">{h.at ? new Date(h.at).toLocaleString("en-GB") : "—"}</td>
                          <td>{h.txn_type}</td>
                          <td className="tabular-nums">{h.qty_delta}</td>
                          <td>{fmt(h.department)}{h.issued_to ? ` / ${h.issued_to}` : ""}</td>
                          <td>{fmt(h.line_name)}{h.machine ? ` / ${h.machine}` : ""}</td>
                          <td>{fmt(h.status)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
