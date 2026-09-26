import { createContext, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { departmentService } from "../../../services/departmentService.js";
import { num } from "../../../lib/format.js";

// The non-visual half of the Scan Part action forms (components/scan/forms):
// the VERIFY -> ACTION -> CONFIRM state machine, the open-document pick, the
// department master and the small value helpers every form shares. The visual
// half is FormKit.jsx. Kept apart so Vite's fast refresh keeps working on the
// component files.

// ---- small helpers ------------------------------------------------------------

/** Today on the plant's clock as YYYY-MM-DD. toISOString() would give the UTC
 *  date, which is still yesterday until 05:30 IST. */
export const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A quantity with its unit, "—" when unknown. */
export const fmtQty = (v, uom) => (v == null ? "—" : `${num(v)}${uom ? ` ${uom}` : ""}`);

/** Trimmed text, or undefined so a blank optional field is left out of the
 *  payload (JSON drops it) instead of being stored as "". */
export const clean = (s) => {
  const t = String(s ?? "").trim();
  return t === "" ? undefined : t;
};

export const qtyOf = (v) => Number(v ?? 0);

/** Lowest value a QtyStepper may step to: 1, unless less than 1 is all there
 *  is (e.g. 0.5 m of belt still out) — the stepper would otherwise clamp up. */
export const stepMin = (max) => (max > 0 && max < 1 ? max : 1);

/** Inline message for a quantity, or null when it is fine. `max` is the most
 *  the server will accept; `maxText` says why in the operator's words. */
export function qtyError(value, { max = Infinity, allowZero = false, maxText } = {}) {
  const v = Number(value);
  if (value === "" || value == null || !Number.isFinite(v)) return "Enter a quantity";
  if (allowZero ? v < 0 : v <= 0) return allowZero ? "Cannot be less than 0" : "Must be more than 0";
  if (v > max + 1e-9) return maxText || `No more than ${num(max)}`;
  return null;
}

/** A date input value that is later than today (a typo, not a real date). */
export const isFuture = (d) => Boolean(d) && d > todayLocal();

/** input-field with the red edge when its value is wrong. */
export const inputCls = (error, extra = "") =>
  `input-field ${error ? "border-rose-400 dark:border-rose-500/60" : ""} ${extra}`;

/** "Line Seat Slider / 03 · Machine Press-07 · Die Die-12", or null. */
export const placeText = (d) => {
  if (!d) return null;
  const line = [d.line_name, d.line_no].filter(Boolean).join(" / ");
  const bits = [line && `Line ${line}`, d.machine && `Machine ${d.machine}`, d.die_no && `Die ${d.die_no}`].filter(Boolean);
  return bits.length ? bits.join(" · ") : null;
};

// ---- supplier choice (SupplierPicker) ----------------------------------------------

/** An empty supplier choice, for a form's initial state. */
export const NO_SUPPLIER = { choice: "", supplier_id: null, ven_cd: null, ven_name: "", supplier_source: null };

/** The supplier fields of a payload (blank name = nothing chosen). A vendor
 *  code only ever comes from an ERP / master option, never from typing. */
export const supplierPayload = (s) => {
  const name = String(s?.ven_name || "").trim();
  if (!s?.choice || !name) return {};
  return {
    supplier_id: s.supplier_id ?? undefined,
    ven_cd: s.ven_cd ?? undefined,
    ven_name: name,
    supplier_source: s.supplier_source,
  };
};

/** How the chosen supplier reads on the confirm step. */
export const supplierLabel = (s) => {
  const name = String(s?.ven_name || "").trim();
  if (!s?.choice || !name) return null;
  if (s.supplier_source === "NAME_ONLY") return `${name} (name only — no vendor code)`;
  return s.ven_cd ? `${name} · ${s.ven_cd}` : name;
};

// ---- the VERIFY -> ACTION -> CONFIRM machine ------------------------------------

/** ActionForm's optional onStep("ACTION" | "CONFIRM"), handed to every form's
 *  shell without threading it through each form's props. */
export const FlowStepContext = createContext(null);

/**
 * Review / confirm / submit state for one form.
 *   flow.open(confirmProps)  show the CONFIRM step; confirmProps.submit() sends it
 *   flow.back()              back to the form, values kept
 *   flow.run(call, message, options)
 *       awaits call(); on success onDone(message(res), options(res)); on error
 *       returns to the form. The api interceptor has already toasted the
 *       server's message, so it is not repeated — the form only notes that
 *       nothing was saved.
 */
export function useActionFlow(onDone) {
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null); // null | "rejected" | "no-answer"
  const inFlight = useRef(false);

  const open = (props) => { setFailure(null); setReview(props); };
  const back = () => { if (!inFlight.current) setReview(null); };
  const run = async (call, message, options) => {
    if (inFlight.current) return;   // a double click must never write twice
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const res = await call();
      const msg = typeof message === "function" ? message(res) : message;
      const opts = typeof options === "function" ? options(res) : options;
      if (opts) onDone?.(msg, opts);
      else onDone?.(msg);
    } catch (err) {
      setReview(null);
      // With a response the server refused it (validation / state changed on
      // another terminal) and its transaction rolled back. Without one we do
      // not know whether it landed — say so rather than claim "not saved".
      setFailure(err?.response ? "rejected" : "no-answer");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { review, open, back, run, busy, failure };
}

// ---- open-document pick lists ----------------------------------------------------

/**
 * Which open document (receipt / issue / return / RGP) the action is for.
 * Preselects `target` (a Work Queue / drawer deep link) when it is open, else
 * the only one. The scan result refreshes while the form is open (SSE, another
 * terminal), so `gone` tells the form its pick has since been closed.
 */
export function useDocChoice(docs, target) {
  const [id, setId] = useState(() => {
    if (target != null && docs.some((d) => String(d.id) === String(target))) return String(target);
    return docs.length === 1 ? String(docs[0].id) : "";
  });
  useEffect(() => {
    if (!id && docs.length === 1) setId(String(docs[0].id));
  }, [id, docs]);
  const doc = docs.find((d) => String(d.id) === id) || null;
  return { doc, id, setId: (v) => setId(String(v)), gone: Boolean(id) && !doc };
}

// ---- masters ------------------------------------------------------------------

/** Active departments from the department master (global, not store-scoped). */
export function useDepartments() {
  return useQuery({
    queryKey: ["departments", "active"],
    queryFn: () => departmentService.list(true).then((r) => r.data.data || []),
    staleTime: 5 * 60_000,
  });
}
