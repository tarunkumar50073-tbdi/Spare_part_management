import React, { useId, useState } from "react";
import { MapPin } from "lucide-react";
import { spareStockService } from "../../../services/spareStockService.js";
import { Facts, Field, FormShell, Note } from "./FormKit.jsx";
import { clean, fmtQty, inputCls, useActionFlow } from "./flow.js";

// UPDATE_LOCATION: move the part's rack / shelf. The old and new location are
// kept in the location history. The printed label carries the location as
// text, so a label printed before the move now reads wrong — the operator is
// told to reprint it (the label is never changed silently).

export default function LocationForm({ scan, onDone, onCancel }) {
  const uid = useId();
  const { part } = scan;
  const flow = useActionFlow(onDone);
  const [location, setLocation] = useState("");
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const printed = Number(scan.label?.printed_count || 0) > 0;

  // Exact match only: a case-only change ("a1-03" -> "A1-03") is a real fix.
  const same = clean(location) && clean(location) === String(part.location || "").trim();
  const errors = {
    location: !clean(location) ? "Enter the new location" : same ? "That is already the location" : null,
    reason: !clean(reason) ? "Enter why it moved" : null,
  };
  const valid = !Object.values(errors).some(Boolean);
  const show = (k) => (tried ? errors[k] : null);

  const review = () => {
    setTried(true);
    if (!valid) return;
    const payload = { new_location: clean(location), reason: clean(reason) };
    flow.open({
      title: "Change location", icon: MapPin, part,
      changes: [{ label: "Location", from: part.location, to: payload.new_location }],
      fields: [
        { label: "Reason", value: payload.reason },
        { label: "Available stock", value: fmtQty(scan.buckets?.available ?? 0, part.uom) },
      ],
      note: printed
        ? "The printed QR label shows the location — reprint it after moving so the label matches the rack."
        : "No stock moves — only where the part is kept.",
      confirmLabel: "Confirm Location",
      submit: () => flow.run(
        () => spareStockService.updateLocation(part.id, payload),
        `Location changed to ${payload.new_location}${printed ? " — reprint the label so it shows the new location" : ""}`,
      ),
    });
  };

  return (
    <FormShell flow={flow} onCancel={onCancel} onReview={review} reviewLabel="Review move"
      verify={
        <Facts items={[
          { label: "Part No.", value: part.part_no, strong: true },
          { label: "Description", value: part.part_name },
          { label: "Current location", value: part.location, empty: "Not set", strong: true },
        ]} />
      }>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="New location" required htmlFor={`${uid}-loc`} error={show("location")}>
          <input id={`${uid}-loc`} value={location} maxLength={40} onChange={(e) => setLocation(e.target.value)}
            className={inputCls(show("location"), "text-base font-mono")} placeholder="e.g. A1-03" />
        </Field>
        <Field label="Reason" required htmlFor={`${uid}-rsn`} error={show("reason")}>
          <input id={`${uid}-rsn`} value={reason} maxLength={255} onChange={(e) => setReason(e.target.value)}
            className={inputCls(show("reason"))} placeholder="Rack re-arranged, wrong location in master…" />
        </Field>
      </div>
      {printed && <Note tone="warn">This part&apos;s label was printed with its location — reprint it after the move.</Note>}
    </FormShell>
  );
}
