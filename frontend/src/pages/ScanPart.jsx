import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CircleCheck, Keyboard, RotateCcw, ScanLine, Search, X } from "lucide-react";
import { useStores } from "../context/StoreContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { usePartDrawer } from "../context/PartDrawerContext.jsx";
import { useCan } from "../components/Can.jsx";
import { useConfirm } from "../components/ConfirmDialog.jsx";
import PrintBarcodeModal from "../components/PrintBarcodeModal.jsx";
import ActionForm from "../components/scan/ActionForm.jsx";
import StatusBar from "../components/scan/StatusBar.jsx";
import StepIndicator from "../components/scan/StepIndicator.jsx";
import IdentifyBar from "../components/scan/IdentifyBar.jsx";
import ScanFailurePanel from "../components/scan/ScanFailurePanel.jsx";
import IdentityCard from "../components/scan/IdentityCard.jsx";
import StatusCard from "../components/scan/StatusCard.jsx";
import TransactionInfo from "../components/scan/TransactionInfo.jsx";
import QuickActions, { actionLabel } from "../components/scan/QuickActions.jsx";
import PartVisual, { PartVisualPlaceholder } from "../components/scan/PartVisual.jsx";
import LocationList from "../components/scan/LocationList.jsx";
import WorkQueueLink from "../components/scan/WorkQueueLink.jsx";
import HistoryModal from "../components/scan/HistoryModal.jsx";
import { scanIcon } from "../components/scan/scanIcons.js";
import PartTimeline from "../components/spare/PartTimeline.jsx";
import useScanWorkstation from "../hooks/useScanWorkstation.js";
import { ACTIONS } from "../lib/scanStatus.js";

// Scan Part — the store operator's workstation (spec 4 / 10 / 22 / 26-28 / 30).
//
// One scan answers: what is this part, where is it, is it in stock, who has it,
// which line / machine / die, is it back, is it with a supplier — and offers only
// the actions valid for its state right now. The page follows the operator
// through SCAN -> IDENTIFY -> VERIFY -> ACTION -> CONFIRM:
//
//   LEFT   input bar (scan / search / manual) · identity · current status ·
//          open documents · quick actions (or the open action's form)
//   RIGHT  the QR label as printed · where the quantity is · timeline ·
//          the next step again · Work Queue counts
//
// The QR carries only the Part No.; everything shown is read from the server's
// scan result (GET /spare-flow/parts/:id/scan-result), and the server decides
// which actions are open. The forms themselves are components/scan/ActionForm.
//
// Deep links: /scan-part?part=<id>[&action=<ACTION KEY>[&target=<document id>]]
// opens that part (and that action's form with the document pre-selected) —
// the Work Queue and the part drawer send the operator here that way.

// Search and Manual Entry are typed, so the scan audit records them as such.
const TYPED = "MANUAL_ENTRY";
const PRINT_ACTIONS = new Set(["PRINT_LABEL", "REPRINT_LABEL"]);
const TIMELINE_PREVIEW = 6;

