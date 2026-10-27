import React, { useState } from "react";
import { Ban } from "lucide-react";
import { ACTIONS } from "../../lib/scanStatus.js";
import IssueForm from "./forms/IssueForm.jsx";
import ReturnForm from "./forms/ReturnForm.jsx";
import InspectForm from "./forms/InspectForm.jsx";
import RgpOutForm from "./forms/RgpOutForm.jsx";
import RgpReturnForm from "./forms/RgpReturnForm.jsx";
import RgpGrnForm from "./forms/RgpGrnForm.jsx";
import LocationForm from "./forms/LocationForm.jsx";
import { FlowStepContext } from "./forms/flow.js";

// The VERIFY -> ACTION -> CONFIRM step of the Scan Part workstation (spec 28):
// one form per action (components/scan/forms), each ending in the same
// ActionConfirm read-back. Renders the form body only — the workstation puts
// it in its own titled card with the close button.
//
// Contract: the Scan Part workstation renders
//   <ActionForm actionKey scan target source onDone onCancel />
//   actionKey  one of lib/scanStatus ACTIONS keys (ISSUE, RETURN, INSPECT, ...)
//   scan       the scan-result payload (GET /spare-flow/parts/:id/scan-result)
//   target     optional preselected document id (issue / return / rgp)
//   source     how the part was identified: SUPPLIER_BARCODE | ERP_SEARCH |
//              MANUAL_ENTRY | QR_SCAN (the issue's scan audit)
//   onDone(message, options?)  called after a successful write (the caller
//              refetches)
//   onCancel()       close without writing
//   onStep(step)     optional: "ACTION" while the form is filled in, "CONFIRM"
//                    while its read-back is up — for the workstation's
//                    SCAN -> IDENTIFY -> VERIFY -> ACTION -> CONFIRM indicator
//   onDirty(bool)    optional: whether the operator has entered anything yet
//                    (reported by the Issue form, which the workstation opens
//                    by itself — an untouched one needs no "discard?" question)
//   className        optional, extra classes for the wrapper
//
// PRINT_LABEL / REPRINT_LABEL (PrintBarcodeModal) and HISTORY (the timeline)
// are the workstation's own screens: for those keys this renders nothing.
// Receiving, the GRN and quality clearance are done in ERP and only read by
// the app, so there is no form for them.
// A form never toasts success itself — the message goes to onDone — and an
// error is toasted once by the api interceptor; the form stays open to fix it.

const FORMS = {
  ISSUE: IssueForm,
  RETURN: ReturnForm,
  INSPECT: InspectForm,
  RGP_OUT: RgpOutForm,
  RGP_RETURN: RgpReturnForm,
  RGP_GRN: RgpGrnForm,
  UPDATE_LOCATION: LocationForm,
};

export default function ActionForm({ actionKey, scan, target, source, onDone, onCancel, onStep, onDirty, className = "" }) {
  const part = scan?.part;
  // The backend decides what is allowed for the part's current state (spec 27);
  // a deep link can still ask for an action that is not — say why instead.
  // Judged when the form OPENS only: the scan result refreshes while a form is
  // up (this terminal's own write included), and a form must not vanish under
  // the operator mid-confirm — each form handles its document closing itself.
  const action = (scan?.actions || []).find((a) => a.key === actionKey);
  const openKey = `${actionKey}:${part?.id ?? ""}:${target ?? ""}`;
  const gateNow = { key: openKey, blocked: Boolean(action) && !action.enabled, reason: action?.reason || null };
  const [gate, setGate] = useState(gateNow);
  if (gate.key !== openKey) setGate(gateNow);
  const { blocked, reason } = gate.key === openKey ? gate : gateNow;

  const Form = FORMS[actionKey];
  if (!Form || !part) return null;
  const label = ACTIONS[actionKey]?.label || actionKey;

  return (
    <div className={className}>
      {blocked ? (
        <div className="space-y-3">
          <p className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600 dark:border-navy-700 dark:bg-navy-800/50 dark:text-slate-300">
            <Ban size={16} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
            <span>{label} is not available for this part now{reason ? ` — ${reason}` : ""}.</span>
          </p>
          <div className="flex justify-end">
            <button type="button" className="btn-secondary" onClick={onCancel}>Close</button>
          </div>
        </div>
      ) : (
        <FlowStepContext.Provider value={onStep || null}>
          {/* Keyed by part + target: a new scan or deep link starts a clean
              form, never one still holding the previous part's quantities. */}
          <Form key={openKey} scan={scan} target={target} source={source} onDone={onDone} onCancel={onCancel}
            onDirty={onDirty} />
        </FlowStepContext.Provider>
      )}
    </div>
  );
}
