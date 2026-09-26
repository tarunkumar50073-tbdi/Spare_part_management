import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine, ArrowUpFromLine, ChevronDown, CircleCheck, Hourglass, MapPin, Search, TriangleAlert, Undo2, X, XCircle,
} from "lucide-react";
import { useStores } from "../context/StoreContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { usePartDrawer } from "../context/PartDrawerContext.jsx";
import ScanPanel from "../components/ScanPanel.jsx";
import Badge from "../components/Badge.jsx";
import Table from "../components/Table.jsx";
import IssueLifecycle, { IssueAge, isNoneUsed, issueAge, useMinuteClock, utcStamp } from "../components/spare/IssueLifecycle.jsx";
import { barcodeService } from "../services/barcodeService.js";
import { spareStockService } from "../services/spareStockService.js";
import { departmentService } from "../services/departmentService.js";
import { supplierService } from "../services/supplierService.js";
import { fmtStamp, num, parseServerTime } from "../lib/format.js";
import Can from "../components/Can.jsx";

const MODES = [
  { key: "LOOKUP", label: "Lookup", icon: Search },
  { key: "ISSUE", label: "Issue", icon: ArrowUpFromLine },
  { key: "RECEIVE", label: "Receive", icon: ArrowDownToLine },
  { key: "RETURN", label: "Return", icon: Undo2 },
  { key: "UPDATE_LOCATION", label: "Location", icon: MapPin },
  { key: "CONFIRM", label: "Confirm", icon: CircleCheck },
  // History is deliberately NOT here — a part's full timeline lives on the
  // dedicated Part Ledger screen, so it isn't duplicated on the scan gun.
];
const CHECK_RESULTS = ["OK", "SHORT", "EXCESS", "DAMAGED"];
// Why a department sent an issued part back (matches the backend RETURN_REASONS).
const RETURN_REASONS = ["Did not fit", "Wrong part", "Damaged / defective", "Excess — not required", "Other"];
// The actions offered once a part is scanned. Lookup is not here — the part's
// details are always on screen; these are the things you can DO to it.
const ACTIONS = MODES.filter((m) => m.key !== "LOOKUP");
const fmt = (v) => (v == null || v === "" ? "—" : v);

function Field({ label, children }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-base font-semibold text-slate-800 dark:text-slate-100">{children}</div>
    </div>
  );
}

// The issue endpoint answers with the part's stock row, not the new ledger row,
// so the new issue is picked out of the part's awaiting list: same qty,
// department, person and issuer — the highest id is the newest.
const findNewIssue = (rows, sent, username) =>
  rows
    .filter((r) => Math.abs(Number(r.qty) - sent.qty) <= 0.01
      && r.department === sent.department
      && (r.issued_to || null) === sent.issued_to
      && (!username || r.issued_by === username))
    .reduce((best, r) => (!best || r.id > best.id ? r : best), null);

// The whole store's Stage-2 queue. Newest AWAITING_LIMIT only — the row dicts
// are built one by one server-side, and a longer list would not be read here.
// The server sends newest first, so a capped list is missing the OLDEST (the
// longest-waiting) issues; one extra row is asked for to tell "exactly 500"
// from "more than 500".
const AWAITING_LIMIT = 500;
const AWAITING_KEY = ["stock", "pending-confirmations"];

function LoadFailed({ what, onRetry }) {
  return (
    <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
      Couldn&apos;t load {what}.{" "}
      <button type="button" onClick={onRetry} className="font-semibold underline underline-offset-2">Retry</button>
    </div>
  );
}