function DoneStrip({ message, onDismiss }) {
  return (
    <div role="status" className="flex items-center gap-3 rounded-xl2 border border-emerald-200 bg-emerald-50 px-4 py-3 animate-rise dark:border-emerald-500/30 dark:bg-emerald-500/10">
      <CircleCheck size={22} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-emerald-800 dark:text-emerald-200">{message}</p>
        <p className="text-xs text-emerald-700/80 dark:text-emerald-300/80">
          Recorded — the part below shows its status now. Scan the next part when ready.
        </p>
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss"
        className="shrink-0 rounded-md p-1 text-emerald-700/70 hover:bg-emerald-100 hover:text-emerald-800 dark:text-emerald-300/70 dark:hover:bg-emerald-500/10">
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function IdleCard() {
  const ways = [
    { icon: ScanLine, text: "Scan — the part’s QR label or the supplier’s barcode, with the gun or the camera" },
    { icon: Search, text: "Search Part No. — by number, description or rack location" },
    { icon: Keyboard, text: "Manual Entry — type a code when a label won’t scan" },
  ];
  return (
    <section className="card p-5" aria-label="Ready">
      <p className="text-sm font-semibold text-slate-800 dark:text-white">Ready for the next part</p>
      <ul className="mt-3 space-y-2">
        {ways.map((w) => (
          <li key={w.text} className="flex items-start gap-2.5 text-sm text-slate-500 dark:text-slate-400">
            <w.icon size={16} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />{w.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PartSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Identifying the part">
      <div className="skeleton h-36 w-full" />
      <div className="skeleton h-28 w-full" />
      <div className="skeleton h-44 w-full" />
    </div>
  );
}

function TimelinePreview({ rows = [], hasMore, onViewAll }) {
  const more = hasMore || rows.length > TIMELINE_PREVIEW;
  return (
    <section className="card p-4" aria-label="Transaction timeline">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="kpi-label">Transaction timeline</h2>
        <button type="button" onClick={onViewAll} className="text-xs font-semibold text-toyotared hover:underline">
          View full history
        </button>
      </div>
      <PartTimeline rows={rows.slice(0, TIMELINE_PREVIEW)} compact ariaLabel="Latest events"
        emptyText="No history recorded for this part yet." />
      {more && (
        <button type="button" onClick={onViewAll}
          className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-toyotared dark:text-slate-400">
          Earlier events in the full history<ChevronRight size={13} aria-hidden="true" />
        </button>
      )}
    </section>
  );
}

export default function ScanPart() {
  const { activeCode, activeStore } = useStores();
  const { user } = useAuth();
  const { openPart } = usePartDrawer();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const storeCode = activeCode || "MAINTENANCE";

  // Rights: recording a movement needs Scan Part edit; a label may be printed
  // by anyone who may edit stock or the part master (the /barcode/print rule);
  // mapping a supplier barcode is its own right.
  const canEdit = useCan("scan_part", "edit");
  const canEditStock = useCan("store_stock", "edit");
  const canEditMaster = useCan("part_master", "edit");
  const canPrint = canEdit || canEditStock || canEditMaster;
  const canMap = useCan("supplier_barcodes", "edit");

  const { ident, failure, resolving, resolve, openById, clear, clearFailure, scanQuery } = useScanWorkstation(storeCode);
  const [tab, setTab] = useState("SCAN");
  const [action, setAction] = useState(null);       // { key, target } — the open action form
  const [formStep, setFormStep] = useState("ACTION"); // the form's own ACTION / CONFIRM (read-back) stage
  const [print, setPrint] = useState(null);         // { source } — the label dialog
  const [historyOpen, setHistoryOpen] = useState(false);
  const [done, setDone] = useState(null);           // { message } — the action just recorded
  const [focusSignal, setFocusSignal] = useState(0); // hands the caret back to the gun
  const pendingRef = useRef(null);                  // a deep link's action, waiting for the part
  const formRef = useRef(null);

  const scan = ident ? scanQuery.data ?? null : null;
  const part = scan?.part ?? null;

  const allowed = useCallback(
    (key) => key === "HISTORY" || (PRINT_ACTIONS.has(key) ? canPrint : canEdit),
    [canEdit, canPrint]);
  const enabledKeys = useMemo(
    () => new Set((scan?.actions || []).filter((a) => a.enabled).map((a) => a.key)), [scan]);
  const canAct = useCallback((key) => enabledKeys.has(key) && allowed(key), [enabledKeys, allowed]);

  // A new part replaces whatever was open for the old one.
  useEffect(() => {
    setAction(null);
    setPrint(null);
    setHistoryOpen(false);
  }, [ident]);

  // An open form holds what the operator typed; a new scan must not throw it
  // away unasked (spec: "Discard the open <action>?").
  const okToLeave = useCallback(async () => {
    if (!action) return true;
    const label = ACTIONS[action.key]?.label || "action";
    const ok = await confirm({
      title: `Discard the open ${label}?`,
      message: `The ${label} for ${part?.part_no || "this part"} has not been saved. Discard it and go to the next part?`,
      confirmText: "Discard",
      cancelText: `Keep the ${label}`,
    });
    if (ok) setAction(null);
    return ok;
  }, [action, confirm, part]);

  const startNew = () => {
    setDone(null);
    pendingRef.current = null;
  };

  // The gun is the usual way in (spec 4), so every time the workstation hands
  // the operator back — a part identified, a form or dialog closed, a failure
  // dismissed — the input returns to the Scan tab with the caret in the gun
  // field. Left on Search / Manual, the gun box is not even mounted and the
  // next scan would type into the page and be lost without a word.
  const backToGun = useCallback(() => {
    setTab("SCAN");
    setFocusSignal((n) => n + 1);
  }, []);

  // ---- identify ----
  // Each resolves to false when the operator chose to keep an open form, so
  // the input keeps what was typed. Search and Manual Entry also resolve to
  // false when the code did not identify a part: the tab stays open with the
  // text as typed, for the operator to correct it.
  const onScan = async (code, scanSource) => {
    if (!(await okToLeave())) return false;
    startNew();
    resolve(code, { via: "SCAN", scanSource });
    return true;
  };
  const onPick = async (row) => {
    if (!(await okToLeave())) return false;
    startNew();
    const found = await resolve(row.part_no, { via: "SEARCH", scanSource: TYPED });
    if (found) backToGun();
    return found;
  };
  const onManual = async (code) => {
    if (!(await okToLeave())) return false;
    startNew();
    const found = await resolve(code, { via: "MANUAL", scanSource: TYPED });
    if (found) backToGun();
    return found;
  };
  const clearPart = async () => {
    if (!(await okToLeave())) return;
    startNew();
    clear();
    backToGun();
  };

  // Deep link — read once, then taken off the URL so a refresh or the next
  // scan doesn't reopen it. okToLeave is read through a ref: the effect runs
  // for a new link, not for every form change.
  const leaveRef = useRef(okToLeave);
  useEffect(() => { leaveRef.current = okToLeave; });
  useEffect(() => {
    const raw = searchParams.get("part");
    if (!raw) return;
    const id = Number(raw);
    const key = (searchParams.get("action") || "").toUpperCase() || null;
    const target = searchParams.get("target");
    setSearchParams({}, { replace: true });
    if (!Number.isInteger(id) || id <= 0) return;
    (async () => {
      if (!(await leaveRef.current())) return;
      setDone(null);
      pendingRef.current = key ? { key, partId: id, target: target && Number(target) > 0 ? Number(target) : null } : null;
      openById(id);
      backToGun();
    })();
  }, [searchParams, setSearchParams, openById, backToGun]);

  // ---- act ----
  const runAction = useCallback((key, target = null) => {
    setDone(null);
    if (key === "HISTORY") { setHistoryOpen(true); return; }
    if (PRINT_ACTIONS.has(key)) {
      // A reprint says so; a label for material in hand carries how the part
      // was identified (supplier barcode / search / manual / QR).
      setPrint({ source: key === "REPRINT_LABEL" ? "REPRINT" : ident?.source || "ERP_SEARCH" });
      return;
    }
    setFormStep("ACTION");
    setAction({ key, target });
  }, [ident]);

  // The deep link's action, once the part's scan result is in. A form opens
  // even when the server has the action closed — the form then says why (a
  // queue row can be a step behind another terminal); history and labels are
  // this page's own dialogs and follow the server's word directly.
  const refreshing = scanQuery.isFetching;
  useEffect(() => {
    const p = pendingRef.current;
    // Judged on the fresh read, not on a cached copy from an earlier visit.
    if (!p || !scan || refreshing || ident?.partId !== p.partId) return;
    pendingRef.current = null;
    const a = (scan.actions || []).find((x) => x.key === p.key);
    if (!a) return;
    const label = actionLabel(a);
    if (!allowed(a.key)) { toast.error(`You don't have the right to ${label.toLowerCase()}.`); return; }
    if (!a.enabled && (a.key === "HISTORY" || PRINT_ACTIONS.has(a.key))) {
      toast(`${label} is not open for this part right now${a.reason ? ` — ${a.reason}` : ""}.`);
      return;
    }
    runAction(a.key, p.target);
  }, [scan, refreshing, ident, allowed, runAction]);

  useEffect(() => {
    if (action) formRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [action]);

  const cancelAction = useCallback(() => {
    setAction(null);
    backToGun();
  }, [backToGun]);

  // ActionForm contract: onDone(message, { next }) after a successful write.
  // `next: "PRINT_LABEL"` (after a receive) offers the internal QR label for the
  // material just received, as identified.
  const onDone = useCallback((message, opts) => {
    const text = message || `${ACTIONS[action?.key]?.label || "Action"} recorded`;
    setAction(null);
    setDone({ message: text });
    toast.success(text);
    qc.invalidateQueries({ queryKey: ["stock"] });
    // The label dialog owns the keyboard until it closes (closePrint).
    if (opts?.next === "PRINT_LABEL") setPrint({ source: ident?.source || "ERP_SEARCH" });
    else backToGun();
  }, [action, ident, qc, backToGun]);

  // The dialog records the print and refreshes the "stock" cache itself.
  const onPrinted = useCallback(() => setDone({ message: "Label printed" }), []);

  const closePrint = useCallback(() => {
    setPrint(null);
    backToGun();
  }, [backToGun]);

  // Stable, so the print dialog's own state (copies, reason) survives a
  // re-render of this page or a background refresh of the scan result.
  const pId = part?.id;
  const pNo = part?.part_no;
  const pName = part?.part_name;
  const pLoc = part?.location;
  const labelPart = useMemo(
    () => (pId != null ? { id: pId, part_no: pNo, part_name: pName, location: pLoc } : null),
    [pId, pNo, pName, pLoc]);

  // ---- where the operator is ----
  const scanFailed = Boolean(ident) && scanQuery.isError && !scan;
  const loadingPart = Boolean(ident) && !scan && !scanFailed;
  const actionMeta = action ? ACTIONS[action.key] : null;
  let step = "SCAN";
  let hint = "Scan the part’s QR label or the supplier’s barcode — or search / type the Part No.";
  let complete = false;
  if (action && formStep === "CONFIRM") {
    step = "CONFIRM"; hint = `${actionMeta?.label || "Action"} — read it back, then confirm to record it.`;
  } else if (action) {
    step = "ACTION"; hint = `${actionMeta?.label || "Action"} — fill in the form and confirm.`;
  } else if (print) {
    step = "ACTION"; hint = "Label — check the preview and quantity, then confirm and print.";
  } else if (done && scan) {
    step = "CONFIRM"; complete = true; hint = "Recorded — scan the next part when ready.";
  } else if (scan) {
    step = "VERIFY"; hint = "Check the part in hand against the Part No. and location, then choose an action.";
  } else if (resolving || loadingPart) {
    step = "IDENTIFY"; hint = "Identifying the part…";
  } else if (failure) {
    step = "IDENTIFY";
    hint = failure.result === "UNKNOWN_BARCODE"
      ? "This code is not known yet — map it to its part, or search the Part No."
      : "The code did not identify a part.";
  } else if (scanFailed) {
    step = "IDENTIFY"; hint = "The part could not be loaded.";
  }

  const primary = scan?.actions?.find((a) => a.key === scan.primary_action && a.enabled && allowed(a.key)) || null;
  const PrimaryIcon = primary ? scanIcon(ACTIONS[primary.key]?.icon) : null;
  const ActionIcon = actionMeta ? scanIcon(actionMeta.icon) : null;

  return (
    <div className="space-y-4">
      <StatusBar storeName={activeStore?.name} operator={user?.full_name || user?.username} />
      {/* The step bar also carries the next step while the operator verifies
          the part (or has just recorded one step on it) — the one button that
          is on screen without scrolling, however long the part's story is. */}
      <StepIndicator current={step} complete={complete} hint={hint}
        action={primary && (step === "VERIFY" || complete) ? (
          <button type="button" onClick={() => runAction(primary.key)} className="btn-primary py-2">
            {PrimaryIcon && <PrimaryIcon size={16} aria-hidden="true" />}
            <span><span className="font-normal opacity-80">Next:</span> {actionLabel(primary)}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        ) : null} />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        {/* ---------------- LEFT: scan -> identify -> verify -> act ---------------- */}
        <div className="min-w-0 space-y-4">
          <IdentifyBar tab={tab} onTab={setTab} onScan={onScan} onPick={onPick} onManual={onManual}
            busy={resolving} storeCode={storeCode} focusSignal={focusSignal} compact={Boolean(scan)} />

          {/* Once a mapping is saved, the same code is resolved again (audited
              as a MAPPING read): it now identifies the part and the operator
              carries on from there (spec 6). A code that now identifies the
              part — after a retry or a mapping — hands back to the gun, as a
              cancel does; a code typed in Manual Entry that still fails stays
              in its box to be corrected. */}
          {failure && (
            <ScanFailurePanel
              failure={failure}
              canMap={canMap}
              storeCode={storeCode}
              onSearch={() => { clearFailure(); setTab("SEARCH"); }}
              onCancel={() => { clear(); backToGun(); }}
              onRetry={async () => {
                if (await resolve(failure.code, { via: failure.via, scanSource: failure.scanSource })) backToGun();
              }}
              onMapped={async () => {
                if (await resolve(failure.code, { via: failure.via, scanSource: failure.scanSource, scanMode: "MAPPING" })) backToGun();
              }}
            />
          )}

          {!failure && !ident && (resolving ? <PartSkeleton /> : <IdleCard />)}
          {!failure && loadingPart && <PartSkeleton />}
          {!failure && scanFailed && (
            <div role="alert" className="rounded-xl2 border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
              <p className="font-semibold">Couldn&apos;t load this part.</p>
              {scanQuery.error?.response?.data?.message && <p className="mt-0.5">{scanQuery.error.response.data.message}</p>}
              <div className="mt-2 flex gap-2">
                <button type="button" className="btn-secondary" onClick={() => scanQuery.refetch()} disabled={scanQuery.isFetching}>
                  <RotateCcw size={15} aria-hidden="true" />{scanQuery.isFetching ? "Retrying…" : "Retry"}
                </button>
                <button type="button" className="btn-secondary" onClick={clearPart}>Clear</button>
              </div>
            </div>
          )}

          {scan && (
            <>
              {done && <DoneStrip message={done.message} onDismiss={() => setDone(null)} />}
              <IdentityCard part={part} ident={ident} onOpenDetails={() => openPart(part.id)} onClear={clearPart} />
              <StatusCard scan={scan} dataStatus={ident?.dataStatus} />
              <TransactionInfo scan={scan} canAct={canAct} onAction={runAction} collapsed={Boolean(action)} />
              {action ? (
                // data-scan-nofocus: clicks inside the form keep their focus
                // (the scan box would otherwise pull the caret back).
                <section ref={formRef} data-scan-nofocus aria-label={`${actionMeta?.label || action.key} form`}
                  className="card scroll-mt-4 overflow-hidden p-0 ring-2 ring-toyotared/20">
                  <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-navy-800">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-toyotared/10 text-toyotared">
                        {ActionIcon && <ActionIcon size={16} aria-hidden="true" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-slate-800 dark:text-white">{actionMeta?.label || action.key}</span>
                        <span className="block truncate text-[11px] text-slate-400">{part.part_no}{part.part_name ? ` · ${part.part_name}` : ""}</span>
                      </span>
                    </span>
                    <button type="button" onClick={cancelAction} aria-label="Close the form"
                      className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-navy-800 dark:hover:text-slate-200">
                      <X size={16} aria-hidden="true" />
                    </button>
                  </header>
                  <div className="p-4">
                    <ActionForm actionKey={action.key} scan={scan} target={action.target} source={ident.source}
                      onDone={onDone} onCancel={cancelAction} onStep={setFormStep} />
                  </div>
                </section>
              ) : (
                <QuickActions actions={scan.actions} primaryKey={scan.primary_action} allowed={allowed} onAction={runAction} />
              )}
            </>
          )}
        </div>

        {/* ---------------- RIGHT: the part as it stands ---------------- */}
        <div className="min-w-0 space-y-4">
          {scan ? (
            <>
              <PartVisual part={part} label={scan.label}
                onReprint={canAct("REPRINT_LABEL") ? () => runAction("REPRINT_LABEL") : null} />
              <LocationList locations={scan.locations} uom={part.uom} />
              <TimelinePreview rows={scan.timeline?.rows} hasMore={scan.timeline?.has_more}
                onViewAll={() => runAction("HISTORY")} />
              {/* The important action again, at the end of the part's story. */}
              {primary && !action && (
                <button type="button" onClick={() => runAction(primary.key)}
                  className="btn-primary w-full justify-center py-3.5 text-base font-semibold">
                  {PrimaryIcon && <PrimaryIcon size={20} aria-hidden="true" />}
                  {actionLabel(primary)}
                </button>
              )}
            </>
          ) : (
            <PartVisualPlaceholder />
          )}
          <WorkQueueLink storeCode={storeCode} />
        </div>
      </div>

      {historyOpen && part && (
        <HistoryModal part={labelPart} onClose={() => setHistoryOpen(false)} />
      )}
      {/* Mounted only while shown, so every label starts from a fresh dialog. */}
      {print && labelPart && (
        <PrintBarcodeModal part={labelPart} source={print.source} onClose={closePrint} onPrinted={onPrinted} />
      )}
    </div>
  );
}