// Every store issue the fitter has not yet confirmed (line + machine). Memoised
// with its own minute clock, so the page's one-second clock doesn't redraw the
// table every tick.
const AwaitingConfirmation = memo(function AwaitingConfirmation({ storeCode }) {
  const { openPart } = usePartDrawer();
  const [open, setOpen] = useState(false);
  const nowMs = useMinuteClock();
  const { data, isPending, isError, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: [...AWAITING_KEY, storeCode],
    queryFn: () => spareStockService.pendingConfirmations(storeCode, AWAITING_LIMIT + 1).then((r) => r.data.data || []),
    enabled: Boolean(storeCode),
  });
  const capped = (data?.length ?? 0) > AWAITING_LIMIT;
  const rows = useMemo(() => (data || []).slice(0, AWAITING_LIMIT), [data]);
  // Counted over the listed rows only — when capped, the unlisted older issues
  // can only add to it, so it is a lower bound.
  const overdue = useMemo(() => rows.filter((r) => issueAge(r.issued_at, nowMs)?.overdue).length, [rows, nowMs]);

  const columns = useMemo(() => [
    { key: "part_no", label: "Part No", sortable: true,
      render: (r) => <span className="font-semibold text-slate-800 dark:text-white">{r.part_no || "—"}</span> },
    { key: "part_name", label: "Description", sortable: true,
      render: (r) => <span className="block max-w-[13rem] truncate text-slate-600 dark:text-slate-300" title={r.part_name || undefined}>{r.part_name || "—"}</span> },
    { key: "qty", label: "Qty", align: "right", sortable: true, render: (r) => num(r.qty) },
    { key: "department", label: "Department", sortable: true, render: (r) => r.department || "—" },
    { key: "issued_to", label: "Handed to", sortable: true,
      render: (r) => r.issued_to || <span className="text-slate-400">Not recorded</span> },
    // Age before the stamp — how long it has waited is what gets chased.
    { key: "age", label: "Age", sortValue: (r) => issueAge(r.issued_at, nowMs)?.ms ?? null,
      render: (r) => <IssueAge at={r.issued_at} now={nowMs} prefix="" />,
      exportValue: (r) => issueAge(r.issued_at, nowMs)?.text ?? "" },
    // No status column: every row here is, by definition, awaiting confirmation.
    { key: "issued_at", label: "Issued", sortable: true,
      render: (r) => fmtStamp(utcStamp(r.issued_at)), exportValue: (r) => fmtStamp(utcStamp(r.issued_at)) },
  ], [nowMs]);

  // A failed refetch keeps the last list on screen; only a first load that
  // failed has nothing to show.
  const failed = isError && !data;
  const stale = isError && Boolean(data);
  const count = isPending ? "…" : failed ? "?" : capped ? `${AWAITING_LIMIT}+` : rows.length;
  return (
    <section className="overflow-hidden rounded-xl2 border border-slate-200 bg-white dark:border-navy-800 dark:bg-navy-900">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="awaiting-confirmation-list"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-navy-800/60">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300">
            <Hourglass size={16} aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-slate-800 dark:text-white">Awaiting confirmation ({count})</span>
            <span className="block text-[11px] leading-tight text-slate-400">Issued by the store, line + machine not yet confirmed by the fitter · whole store</span>
            {capped && (
              <span className="block text-[11px] font-semibold leading-tight text-amber-700 dark:text-amber-300">
                Only the newest {AWAITING_LIMIT} are listed — the oldest, longest-waiting issues are not shown
              </span>
            )}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {overdue > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
              <TriangleAlert size={12} aria-hidden="true" />{capped ? `At least ${overdue}` : overdue} over 2 days
            </span>
          )}
          {failed && <span className="text-[11px] font-semibold text-rose-600 dark:text-rose-400">Couldn&apos;t load</span>}
          <ChevronDown size={16} className={`text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </span>
      </button>
      {/* Outside the toggle and shown open or closed: this screen stays up all
          shift, and nothing else refetches the list on its own. */}
      {stale && (
        <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-rose-100 bg-rose-50 px-4 py-2 text-xs text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300">
          <span>
            Couldn&apos;t refresh — this is the list as loaded at {fmtStamp(new Date(dataUpdatedAt))}, so issues written or confirmed since are not reflected.
          </span>
          <button type="button" onClick={() => refetch()} disabled={isFetching}
            className="font-semibold underline underline-offset-2 disabled:no-underline disabled:opacity-60">
            {isFetching ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {open && (
        <div id="awaiting-confirmation-list" className="border-t border-slate-100 p-4 dark:border-navy-800">
          {isPending ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton h-10 w-full" />)}</div>
          ) : failed ? (
            <LoadFailed what="the confirmation queue" onRetry={() => refetch()} />
          ) : (
            <>
              <Table columns={columns} rows={rows} searchable="Search part, department, person…"
                exportName="awaiting_confirmation" maxHeight="50vh"
                onRowClick={(r) => openPart(r.part_id)}
                emptyMessage="Nothing is waiting for confirmation." />
              <p className="mt-2 text-[11px] text-slate-400">
                Click a row to open the part. To confirm an issue, scan the part and choose Confirm.
                {capped ? ` Showing the newest ${AWAITING_LIMIT} only — older issues, the longest waiting, are not listed or exported here.` : ""}
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
});

export default function ScanPart() {
  const { activeCode, activeStore } = useStores();
  const { user } = useAuth();
  const { openPart } = usePartDrawer();
  const qc = useQueryClient();
  const storeCode = activeCode || "MAINTENANCE";

  const [mode, setMode] = useState("LOOKUP");
  const [busy, setBusy] = useState(false);
  const [part, setPart] = useState(null);
  const [form, setForm] = useState({});
  const [pending, setPending] = useState([]);
  // Where the Confirm / Return pick-list load stands, so "nothing to confirm"
  // is only said once the answer is actually in.
  const [pendingLoad, setPendingLoad] = useState("idle"); // idle | loading | ready | error
  // The lifecycle of the issue just written (Stage 1) or just confirmed
  // (Stage 2), shown until the next scan: { kind, sent?, issue, state }.
  const [lastResult, setLastResult] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [now, setNow] = useState(() => new Date());
  const resolvingRef = useRef(false);
  const reqSeqRef = useRef(0);   // invalidates a resolve whose mode changed mid-flight
  const actionSeqRef = useRef(0); // drops a pick-list load for a mode / part no longer on screen
  const resultSeqRef = useRef(0); // drops a lifecycle load once the operator has moved on

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

  // A scan that resolves to nothing: shown in place of the part card, so a
  // failed read can never leave the PREVIOUS part on screen to be issued.
  const [scanError, setScanError] = useState(null);   // { code, message }
  const clearPickList = () => { actionSeqRef.current++; setPending([]); setPendingLoad("idle"); };
  const clearResult = () => { resultSeqRef.current++; setLastResult(null); };
  const reset = () => { setPart(null); setForm({}); clearPickList(); setMode("LOOKUP"); setScanError(null); };

  // Scan-first: a scan just resolves the part and shows its details; the user
  // then picks what to do with it. So every scan enters neutral LOOKUP.
  const handleCode = async (code, source) => {
    if (resolvingRef.current || busy) return;
    resolvingRef.current = true;
    const seq = ++reqSeqRef.current;
    setBusy(true);
    try {
      const res = await barcodeService.resolve(storeCode, code, {
        scanSource: source, scanMode: "LOOKUP",
      });
      // A newer scan started while this resolve was in flight — drop the stale
      // result instead of resurrecting the old part.
      if (reqSeqRef.current !== seq) return;
      setScanError(null);
      clearResult();
      setPart(res.data.data);
      setMode("LOOKUP");
      setForm({});
      clearPickList();
    } catch (err) {
      // The interceptor also toasts it; this keeps the answer on screen.
      if (reqSeqRef.current !== seq) return;
      clearResult();
      setPart(null);
      setForm({});
      clearPickList();
      setMode("LOOKUP");
      setScanError({ code, message: err?.response?.data?.message || "No part in this store for that code" });
    } finally {
      setBusy(false);
      resolvingRef.current = false;
    }
  };

  // Chosen after a part is on screen — opens that action's form and pulls any
  // data it needs (pending issues to confirm, issues still out for a return).
  const selectAction = async (m) => {
    if (busy) return;
    clearPickList();
    const seq = actionSeqRef.current;
    setMode(m);
    setForm(defaultForm(m));
    if (!part || (m !== "CONFIRM" && m !== "RETURN")) return;
    setPendingLoad("loading");
    try {
      const p = m === "CONFIRM"
        ? await spareStockService.partPendingConfirmations(part.part_id)
        : await spareStockService.returnableIssues(part.part_id);
      // Switched action or scanned another part meanwhile — this list is not
      // for what is on screen now.
      if (actionSeqRef.current !== seq) return;
      const rows = p.data.data || [];
      setPending(rows);
      setPendingLoad("ready");
      // One issue out on this part — pick it, so the fitter only fills the line.
      if (m === "CONFIRM" && rows.length === 1) setForm((f) => ({ ...f, ledger_id: String(rows[0].id) }));
    } catch {
      /* interceptor toasts */
      if (actionSeqRef.current === seq) setPendingLoad("error");
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

  // The awaiting queue changes with every issue / confirm / return. The server's
  // "stock" push refreshes it too; this makes this screen's own write show at once.
  const refreshAwaiting = () => qc.invalidateQueries({ queryKey: AWAITING_KEY });

  // `after(response)` runs once the write has landed and the form is cleared —
  // used to show the lifecycle of the issue just written.
  const submit = async (action, after) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await action();
      toast.success("Done — scan the next part");
      reset();
      refreshAwaiting();
      after?.(res);
    } catch {
      /* interceptor toasts */
    } finally {
      setBusy(false);
    }
  };

  // Stage 1 done — find the new ISSUE row so its lifecycle (now at "Awaiting
  // user confirmation") is shown as the server recorded it.
  const loadNewIssue = async (sent) => {
    const seq = ++resultSeqRef.current;
    setLastResult({ kind: "issued", sent, issue: null, state: "loading" });
    try {
      const r = await spareStockService.partPendingConfirmations(sent.part_id);
      if (resultSeqRef.current !== seq) return;
      const mine = findNewIssue(r.data.data || [], sent, user?.username);
      setLastResult({ kind: "issued", sent, issue: mine, state: mine ? "ready" : "missing" });
    } catch {
      if (resultSeqRef.current === seq) setLastResult({ kind: "issued", sent, issue: null, state: "error" });
    }
  };

  const doIssue = () => {
    if (!(Number(form.qty) > 0)) return toast.error("Enter a quantity");
    if (Number(form.qty) > Number(part.qty_on_hand ?? 0)) return toast.error(`Only ${fmt(part.qty_on_hand)} in stock`);
    if (!form.department) return toast.error("Choose a department");
    const sent = {
      part_id: part.part_id, part_no: part.part_no, part_name: part.part_name,
      qty: Number(form.qty), department: form.department,
      issued_to: (form.issued_to || "").trim() || null,
    };
    return submit(() => spareStockService.issue(part.part_id, {
      qty: Number(form.qty), department: form.department,
      issued_to: form.issued_to || undefined, returnable: !!form.returnable,
      remarks: form.remarks || undefined,
    }), () => loadNewIssue(sent));
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
    }), (res) => {
      // The confirm response is the updated ISSUE row — its finished lifecycle.
      const issue = res?.data?.data;
      resultSeqRef.current++;
      setLastResult(issue ? { kind: "confirmed", issue, state: "ready" } : null);
    });
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
      refreshAwaiting();
    } catch {
      /* interceptor toasts */
    } finally {
      setBusy(false);
    }
  };

  const clock = useMemo(() =>
    `${now.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`,
  [now]);
  const nowMs = now.getTime();
  const selectedIssue = mode === "CONFIRM" ? pending.find((p) => String(p.id) === String(form.ledger_id)) : null;
  const shown = lastResult && (lastResult.issue || lastResult.sent);

  return (
    <div className="space-y-4">
      {/* status bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl2 border border-slate-200 bg-white px-4 py-2 text-sm dark:border-navy-800 dark:bg-navy-900">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-slate-800 dark:text-white">Scan Part</span>
          {/* The store's own name, not its internal code ("MAINTENANCE") — a
              scan resolves any spare part across every section of this store. */}
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-navy-800 dark:text-slate-300">{activeStore?.name || "Spare Parts"}</span>
        </div>
        <div className="flex items-center gap-3 text-slate-500 dark:text-slate-400">
          <span className={`inline-flex items-center gap-1 ${online ? "text-emerald-600" : "text-rose-500"}`}>
            <span className={`h-2 w-2 rounded-full ${online ? "bg-emerald-500" : "bg-rose-500"}`} />{online ? "Online" : "Offline"}
          </span>
          <span>{user?.full_name || user?.username}</span>
          <span className="tabular-nums">{clock}</span>
        </div>
      </div>

      {/* One scan box for everything — scan a part, then choose what to do with
          it. No mode is picked first; the actions appear on the resolved part. */}
      <ScanPanel onCode={handleCode} busy={busy}
        hint="Scan the part’s barcode — issue, receive, return… appear next" />

      {scanError && !part && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-rose-300 bg-rose-50 p-4 dark:border-rose-500/40 dark:bg-rose-500/10">
          <XCircle size={28} className="shrink-0 text-rose-600 dark:text-rose-400" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-base font-bold text-rose-800 dark:text-rose-200">Not found — <span className="font-mono">{scanError.code}</span></p>
            <p className="text-sm text-rose-700 dark:text-rose-300">{scanError.message}</p>
            <p className="mt-1 text-xs text-rose-600/80 dark:text-rose-300/80">Nothing was selected. Check the label and scan again.</p>
          </div>
        </div>
      )}

      {/* The issue just written, until the next scan — Stage 1 lands at
          "Awaiting user confirmation", Stage 2 shows the finished lifecycle. */}
      {!part && lastResult && shown && (
        <div aria-live="polite" className="rounded-xl2 border border-slate-200 bg-white p-4 dark:border-navy-800 dark:bg-navy-900">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                <CircleCheck size={13} aria-hidden="true" />
                {lastResult.kind === "issued" ? "Issued"
                  : isNoneUsed(lastResult.issue) ? "Confirmation recorded — none used" : "Installation confirmed"}
              </p>
              <button type="button" onClick={() => openPart(shown.part_id)}
                className="block max-w-full truncate text-left text-base font-bold text-slate-900 hover:text-toyotared dark:text-white"
                title="Open the part">
                {shown.part_no}
                {shown.part_name && <span className="ml-2 text-sm font-normal text-slate-500 dark:text-slate-400">{shown.part_name}</span>}
              </button>
            </div>
            <button type="button" onClick={clearResult} aria-label="Dismiss"
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-navy-800 dark:hover:text-slate-200">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          {lastResult.state === "loading" && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-16 w-full" />)}
            </div>
          )}
          {lastResult.state === "ready" && (
            <>
              <IssueLifecycle issue={lastResult.issue} />
              {lastResult.kind === "issued" && (
                <p className="mt-3 text-xs text-slate-400">The fitter confirms the line and machine later: scan this part and choose Confirm.</p>
              )}
            </>
          )}
          {lastResult.state === "missing" && (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              The issue was recorded, but it is no longer in this part&apos;s awaiting list — it may already have been
              confirmed or returned. The part&apos;s ledger has the full history.
            </p>
          )}
          {lastResult.state === "error" && (
            <LoadFailed what="the new issue's lifecycle (the issue itself was recorded)" onRetry={() => loadNewIssue(lastResult.sent)} />
          )}
        </div>
      )}

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
                <span className="ml-1 text-xs text-slate-400">ERP sync {parseServerTime(part.data_status.erp_last_sync)?.toLocaleString("en-GB") ?? "—"}</span>
              )}
            </Field>
          </div>

          {part.data_status?.warning && (
            <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              <TriangleAlert size={13} className="inline-block align-[-2px] mr-1" aria-hidden="true" />{part.data_status.warning}
              {part.data_status?.write && !part.data_status.write.active && (
                <span className="ml-1">· ERP stock write is off — issue/receive stay in the app for now.</span>
              )}
            </div>
          )}

          {/* what to do with the scanned part — the actions live here, on the
              part, instead of being picked before the scan. */}
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {ACTIONS.map((m) => (
              <button key={m.key} type="button" onClick={() => selectAction(m.key)} disabled={busy}
                className={`rounded-lg py-3 text-sm font-semibold transition-colors ${
                  mode === m.key ? "bg-toyotared text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-navy-800 dark:text-slate-200 dark:hover:bg-navy-700"}`}>
                <m.icon size={16} className="inline-block align-[-3px] mr-1.5" aria-hidden="true" />{m.label}
              </button>
            ))}
          </div>

          {/* the chosen action's form */}
          <div className="mt-4 border-t border-slate-100 pt-4 dark:border-navy-800">
            {mode === "LOOKUP" && (
              <p className="text-sm text-slate-500 dark:text-slate-400">Details shown above — pick an action to issue, receive, return, relocate or confirm this part.</p>
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
                <Can mod="scan_part" edit>
                  <button type="button" onClick={doIssue}
                    disabled={busy || form.qty === "" || Number(form.qty) <= 0 || Number(form.qty) > Number(part.qty_on_hand ?? 0)}
                    className="btn-primary w-full py-3 text-lg">Confirm issue</button>
                </Can>
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
                <Can mod="scan_part" edit>
                  <button type="button" onClick={doReceive} disabled={busy} className="btn-primary w-full py-3 text-lg">Confirm receive</button>
                </Can>
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
                <Can mod="scan_part" edit>
                  <button type="button" onClick={doLocation} disabled={busy} className="btn-primary w-full py-3 text-lg">Update location</button>
                </Can>
              </div>
            )}

            {mode === "CONFIRM" && (
              <div className="space-y-3">
                {pendingLoad === "loading" || pendingLoad === "idle" ? (
                  <div className="space-y-2" aria-label="Loading issues awaiting confirmation">
                    {Array.from({ length: 2 }).map((_, i) => <div key={i} className="skeleton h-24 w-full" />)}
                  </div>
                ) : pendingLoad === "error" ? (
                  <LoadFailed what="this part's issues awaiting confirmation" onRetry={() => selectAction("CONFIRM")} />
                ) : pending.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">No pending issues for this part to confirm.</p>
                ) : (
                  <>
                    {/* Each issue with where it stands and how long it has been
                        out — the oldest unconfirmed ones are the ones to chase. */}
                    <fieldset>
                      <legend className="text-sm text-slate-600 dark:text-slate-300">Which issue *</legend>
                      <div className="mt-1 max-h-[55vh] space-y-2 overflow-y-auto pr-0.5">
                        {pending.map((p) => {
                          const on = String(form.ledger_id) === String(p.id);
                          // The whole card picks the issue; the radio (and its
                          // label line) is what a keyboard / screen reader uses.
                          return (
                            <div key={p.id} onClick={() => set("ledger_id", String(p.id))}
                              className={`cursor-pointer rounded-lg border p-3 transition-colors ${on
                                ? "border-toyotared bg-rose-50/40 ring-1 ring-toyotared dark:bg-rose-500/5"
                                : "border-slate-200 hover:border-slate-300 dark:border-navy-700 dark:hover:border-navy-600"}`}>
                              <label className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
                                <input type="radio" name="confirm-issue" value={p.id} checked={on}
                                  onChange={() => set("ledger_id", String(p.id))} className="h-4 w-4 accent-toyotared" />
                                <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                                  {num(p.qty)} to {p.department || "—"}{p.issued_to ? ` · ${p.issued_to}` : ""}
                                </span>
                                <span className="text-xs text-slate-400">{fmtStamp(utcStamp(p.issued_at))}</span>
                                <IssueAge at={p.issued_at} now={nowMs} />
                              </label>
                              <IssueLifecycle issue={p} className="mt-3" />
                            </div>
                          );
                        })}
                      </div>
                    </fieldset>
                    <p className="text-xs text-slate-400">
                      No stock moves here — it was deducted when the store issued it. This records where the part went.
                    </p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Line name (seat slider / recliner…)</span>
                        <input value={form.line_name} onChange={(e) => set("line_name", e.target.value)} className="input-field mt-1 w-full" /></label>
                      <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Line no.</span>
                        <input value={form.line_no} onChange={(e) => set("line_no", e.target.value)} className="input-field mt-1 w-full" /></label>
                      <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Machine no.</span>
                        <input value={form.machine} onChange={(e) => set("machine", e.target.value)} className="input-field mt-1 w-full" /></label>
                      <label className="block"><span className="text-sm text-slate-600 dark:text-slate-300">Actual used qty</span>
                        {/* Blank is taken as the whole issue used (confirm_installation). */}
                        <input type="number" min={0} max={selectedIssue ? Number(selectedIssue.qty) : undefined}
                          placeholder={selectedIssue ? `Blank = all ${num(selectedIssue.qty)} used` : undefined}
                          value={form.actual_qty} onChange={(e) => set("actual_qty", e.target.value)} className="input-field mt-1 w-full" /></label>
                    </div>
                    <Can mod="scan_part" edit>
                      <button type="button" onClick={doConfirm} disabled={busy} className="btn-primary w-full py-3 text-lg">Confirm installation</button>
                    </Can>
                  </>
                )}
              </div>
            )}

            {mode === "RETURN" && (
              <div className="space-y-3">
                {pendingLoad === "loading" || pendingLoad === "idle" ? (
                  <div className="skeleton h-12 w-full" aria-label="Loading issues still out" />
                ) : pendingLoad === "error" ? (
                  <LoadFailed what="the issues of this part still out" onRetry={() => selectAction("RETURN")} />
                ) : pending.length === 0 ? (
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
                            {parseServerTime(p.issued_at)?.toLocaleDateString("en-GB") ?? "—"} · {p.outstanding_qty} out · {p.department}{p.issued_to ? ` · ${p.issued_to}` : ""}{p.returnable ? " · tool/die" : ""}
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
                    <Can mod="scan_part" edit>
                      <button type="button" onClick={doReturn}
                        disabled={busy || !form.ledger_id || !form.reason || (returnIssue && Number(form.qty) > Number(returnIssue.outstanding_qty))}
                        className="btn-primary w-full py-3 text-lg">Take back on return slip</button>
                    </Can>
                  </>
                )}
              </div>
            )}

          </div>
        </div>
      )}

      <AwaitingConfirmation storeCode={storeCode} />
    </div>
  );
}
